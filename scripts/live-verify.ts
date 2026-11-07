import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createProviders, ProviderError, type RequestEvent, type ResponseEvent } from '../apps/api/providers.js';
import { redactForReport } from '../apps/api/providers/privacy.js';
import { normalizeCompilationWire } from '../apps/api/providers/schemas.js';
import { CompilationSchema, validateCompilation, type Bundle } from '../packages/core/index.js';
import { loadFixture } from './fixtures.js';

const FIXTURES = ['F1', 'F2', 'F3', 'F4a', 'F4b'] as const;
const MAX_CALLS = 14;
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
type Entry = {
  sequence: number; runId: string; fixtureId: string; operation: string; attempt: number;
  reservedAt: string; state: 'reserved' | 'success' | 'rejected' | 'unknown';
  finishedAt?: string; durationMs?: number; status?: number; requestId?: string;
};
type Ledger = { version: 1; maximum: 14; entries: Entry[] };
type FixtureReport = {
  fixtureId: string; runId: string; status: string; startedAt: string; finishedAt?: string;
  inputRevision: number; sourceHashes?: Array<Record<string, unknown>>;
  mode: 'live'; model?: string; providerRequests: number; durationMs?: number;
  error?: unknown; compilation?: unknown; audit?: unknown; metadata?: unknown;
  checks?: unknown; reviewer: { role: 'none'; sourceReview: 'not_reviewed'; criticalMeaningReview: 'not_performed'; audioListening: 'not_performed' };
};

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  catch (error) { await rm(temp, { force: true }); throw error; }
  finally { await handle.close(); }
  try {
    await rename(temp, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) { await rm(temp, { force: true }); throw error; }
}
async function optionalJson(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new ProviderError('INVALID_INPUT'); }
}
function ledgerValue(value: unknown): Ledger {
  if (!value) return { version: 1, maximum: 14, entries: [] };
  const candidate = value as Ledger;
  if (candidate.version !== 1 || candidate.maximum !== 14 || !Array.isArray(candidate.entries) || candidate.entries.length > MAX_CALLS
    || candidate.entries.some((entry, index) => entry.sequence !== index + 1 || !['reserved', 'success', 'rejected', 'unknown'].includes(entry.state)
      || !FIXTURES.includes(entry.fixtureId as typeof FIXTURES[number]) || !['compile', 'audit'].includes(entry.operation) || !Number.isSafeInteger(entry.attempt) || entry.attempt < 1 || entry.attempt > 2))
    throw new ProviderError('INVALID_INPUT');
  return candidate;
}
function outputOf(body: unknown): unknown {
  if (!body || typeof body !== 'object') return { unusableProviderResponse: true };
  const messages = (body as Record<string, unknown>).output;
  if (!Array.isArray(messages)) return { unusableProviderResponse: true };
  const texts = messages.flatMap(item => item && typeof item === 'object' && Array.isArray(item.content) ? item.content.filter((part: Record<string, unknown>) => part.type === 'output_text' && typeof part.text === 'string').map((part: Record<string, unknown>) => part.text) : []);
  if (texts.length !== 1) return { unusableProviderResponse: true };
  try { return JSON.parse(texts[0]); } catch { return { malformedStructuredOutput: true, text: texts[0] }; }
}
function safeError(error: unknown): Record<string, unknown> {
  return error instanceof ProviderError ? error.toJSON() : { code: 'LOCAL_VERIFICATION_ERROR', message: 'A local source, persistence, or configuration check failed. No secret or raw exception is printed.', unknownOutcome: false };
}
function sha(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }

