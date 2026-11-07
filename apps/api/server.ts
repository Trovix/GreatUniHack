import http, { type IncomingMessage, type ServerResponse, type RequestListener } from 'node:http';
import { timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import { readFile, open, chmod, lstat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { CompilationSchema, QuestionAnswerSchema, validateBundle, validateCompilation, validateAnswer, parseVtt, type Bundle, type Asset } from '../../packages/core/index.js';
import { inspectAssetBytes } from '../../packages/core/node-assets.js';
import { createProviders, type ProviderAdapters } from './providers.js';
import { normalizeBundle } from './input.js';
import { groundedAnswer } from './questions.js';
import { LectureStore, assertId, contentHash } from './store.js';
import { ApiError, event, type Lecture, type AudioChunk, type QueuedJob, type JobKind } from './types.js';

export interface AppOptions {
  dataDir: string;
  allowedOrigins: string[];
  token?: string;
  providers?: ProviderAdapters;
  /** Exact test hosts only; production uses the actual 127.0.0.1 listening port. */
  allowedHosts?: string[];
  loadFixture?: (id: string) => Promise<Bundle>;
  listFixtures?: () => { id: string; title: string }[] | Promise<{ id: string; title: string }[]>;
  autoStart?: boolean;
  maxJsonBytes?: number;
}
const Revision = z.number().int().nonnegative();
const IdempotentRequest = z.object({ expectedRevision: Revision, consent: z.literal(true), idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/) }).strict();
const PlaybackRequest = z.object({ segmentId: z.string().min(1).max(128), offset: z.number().finite().min(0).max(7200), rate: z.number().finite().min(0.75).max(2) }).strict();
const QuestionRequest = z.object({ expectedRevision: Revision, question: z.string().trim().min(1).max(2000), segmentId: z.string().min(1).max(128), offset: z.number().finite().min(0).max(7200), consent: z.literal(true) }).strict();
const now = () => new Date().toISOString();
function schema<T>(validator: z.ZodType<T>, value: unknown): T {
  const result = validator.safeParse(value);
  if (!result.success) throw new ApiError(400, 'INVALID_REQUEST', result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 1000));
  return result.data;
}
function isIncomplete(lecture: Lecture): boolean {
  return Boolean(lecture.compilation?.unresolvedEssentialIds.length || lecture.compilation?.segments.some(segment => segment.status !== 'supported'));
}
function checked(lecture: Lecture, bundle: Bundle): void {
  if (!lecture.compilation) throw new ApiError(409, 'COMPILE_FIRST', 'Prepare and validate the visual-independent explanation before generating speech.');
  const errors = validateCompilation(lecture.compilation, bundle, lecture.revision);
  if (errors.length) throw new ApiError(409, 'COMPILATION_GATE', `The explanation failed its source checks: ${errors.join('; ').slice(0, 1500)}`);
}
function safeFailure(error: unknown): { code: string; message: string; unknown: boolean } {
  if (error instanceof ApiError) return { code: error.code, message: error.message, unknown: false };
  const value = error as { code?: unknown; status?: unknown; unknownOutcome?: unknown } | undefined;
  const code = typeof value?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.code) ? value.code : 'PROVIDER_FAILED';
  const unknown = value?.unknownOutcome === true;
  const message = unknown ? 'Provider outcome unknown. An explicit retry may incur another charge; no automatic retry was made.'
    : value?.status === 401 || value?.status === 403 ? 'Provider authorisation failed. Check the explicitly configured service credentials.'
    : value?.status === 429 ? 'Provider rate limit or credit limit reached. Review the account before deliberately retrying.'
    : code === 'ABORTED' || code === 'CANCELLED' ? 'The request was cancelled locally; provider billing may already have occurred.'
    : 'The provider request failed or returned invalid output. Sources remain saved locally. Check provider configuration and try again deliberately.';
  return { code, message, unknown };
}
async function tokenFile(directory: string): Promise<string> {
  const filename = path.join(directory, 'pairing-token');
  try {
    const metadata = await lstat(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Pairing token must be a regular private file.');
    await chmod(filename, 0o600);
    const token = (await readFile(filename, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Pairing token file is invalid.');
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const token = randomBytes(32).toString('hex');
    try {
      const handle = await open(filename, 'wx', 0o600);
      try { await handle.writeFile(`${token}\n`); await handle.sync(); } finally { await handle.close(); }
      return token;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return tokenFile(directory); throw error; }
  }
}
async function body(req: IncomingMessage, maximum: number): Promise<unknown> {
  if (req.headers['content-encoding']) throw new ApiError(415, 'ENCODING_UNSUPPORTED', 'Compressed request bodies are not supported.');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new ApiError(415, 'JSON_REQUIRED', 'Send application/json with UTF-8 encoding.');
  const length = req.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) { req.resume(); throw new ApiError(413, 'BODY_TOO_LARGE', 'Request exceeds the bounded JSON byte limit.'); }
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => fail(new ApiError(408, 'BODY_TIMEOUT', 'Request body was not received within 20 seconds.')), 20_000);
    const cleanup = () => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted); };
    const fail = (error: unknown) => { cleanup(); req.resume(); reject(error); };
    const aborted = () => fail(new ApiError(400, 'ABORTED_BODY', 'Request was interrupted.'));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximum) { fail(new ApiError(413, 'BODY_TOO_LARGE', 'Request exceeds the bounded JSON byte limit.')); return; }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks, size)); };
    req.on('data', data); req.on('end', end); req.on('error', fail); req.on('aborted', aborted);
  });
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ApiError(400, 'INVALID_JSON', 'Request must contain valid UTF-8 JSON.'); }
}