/** No network or credential-file access occurs unless the explicit --run argument is supplied. */
export async function runLiveVerification(args = process.argv.slice(2)): Promise<void> {
  if (!args.includes('--run')) {
    process.stdout.write('Live verification is NOT running. After explicit synthetic-test authorisation, run npm run verify:live -- --run.\n');
    process.stdout.write('Requires LECTURE_ACCESS_OPENAI_KEY_FILE, sends synthetic fixture PNGs/cues only to api.openai.com, runs five compile+audit pairs, never exceeds 14 durable attempts, and makes no TTS/STT calls.\n');
    return;
  }
  if (args.some(arg => arg !== '--run')) throw new ProviderError('INVALID_INPUT');
  const root = join(APP_ROOT, 'verification', 'live');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const runId = randomUUID();
  let haveLock = false;
  const lock = join(root, '.verification-lock');
  let secret = '';
  let currentFixture = '';
  let currentDirectory = '';
  let currentReport: FixtureReport | undefined;
  const reports: FixtureReport[] = [];
  const budgetPath = join(root, 'budget.json');
  const persist = (path: string, value: unknown) => atomicJson(path, redactForReport(value, secret ? [secret] : []));
  try {
    try { await mkdir(lock, { mode: 0o700 }); haveLock = true; }
    catch { throw new ProviderError('INVALID_INPUT'); }
    await atomicJson(join(lock, 'owner.json'), { runId, pid: process.pid, at: new Date().toISOString(), note: 'A leftover lock after interruption requires deliberate local review; do not blindly rerun an unknown submitted call.' });
    if (Number(process.versions.node.split('.')[0]) !== 22) throw new ProviderError('INVALID_INPUT');
    const budget = ledgerValue(await optionalJson(budgetPath));
    // A reservation surviving a crash consumed budget and has an unknown submitted outcome.
    let recovered = false;
    for (const entry of budget.entries) if (entry.state === 'reserved') { entry.state = 'unknown'; recovered = true; }
    if (recovered) await persist(budgetPath, budget);
    const keyFile = process.env.LECTURE_ACCESS_OPENAI_KEY_FILE;
    if (!keyFile) throw new ProviderError('NOT_CONFIGURED', { provider: 'openai' });
    const fileInfo = await stat(keyFile);
    if (!fileInfo.isFile() || fileInfo.size < 1 || fileInfo.size > 4096) throw new ProviderError('INVALID_INPUT');
    // Only this explicitly authorised file is read. Never inspect generic inherited provider credentials.
    secret = (await readFile(keyFile, 'utf8')).trim();
    if (secret.length < 20 || secret.length > 512 || /\s/.test(secret)) throw new ProviderError('INVALID_INPUT');
    process.env.LECTURE_ACCESS_OPENAI_API_KEY = secret;
    const pending = new Map<string, number>();
    const onRequest = async (event: RequestEvent) => {
      if (event.provider !== 'openai' || !['compile', 'audit'].includes(event.operation)) throw new ProviderError('INVALID_INPUT');
      const id = `${currentFixture}:${event.operation}:${event.attempt}`;
      if (event.phase === 'before') {
        if (budget.entries.length >= MAX_CALLS) throw new ProviderError('BUDGET_EXHAUSTED', { provider: 'openai' });
        const sequence = budget.entries.length + 1;
        budget.entries.push({ sequence, runId, fixtureId: currentFixture, operation: event.operation, attempt: event.attempt, reservedAt: event.at, state: 'reserved' });
        await persist(budgetPath, budget); // fsync+rename before the actual HTTPS submission.
        pending.set(id, sequence);
        if (currentReport) { currentReport.providerRequests++; await persist(join(currentDirectory, 'report.json'), currentReport); }
        return;
      }
      const sequence = pending.get(id);
      if (!sequence) throw new ProviderError('INVALID_INPUT');
      const entry = budget.entries[sequence - 1];
      entry.state = event.outcome ?? 'unknown';
      entry.finishedAt = event.at; entry.durationMs = event.durationMs; entry.status = event.status; entry.requestId = event.requestId;
      await persist(budgetPath, budget);
    };
    const onResponse = async (event: ResponseEvent) => {
      const sequence = pending.get(`${currentFixture}:${event.operation}:${event.attempt}`);
      await persist(join(currentDirectory, `${String(sequence).padStart(2, '0')}-${event.operation}-response.json`), event);
      const output = outputOf(event.response);
      if (event.operation === 'compile') {
        const candidate = normalizeCompilationWire(output);
        await persist(join(currentDirectory, 'candidate-compilation.json'), candidate);
        if (currentReport) currentReport.compilation = candidate;
      } else {
        await persist(join(currentDirectory, 'semantic-audit.json'), output);
        if (currentReport) currentReport.audit = output;
      }
    };
    const providers = createProviders({ mode: 'live', openaiApiKey: secret, elevenLabsApiKey: '', onRequest, onResponse });
    for (const fixtureId of FIXTURES) {
      currentFixture = fixtureId;
      currentDirectory = join(root, fixtureId);
      const started = performance.now();
      currentReport = { fixtureId, runId, status: 'preparing', startedAt: new Date().toISOString(), inputRevision: 1, mode: 'live', model: providers.capabilities().model, providerRequests: 0,
        reviewer: { role: 'none', sourceReview: 'not_reviewed', criticalMeaningReview: 'not_performed', audioListening: 'not_performed' } };
      const existing = await optionalJson(join(currentDirectory, 'report.json')) as FixtureReport | undefined;
      const prior = budget.entries.filter(entry => entry.fixtureId === fixtureId);
      if (existing?.status === 'completed_needs_developer_source_review') {
        reports.push({ ...existing, status: 'reused_known_completed_no_new_call' });
        process.stdout.write(`${fixtureId}: reused known completed result; no new provider call. Human critical-meaning review is still required.\n`);
        continue;
      }
      if (prior.some(entry => entry.state === 'unknown' || entry.state === 'reserved')) {
        currentReport.status = 'blocked_unknown_previous_outcome';
        currentReport.error = { code: 'OUTCOME_UNKNOWN', message: 'A prior submitted request has unknown outcome. This script will not automatically repeat it; retry may incur another charge.' };
        reports.push(currentReport);
        await persist(join(currentDirectory, `blocked-${runId}.json`), currentReport);
        process.stdout.write(`${fixtureId}: blocked, prior unknown submission outcome; no repeat.\n`);
        continue;
      }
      if (prior.length) {
        currentReport.status = 'blocked_previous_attempt_requires_deliberate_review';
        currentReport.error = { code: 'PRIOR_ATTEMPT', message: 'A previous provider result exists. Review its saved sources/output. This script does not repeat known successful compile/audit calls to retry a later failure, and does not reset its durable budget.' };
        reports.push(currentReport);
        await persist(join(currentDirectory, `blocked-${runId}.json`), currentReport);
        process.stdout.write(`${fixtureId}: blocked, prior result requires deliberate review; no repeat.\n`);
        continue;
      }
      try {
        const bundle: Bundle = await loadFixture(fixtureId);
        if (!bundle.assets.length || bundle.assets.some(asset => asset.acquisition !== 'synthetic_demo')) throw new ProviderError('INVALID_INPUT');
        currentReport.sourceHashes = bundle.assets.map(asset => {
          const bytes = Buffer.from(asset.base64, 'base64');
          return { id: asset.id, mime: asset.mime, sha256: sha(bytes), bytes: bytes.byteLength };
        });
        await persist(join(currentDirectory, 'source-bundle.json'), bundle);
        await persist(join(currentDirectory, 'source-hashes.json'), currentReport.sourceHashes);
        await mkdir(join(currentDirectory, 'sources'), { recursive: true, mode: 0o700 });
        for (const [index, asset] of bundle.assets.entries()) {
          const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'text/vtt': 'vtt', 'application/pdf': 'pdf' } as Record<string, string>)[asset.mime] ?? 'bin';
          const file = await open(join(currentDirectory, 'sources', `${String(index + 1).padStart(2, '0')}.${extension}`), 'w', 0o600);
          try { await file.writeFile(Buffer.from(asset.base64, 'base64')); await file.sync(); } finally { await file.close(); }
        }
        currentReport.status = 'analysing';
        await persist(join(currentDirectory, 'report.json'), currentReport);
        const result = await providers.compile(bundle, 1);
        const parsed = CompilationSchema.safeParse(result.compilation);
        const errors = parsed.success ? validateCompilation(parsed.data, bundle, 1) : ['Compilation schema rejected'];
        currentReport.compilation = result.compilation; currentReport.audit = result.audit; currentReport.metadata = result.metadata;
        currentReport.checks = { deterministicErrors: errors, criticalMeaningItems: 'Not independently reviewed by this script. Source images and full narration are saved for developer item-level review.',
          modelAuditIsNotHumanValidation: true, targetUserEvaluation: 'not_performed', audioGeneration: 'not_requested', cost: 'unmeasured' };
        currentReport.status = errors.length ? 'blocked_deterministic_validation' : 'completed_needs_developer_source_review';
        await persist(join(currentDirectory, 'compilation.json'), result.compilation);
        await persist(join(currentDirectory, 'semantic-audit.json'), result.audit);
        await persist(join(currentDirectory, 'metadata.json'), result.metadata);
        process.stdout.write(`${fixtureId}: ${errors.length ? 'blocked by deterministic checks' : 'compiled and model-audited; NOT human source-reviewed'}; ${currentReport.providerRequests} actual request attempts.\n`);
      } catch (error) {
        currentReport.status = 'blocked'; currentReport.error = safeError(error);
        process.stdout.write(`${fixtureId}: blocked (${String((currentReport.error as Record<string, unknown>).code)}); ${currentReport.providerRequests} actual request attempts.\n`);
      } finally {
        currentReport.durationMs = Math.round(performance.now() - started); currentReport.finishedAt = new Date().toISOString();
        await persist(join(currentDirectory, 'report.json'), currentReport);
        reports.push(currentReport);
      }
    }
    const summary = { runId, at: new Date().toISOString(), fixtures: reports, maximumMultimodalAttempts: MAX_CALLS, totalDurableAttempts: budget.entries.length,
      thisRunAttempts: budget.entries.filter(entry => entry.runId === runId).length, unknownOutcomes: budget.entries.filter(entry => entry.state === 'unknown' || entry.state === 'reserved').length,
      repairCalls: 0, automaticRepairsEnabled: false, ttsCalls: 0, sttCalls: 0, developerSourceReview: 'not_performed', targetUserValidation: 'not_performed', cost: 'unmeasured',
      note: 'Schema checks and a model audit are fallible screening, not proof of semantic completeness or accessibility. Full scripts/sources need independent item-level review; no output audio was generated by this script.' };
    await persist(join(root, `run-${runId}.json`), summary);
    await persist(join(root, 'latest-summary.json'), summary);
    process.stdout.write(`Durable multimodal attempts: ${budget.entries.length}/${MAX_CALLS}; this run: ${summary.thisRunAttempts}. No automatic repairs, TTS, or STT calls.\n`);
    if (reports.some(report => report.status.startsWith('blocked'))) process.exitCode = 1;
  } catch (error) {
    const failure = { runId, at: new Date().toISOString(), status: 'blocked_before_or_during_verification', error: safeError(error), fixtures: FIXTURES.map(id => ({ id, status: 'blocked_or_not_started' })), providerCalls: 'See durable budget.json; reservations count even after interruption.' };
    await persist(join(root, `blocked-${runId}.json`), failure);
    process.stderr.write(`Live verification blocked (${String((failure.error as Record<string, unknown>).code)}). See the redacted verification/live report; no raw error or credential is printed.\n`);
    process.exitCode = 1;
  } finally {
    if (haveLock) await rm(lock, { recursive: true, force: true });
    if (secret && process.env.LECTURE_ACCESS_OPENAI_API_KEY === secret) delete process.env.LECTURE_ACCESS_OPENAI_API_KEY;
    secret = '';
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runLiveVerification();
}