export interface App {
  handler: RequestListener;
  store: LectureStore;
  token: string;
  close(): Promise<void>;
  waitForIdle(): Promise<void>;
  start(): void;
}
export async function createApp(options: AppOptions): Promise<App> {
  if (!options.allowedOrigins.length || options.allowedOrigins.some(origin => origin === '*' || !/^(?:chrome-extension:\/\/[a-p]{32}|http:\/\/127\.0\.0\.1:\d+)$/.test(origin))) throw new Error('Configure exact extension or loopback-test origins. Wildcards and remote origins are forbidden.');
  const store = await LectureStore.open(options.dataDir);
  const token = options.token ?? await tokenFile(options.dataDir);
  if (token.length < 24 || token.length > 256 || /\s/.test(token)) throw new Error('Pairing token must be a bounded cryptographically random token.');
  const providers = options.providers ?? createProviders();
  const origins = new Set(options.allowedOrigins);
  const aborters = new Map<string, AbortController>();
  const questionAborters = new Map<string, AbortController>();
  const abortLecture = (id: string) => { aborters.get(id)?.abort(); questionAborters.get(id)?.abort(); };
  const questionsRunning = new Set<string>();
  let closing = false;
  let draining: Promise<void> | undefined;
  let wakeRequested = false;
  const pendingQuestions = new Set<Promise<unknown>>();
  let providerActive = 0;
  const providerWaiters: (() => void)[] = [];
  async function providerCall<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (providerActive >= 2) await new Promise<void>(resolve => providerWaiters.push(resolve));
    else providerActive++;
    try { if (signal?.aborted) throw new ApiError(409, 'CANCELLED', 'Request cancelled before provider submission.'); return await operation(); }
    finally { const next = providerWaiters.shift(); if (next) next(); else providerActive--; }
  }
  const fixtureLoader = options.loadFixture ?? (async (id: string) => (await import('../../scripts/fixtures.js')).loadFixture(id));
  const fixtureList = options.listFixtures ?? (async () => (await import('../../scripts/fixtures.js')).listFixtures());

  async function validatedAudio(result: Awaited<ReturnType<ProviderAdapters['synthesise']>>, text: string, segmentId: string, revision: number, purpose: AudioChunk['purpose']): Promise<{ chunk: AudioChunk; bytes: Uint8Array }> {
    const aliases: Record<string, Asset['mime']> = { 'audio/wav': 'audio/wav', 'audio/x-wav': 'audio/wav', 'audio/mpeg': 'audio/mpeg', 'audio/mp3': 'audio/mpeg' };
    const mime = aliases[result.mime];
    if (!mime || !(result.bytes instanceof Uint8Array) || !result.bytes.length || result.bytes.length > 25 * 1024 * 1024) throw new ApiError(502, 'INVALID_AUDIO_OUTPUT', 'Provider returned unsupported or oversized audio. Nothing will be played.');
    let metadata;
    try { metadata = await inspectAssetBytes(result.bytes, mime); }
    catch { throw new ApiError(502, 'INVALID_AUDIO_OUTPUT', 'Provider audio failed independent signature and duration validation. Nothing will be played.'); }
    if (!metadata.durationMs || metadata.durationMs > 180_000) throw new ApiError(502, 'INVALID_AUDIO_OUTPUT', 'Provider returned an invalid or excessive audio duration.');
    return { bytes: result.bytes, chunk: { id: randomUUID(), segmentId, inputRevision: revision, durationMs: metadata.durationMs, mime, mode: result.mode, provider: result.provider, scriptHash: contentHash(text), blobHash: metadata.sha256, model: result.model, voiceId: result.voiceId, alignment: result.alignment, purpose, text } };
  }
  async function perform(job: QueuedJob): Promise<void> {
    const controller = new AbortController();
    aborters.set(job.lectureId, controller);
    try {
      const lecture = await store.get(job.lectureId);
      if (lecture.revision !== job.revision || lecture.generation !== job.generation || !lecture.bundle) return;
      const bundle = lecture.bundle;
      if (job.kind === 'compile') {
        await store.update(lecture.id, current => { current.status = 'analysing'; event(current, 'analysing', 'Analysing actual selected visual states and transcript evidence.'); }, { revision: job.revision, generation: job.generation });
        const result = await providerCall(() => providers.compile(bundle, job.revision, controller.signal), controller.signal);
        const compilation = schema(CompilationSchema, result.compilation);
        const errors = validateCompilation(compilation, bundle, job.revision);
        if (errors.length) throw new ApiError(502, 'COMPILATION_GATE', `Generated explanation failed source checks: ${errors.join('; ').slice(0, 1500)}`);
        await store.finishJob(job, current => {
          current.compilation = compilation;
          current.audit = result.audit;
          current.providerMetadata = result.metadata;
          current.chunks = [];
          current.playback = undefined;
          current.questions = [];
          current.status = isIncomplete(current) ? 'incomplete' : 'review_ready';
          current.warnings = compilation.sourceReview === 'not_reviewed' ? ['AI-generated explanation has not been source-reviewed by a person. Automated checks are not accessibility certification.'] : [];
          if (compilation.providerMode === 'mock') current.warnings.push('Offline mock compilation is not a verified multimodal transformation.');
          if (isIncomplete(current)) current.warnings.push('Essential information remains unresolved or conflicting. The adaptation must disclose its limitations audibly.');
          event(current, 'validating', 'Schema, source provenance, numeric/sign checks, and essential-dependency coverage passed.');
          event(current, current.status, 'Explanation prepared. Separate narration consent is required before speech generation.');
        });
      } else if (job.kind === 'synthesise') {
        checked(lecture, bundle);
        await store.update(lecture.id, current => { current.status = 'synthesising'; event(current, 'synthesising', 'Generating checked narration. No audio starts automatically.'); }, { revision: job.revision, generation: job.generation });
        const segments = lecture.compilation!.segments;
        for (let index = 0; index < segments.length; index++) {
          const current = await store.get(lecture.id, false);
          if (current.revision !== job.revision || current.generation !== job.generation) return;
          const segment = segments[index];
          const warning = index === 0 ? isIncomplete(lecture) ? 'AI-generated adaptation. Essential visual information is unresolved or conflicting. Listen for the specific limitations in the affected sections. ' : 'AI-generated adaptation. ' : '';
          const text = warning + segment.text;
          const hash = contentHash(text);
          const capability = providers.capabilities() as unknown as Record<string, unknown>;
          const cached = current.chunks.find(chunk => chunk.segmentId === segment.id && chunk.inputRevision === job.revision && chunk.scriptHash === hash && (!capability.voiceId || chunk.voiceId === capability.voiceId) && (!capability.model || chunk.model === capability.ttsModel || chunk.model === capability.model));
          if (cached) {
            await store.update(lecture.id, value => {
              const saved = value.chunks.find(chunk => chunk.id === cached.id);
              if (saved) saved.mode = 'cached';
              event(value, 'synthesising', 'Reused checked saved audio; no speech-provider request was made.');
            }, { revision: job.revision, generation: job.generation });
            continue;
          }
          const result = await providerCall(() => providers.synthesise(text, { revision: job.revision, segmentId: segment.id, previousText: segments[index - 1]?.text, nextText: segments[index + 1]?.text, signal: controller.signal }), controller.signal);
          const verified = await validatedAudio(result, text, segment.id, job.revision, 'narration');
          await store.update(lecture.id, async value => {
            verified.chunk.blobHash = await store.putBlob(verified.bytes);
            value.chunks = value.chunks.filter(chunk => chunk.segmentId !== segment.id);
            value.chunks.push(verified.chunk);
            event(value, 'synthesising', `Checked audio chunk ${index + 1} of ${segments.length} saved (${result.mode === 'mock' ? 'offline mock voice' : result.provider}).`);
          }, { revision: job.revision, generation: job.generation });
        }
        await store.finishJob(job, current => { current.status = isIncomplete(current) ? 'incomplete' : 'ready'; event(current, current.status, 'All current-revision narration chunks are ready. Playback begins only on user action.'); });
      } else {
        if (bundle.cues.length) throw new ApiError(409, 'CAPTIONS_ALREADY_SUPPLIED', 'Supplied captions are already available. Transcription is a separate optional path, not an automatic replacement.');
        const asset = bundle.assets.find(asset => asset.id === bundle.audioAssetId)!;
        await store.update(lecture.id, current => { current.status = 'analysing'; event(current, 'transcribing', 'Uploading the selected source audio for explicitly consented batch transcription.'); }, { revision: job.revision, generation: job.generation });
        const result = await providerCall(() => providers.transcribe(asset, controller.signal), controller.signal);
        const cues = parseVtt(result.vtt, asset.durationMs);
        const transcript: Asset = { id: `stt-${randomUUID()}`, name: 'transcription.vtt', mime: 'text/vtt', acquisition: asset.acquisition, base64: Buffer.from(result.vtt).toString('base64') };
        const next = await normalizeBundle({ ...bundle, assets: [...bundle.assets, transcript], transcriptAssetId: transcript.id, cues });
        await store.completeTranscription(job, next, { raw: result.raw, provider: result.provider, mode: result.mode, at: now() });
      }
    } catch (error) {
      const failure = safeFailure(error);
      await store.finishJob(job, lecture => { lecture.status = 'failed'; lecture.error = failure.message; lecture.errorCode = failure.code; lecture.unknownOutcome = failure.unknown; event(lecture, 'failed', failure.message); }, { unknown: failure.unknown }).catch(() => {});
    } finally { if (aborters.get(job.lectureId) === controller) aborters.delete(job.lectureId); }
  }
  function start(): void {
    if (closing) return;
    if (draining) { wakeRequested = true; return; }
    wakeRequested = false;
    draining = (async () => {
      while (!closing) {
        const job = await store.takeJob();
        if (!job) break;
        await perform(job);
      }
    })().finally(() => { draining = undefined; if (wakeRequested && !closing) start(); });
    // Do not leak rejected persistence errors into an unhandled background rejection.
    void draining.catch(() => {});
  }
  function auth(req: IncomingMessage): void {
    const origin = req.headers.origin;
    if (!origin || !origins.has(origin)) throw new ApiError(403, 'ORIGIN_MISMATCH', 'Use the paired extension origin configured for this service.');
    const authorization = req.headers.authorization ?? '';
    const expected = `Bearer ${token}`;
    if (Buffer.byteLength(authorization) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) throw new ApiError(401, 'PAIRING_REQUIRED', 'Local pairing is missing or expired. Pair this extension with the service token.');
  }
  function host(req: IncomingMessage): void {
    const duplicates = (name: string) => req.rawHeaders.filter((_value, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name).length !== 1;
    if (duplicates('host') || req.headers.origin && duplicates('origin') || req.headers.authorization && duplicates('authorization')) throw new ApiError(400, 'DUPLICATE_SECURITY_HEADER', 'Security headers must appear exactly once.');
    const allowed = options.allowedHosts ?? [`127.0.0.1:${req.socket.localPort}`];
    if (!req.headers.host || !allowed.includes(req.headers.host)) throw new ApiError(403, 'HOST_MISMATCH', 'This service accepts only its configured loopback Host.');
    if (req.socket.localAddress && !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.localAddress)) throw new ApiError(403, 'LOOPBACK_ONLY', 'The service is available only on IPv4 loopback.');
  }
  async function route(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
    host(req);
    const rawPath = req.url ?? '/';
    if (!rawPath.startsWith('/') || rawPath.startsWith('//') || /[?#%\\]/.test(rawPath)) throw new ApiError(400, 'INVALID_PATH', 'Only exact application paths and opaque identifiers are accepted.');
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS') {
      if (!origin || !origins.has(origin)) throw new ApiError(403, 'ORIGIN_MISMATCH', 'Origin is not paired with this service.');
      const requested = (req.headers['access-control-request-headers'] ?? '').toString().toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if (requested.some(header => !['authorization', 'content-type'].includes(header))) throw new ApiError(403, 'PREFLIGHT_HEADERS', 'Unsupported request headers.');
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.headers['access-control-request-method'] ?? '')) throw new ApiError(403, 'PREFLIGHT_METHOD', 'Unsupported application method.');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Max-Age', '300');
      res.statusCode = 204; res.end(); return;
    }
    if (rawPath === '/health' && req.method === 'GET') return { service: 'Lecture Access', version: '0.1.0' };
    auth(req);
    if (rawPath === '/capabilities' && req.method === 'GET') return { ...providers.capabilities(), limits: { maxAudioDurationMs: 180_000, maxVisualStates: 6, maxBundleBytes: 50 * 1024 * 1024, maxImagePixels: 8_000_000, maxPdfPages: 50, concurrentCompilations: 1 }, workflow: 'Selected captions and visual states → checked explanation → separately consented narration. Questions use conservative local evidence retrieval.' };
    if (rawPath === '/fixtures' && req.method === 'GET') return fixtureList();
    if (rawPath === '/lectures' && req.method === 'GET') return store.list();
    if (rawPath === '/lectures' && req.method === 'POST') return store.create(schema(z.object({ title: z.string().trim().min(1).max(500) }).strict(), await body(req, 8192)).title);
    if (rawPath === '/lectures/fixture' && req.method === 'POST') {
      const request = schema(z.object({ fixtureId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) }).strict(), await body(req, 8192));
      const known = await fixtureList();
      if (!known.some(fixture => fixture.id === request.fixtureId)) throw new ApiError(404, 'FIXTURE_NOT_FOUND', 'Unknown synthetic fixture.');
      const bundle = await normalizeBundle(await fixtureLoader(request.fixtureId));
      const lecture = await store.create(bundle.title);
      return store.replaceInput(lecture.id, 0, bundle, 'supplied_captions');
    }
    const match = /^\/lectures\/([A-Za-z0-9_-]{1,100})(?:\/(.*))?$/.exec(rawPath);
    if (!match) throw new ApiError(404, 'NOT_FOUND', 'Application endpoint not found.');
    const [, id, action] = match;
    assertId(id);
    if (!action && req.method === 'GET') return store.get(id);
    if (!action && req.method === 'DELETE') { abortLecture(id); return store.delete(id); }
    if (action === 'input' && req.method === 'PUT') {
      const request = schema(z.object({ expectedRevision: Revision, bundle: z.unknown() }).strict(), await body(req, options.maxJsonBytes ?? 72 * 1024 * 1024));
      // Fail stale edits before paying the cost of decoding large assets.
      const before = await store.get(id, false);
      if (before.revision !== request.expectedRevision) throw new ApiError(409, 'REVISION_CONFLICT', 'Inputs changed. Reload the current lecture.');
      const bundle = await normalizeBundle(request.bundle);
      const updated = await store.replaceInput(id, request.expectedRevision, bundle, bundle.cues.length ? 'supplied_captions' : undefined);
      abortLecture(id);
      return updated;
    }
    if (['compile', 'synthesise', 'transcribe'].includes(action ?? '') && req.method === 'POST') {
      const request = schema(IdempotentRequest, await body(req, 8192));
      const kind = action as JobKind;
      const capabilities = providers.capabilities() as unknown as Record<string, unknown>;
      const fingerprint = contentHash(JSON.stringify({ kind, revision: request.expectedRevision, consent: true, model: capabilities.model, voiceId: capabilities.voiceId, mode: capabilities.mode }));
      const source = await store.get(id);
      const response = await store.enqueue(id, request.expectedRevision, kind, request.idempotencyKey, fingerprint, lecture => {
        if (!lecture.bundle || !source.bundle) throw new ApiError(409, 'INPUT_REQUIRED', 'Import a source bundle first.');
        if (kind === 'compile') {
          if (!capabilities.multimodal && capabilities.mode !== 'mock') throw new ApiError(503, 'MULTIMODAL_UNAVAILABLE', 'Configure the multimodal adapter, or explicitly choose labelled offline mock mode.');
          const errors = validateBundle(source.bundle);
          if (errors.length) throw new ApiError(409, 'INPUT_NOT_READY', errors.join('; ').slice(0, 1600));
        } else if (kind === 'synthesise') {
          if (!capabilities.tts) throw new ApiError(503, 'TTS_UNAVAILABLE', 'Configure ElevenLabs, or explicitly choose labelled offline mock voice mode.');
          checked(lecture, source.bundle);
        } else {
          if (!capabilities.stt) throw new ApiError(503, 'STT_UNAVAILABLE', 'Batch transcription is not configured. Import supplied VTT captions instead.');
          if (lecture.bundle.cues.length) throw new ApiError(409, 'CAPTIONS_ALREADY_SUPPLIED', 'Supplied captions are already present; no transcription will be submitted.');
        }
      });
      start();
      res.statusCode = 202;
      return response;
    }
    if (action === 'cancel' && req.method === 'POST') { abortLecture(id); return store.cancel(id); }
    if (action === 'playback' && req.method === 'PUT') {
      const request = schema(PlaybackRequest, await body(req, 8192));
      return store.update(id, lecture => {
        if (!['ready', 'incomplete'].includes(lecture.status) || !lecture.compilation) throw new ApiError(409, 'PLAYBACK_UNAVAILABLE', 'Only a ready, current-revision explanation can be played.');
        const chunk = lecture.chunks.find(chunk => chunk.segmentId === request.segmentId && chunk.inputRevision === lecture.revision);
        if (!chunk || request.offset > chunk.durationMs / 1000 + 0.2) throw new ApiError(400, 'PLAYBACK_RANGE', 'Playback position is outside the selected current audio chunk.');
        lecture.playback = request;
      });
    }
    const assetMatch = /^(assets|audio)\/([A-Za-z0-9_.:-]{1,128})$/.exec(action ?? '');
    if (assetMatch && req.method === 'GET') {
      const lecture = await store.get(id, false);
      let hash: string | undefined;
      let mime: string | undefined;
      if (assetMatch[1] === 'assets') { const asset = lecture.bundle?.assets.find(asset => asset.id === assetMatch[2]); hash = asset?.sha256; mime = asset?.mime; }
      else {
        const chunk = lecture.chunks.find(chunk => chunk.id === assetMatch[2]) ?? lecture.questions.map(turn => turn.chunk).find(chunk => chunk?.id === assetMatch[2]);
        if (chunk?.inputRevision !== lecture.revision || ['stale', 'cancelled'].includes(lecture.status)) throw new ApiError(409, 'STALE_AUDIO', 'This audio is no longer current.');
        hash = chunk?.blobHash; mime = chunk?.mime;
      }
      if (!hash || !mime) throw new ApiError(404, 'ASSET_NOT_FOUND', 'Current source or audio chunk not found.');
      const bytes = await store.readBlob(hash);
      // Deletion or revision edits while reading must not leak a late current response.
      const after = await store.get(id, false);
      if (after.revision !== lecture.revision || after.generation !== lecture.generation) throw new ApiError(409, 'STALE_RESULT', 'The source changed during retrieval.');
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Length', bytes.length);
      res.setHeader('Content-Disposition', 'inline');
      res.end(bytes); return;
    }
    if (action === 'questions' && req.method === 'POST') {
      const request = schema(QuestionRequest, await body(req, 16 * 1024));
      if (questionsRunning.has(id)) throw new ApiError(409, 'QUESTION_BUSY', 'Wait for the current answer before asking another question.');
      questionsRunning.add(id);
      const questionController = new AbortController();
      questionAborters.set(id, questionController);
      const work = (async () => {
        const started = performance.now();
        const lecture = await store.get(id);
        if (lecture.revision !== request.expectedRevision) throw new ApiError(409, 'REVISION_CONFLICT', 'Inputs changed. Ask against the current explanation.');
        if (!lecture.bundle || !lecture.compilation || ['stale', 'cancelled', 'queued', 'analysing', 'synthesising'].includes(lecture.status)) throw new ApiError(409, 'QUESTION_UNAVAILABLE', 'Questions require a current checked explanation.');
        checked(lecture, lecture.bundle);
        const segment = lecture.compilation.segments.find(segment => segment.id === request.segmentId);
        if (!segment) throw new ApiError(400, 'UNKNOWN_SEGMENT', 'Choose a current explanation segment.');
        const currentChunk = lecture.chunks.find(chunk => chunk.segmentId === request.segmentId);
        if (currentChunk && request.offset > currentChunk.durationMs / 1000 + 0.2) throw new ApiError(400, 'PLAYBACK_RANGE', 'Saved answer resume position is outside the current chunk.');
        const answer = schema(QuestionAnswerSchema, groundedAnswer(request.question, request.segmentId, lecture.compilation, lecture.bundle));
        const errors = validateAnswer(answer, lecture.compilation, lecture.bundle);
        if (errors.length) throw new ApiError(409, 'ANSWER_GATE', 'The source cannot support a safe spoken answer. Review the marked source limitation.');
        // Keep Q&A abort separate from preparation; both are invalidated by revision guards.
        const capabilities = providers.capabilities() as unknown as Record<string, unknown>;
        let verified: Awaited<ReturnType<typeof validatedAudio>> | undefined;
        if (capabilities.tts) {
          const result = await providerCall(() => providers.synthesise(answer.text, { revision: lecture.revision, segmentId: `question-${randomUUID()}`, signal: questionController.signal }), questionController.signal);
          verified = await validatedAudio(result, answer.text, request.segmentId, lecture.revision, 'question');
        }
        const latencyMs = Math.round(performance.now() - started);
        await store.update(id, async current => {
          if (verified) verified.chunk.blobHash = await store.putBlob(verified.bytes);
          const turn = { id: randomUUID(), inputRevision: current.revision, question: request.question, answer, segmentId: request.segmentId, offset: request.offset, at: now(), latencyMs, chunk: verified?.chunk };
          current.questions.push(turn);
          // Hard-bound persisted history and generated answer-audio ownership.
          const removed = current.questions.splice(0, Math.max(0, current.questions.length - 12));
          current.playback = { segmentId: request.segmentId, offset: request.offset, rate: current.playback?.rate ?? 1 };
          event(current, 'question', `Grounded ${answer.status} answer prepared using current-revision local evidence. Resume position saved.`);
          // Removed chunks are collected after commit, never while still reachable.
          void removed;
        }, { revision: lecture.revision, generation: lecture.generation });
        return { answer, chunk: verified?.chunk, latencyMs };
      })();
      pendingQuestions.add(work);
      try { return await work; }
      finally { questionsRunning.delete(id); pendingQuestions.delete(work); questionAborters.delete(id); }
    }
    throw new ApiError(404, 'NOT_FOUND', 'Application endpoint not found.');
  }
  const handler: RequestListener = (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    void route(req, res).then(result => {
      if (res.writableEnded) return;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(result ?? {}));
    }).catch(error => {
      if (res.writableEnded || res.destroyed) return;
      const failure = error instanceof ApiError ? error : new ApiError(500, 'INTERNAL_ERROR', 'Local processing failed safely. Saved source data was not intentionally removed.');
      res.statusCode = failure.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: failure.message, code: failure.code }));
    });
  };
  if (options.autoStart !== false) start();
  return {
    handler, store, token, start,
    async waitForIdle() { while (draining || pendingQuestions.size) { if (draining) await draining; if (pendingQuestions.size) await Promise.allSettled([...pendingQuestions]); } },
    async close() { closing = true; for (const controller of [...aborters.values(), ...questionAborters.values()]) controller.abort(); if (draining) await draining; await Promise.allSettled([...pendingQuestions]); },
  };
}
export async function createServer(options: AppOptions): Promise<App & { server: http.Server }> {
  const app = await createApp(options);
  const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 10_000, keepAliveTimeout: 3000 }, app.handler);
  server.maxRequestsPerSocket = 100;
  return { ...app, server, async close() { await app.close(); if (server.listening) await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }); } };
}
