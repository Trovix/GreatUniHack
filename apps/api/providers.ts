import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import sharp from 'sharp';
import { parseBuffer } from 'music-metadata';
import { z } from 'zod';
import {
  CompilationSchema, validateBundle, validateCompilation,
  type Asset, type Bundle, type Compilation,
} from '../../packages/core/index.js';
import { AUDIT_SYSTEM_PROMPT, COMPILE_SYSTEM_PROMPT, PROVIDER_DOCUMENTATION } from './prompts.js';
import { AuditSchema, AUDIT_WIRE_SCHEMA, COMPILATION_WIRE_SCHEMA, OUTPUT_IDS, normalizeCompilationWire, type SemanticAudit } from './providers/schemas.js';
import { ProviderError, ProviderHttp, type RequestEvent, type ResponseEvent } from './providers/http.js';
import { nativeMockSpeech, pcm16Wav, strictBase64, wavDurationMs } from './providers/audio.js';
import { redactSourceText } from './providers/privacy.js';

export { ProviderError } from './providers/http.js';
export type { RequestEvent, ResponseEvent } from './providers/http.js';
export type { SemanticAudit } from './providers/schemas.js';

export interface SpeechOptions { revision: number; segmentId: string; previousText?: string; nextText?: string; signal?: AbortSignal }
export interface SpeechResult {
  bytes: Uint8Array; mime: string; durationMs: number; alignment?: unknown;
  provider: string; mode: 'live' | 'mock'; model: string; voiceId?: string;
}
export interface ProviderCapabilities {
  multimodal: boolean; tts: boolean; stt: boolean; provider: string; model: string; voiceId?: string;
  mode: 'live' | 'mock'; speechProvider: string; ttsModel: string; sttModel: string;
  verification: 'configured_not_live_verified' | 'explicit_offline_mock';
  unavailable: string[];
  limits: { durationMs: number; visualStates: number; maxConcurrentRequests: number; repairPasses: number };
}
export interface ProviderAdapters {
  compile(bundle: Bundle, revision: number, signal?: AbortSignal): Promise<{ compilation: Compilation; audit: unknown; metadata: Record<string, unknown> }>;
  synthesise(text: string, options: SpeechOptions): Promise<SpeechResult>;
  transcribe(asset: Asset, signal?: AbortSignal): Promise<{ vtt: string; raw: unknown; provider: string; mode: 'live' | 'mock' }>;
  capabilities(): ProviderCapabilities;
}
export interface ProviderOptions {
  mode?: 'live' | 'mock';
  fetch?: typeof globalThis.fetch;
  openaiApiKey?: string;
  elevenLabsApiKey?: string;
  model?: string;
  voiceId?: string;
  /** Explicit declaration that the account-available configured voice is stock, not a clone. */
  voiceIsStock?: boolean;
  ttsModel?: string;
  sttModel?: string;
  timeoutMs?: number;
  onRequest?: (event: RequestEvent) => Promise<void> | void;
  onResponse?: (event: ResponseEvent) => Promise<void> | void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  mockSpeech?: (text: string, signal?: AbortSignal) => Promise<{ bytes: Uint8Array; durationMs: number }>;
}

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const unique = <T>(items: readonly T[]) => [...new Set(items)];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function inputError(): never { throw new ProviderError('INVALID_INPUT'); }
function abortCheck(signal?: AbortSignal) { if (signal?.aborted) throw new ProviderError('CANCELLED'); }

interface SourceInput { content: Array<Record<string, unknown>>; hashes: Array<Record<string, unknown>>; cueIds: string[]; stateIds: string[] }
async function sourceInput(bundle: Bundle, revision: number, signal?: AbortSignal): Promise<SourceInput> {
  abortCheck(signal);
  if (!Number.isSafeInteger(revision) || revision < 1 || validateBundle(bundle).length) inputError();
  const states = unique(bundle.timeline.map(entry => entry.stateId));
  if (!states.length || states.length > 6 || bundle.cues.length > 30) inputError();
  let selectedBytes = 0;
  const hashes: Array<Record<string, unknown>> = [];
  for (const asset of bundle.assets) {
    let bytes: Uint8Array;
    try { bytes = strictBase64(asset.base64, 50 * 1024 * 1024); } catch { inputError(); }
    selectedBytes += bytes.byteLength;
    if (selectedBytes > 50 * 1024 * 1024) inputError();
    hashes.push({ assetId: asset.id, sha256: hash(bytes), bytes: bytes.byteLength, mime: asset.mime });
  }
  const snapshot = {
    inputRevision: revision, providerMode: 'live', sourceReview: 'not_reviewed',
    title: redactSourceText(bundle.title),
    transcriptBasis: 'Selected timestamped captions; original audio is not sent to this visual model and caption/audio agreement is not independently verified.',
    cues: bundle.cues.map(cue => ({ ...cue, text: redactSourceText(cue.text) })),
    timeline: bundle.timeline.map(({ id, stateId, assetId, startMs, endMs, alignment, page, build }) => ({ id, stateId, assetId, startMs, endMs, alignment, page, build: build ? redactSourceText(build) : undefined })),
    context: (bundle.context ?? []).map(doc => ({ id: doc.id, text: redactSourceText(doc.text) })),
    // Capture is a local preview, not generation consent. Only explicitly selected
    // context above may leave the device; never upload capture.text or navigation metadata.
    allowedOutputIds: OUTPUT_IDS,
    provenanceRules: 'URL substrings are withheld and cannot be quoted. Quote other supplied caption/context substrings exactly. All source IDs must already occur above; all newly produced record IDs must come from their corresponding allowedOutputIds pool.',
  };
  const content: Array<Record<string, unknown>> = [{ type: 'input_text', text: JSON.stringify(snapshot) }];
  let totalPixels = 0;
  const rendered = new Map<string, { bytes: Uint8Array; width: number; height: number }>();
  for (const stateId of states) {
    abortCheck(signal);
    const occurrences = bundle.timeline.filter(entry => entry.stateId === stateId);
    const ids = unique(occurrences.map(entry => entry.assetId));
    if (ids.length !== 1) inputError();
    const asset = bundle.assets.find(item => item.id === ids[0]);
    if (!asset || !['image/png', 'image/jpeg'].includes(asset.mime)) inputError();
    let image = rendered.get(asset.id);
    if (!image) {
      let bytes: Uint8Array;
      try { bytes = strictBase64(asset.base64, 5 * 1024 * 1024); } catch { inputError(); }
      try {
        const decoder = sharp(bytes, { limitInputPixels: 8_000_000, animated: false, failOn: 'error' });
        const info = await decoder.metadata();
        if (!info.width || !info.height || info.width > 4096 || info.height > 4096 || info.width * info.height > 8_000_000 || (info.pages ?? 1) !== 1) inputError();
        if ((asset.mime === 'image/png' && info.format !== 'png') || (asset.mime === 'image/jpeg' && info.format !== 'jpeg')) inputError();
        // Re-encode the pixels to PNG, excluding metadata. Actual PNG bytes, never SVG/text descriptions.
        const png = await decoder.rotate().png().timeout({ seconds: 10 }).toBuffer({ resolveWithObject: true });
        image = { bytes: png.data, width: png.info.width, height: png.info.height };
        rendered.set(asset.id, image);
      } catch (error) { if (error instanceof ProviderError) throw error; inputError(); }
    }
    totalPixels += image.width * image.height;
    if (totalPixels > 24_000_000) inputError();
    content.push({ type: 'input_text', text: JSON.stringify({ sourceImage: { stateId, assetId: asset.id, intervals: occurrences.map(entry => ({ occurrenceId: entry.id, startMs: entry.startMs, endMs: entry.endMs })), width: image.width, height: image.height, pngSha256: hash(image.bytes) } }) });
    content.push({ type: 'input_image', image_url: `data:image/png;base64,${Buffer.from(image.bytes).toString('base64')}`, detail: 'high' });
  }
  return { content, hashes, cueIds: bundle.cues.map(cue => cue.id), stateIds: states };
}

function responseOutput(body: unknown): unknown {
  if (!object(body) || body.status !== 'completed' || body.error || body.incomplete_details || !Array.isArray(body.output)) throw new ProviderError('INVALID_RESPONSE', { provider: 'openai' });
  const texts: string[] = [];
  for (const item of body.output) {
    if (!object(item)) continue;
    if (item.type === 'refusal') throw new ProviderError('INVALID_RESPONSE', { provider: 'openai' });
    if (item.type !== 'message') continue;
    if (item.status && item.status !== 'completed') throw new ProviderError('INVALID_RESPONSE', { provider: 'openai' });
    if (!Array.isArray(item.content)) throw new ProviderError('INVALID_RESPONSE', { provider: 'openai' });
    for (const part of item.content) {
      if (!object(part) || part.type === 'refusal') throw new ProviderError('INVALID_RESPONSE', { provider: 'openai' });
      if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
    }
  }
  if (texts.length !== 1) throw new ProviderError('INVALID_RESPONSE', { provider: 'openai' });
  try { return JSON.parse(texts[0]); } catch { throw new ProviderError('INVALID_RESPONSE', { provider: 'openai' }); }
}

function allowedRecordIds(compilation: Compilation): boolean {
  for (const key of ['evidence', 'dependencies', 'claims', 'segments'] as const) {
    const allowed = new Set(OUTPUT_IDS[key]);
    if (compilation[key].some(item => !allowed.has(item.id))) return false;
  }
  return true;
}

function checkAudit(audit: SemanticAudit, compilation: Compilation, sources: SourceInput, revision: number) {
  const equalSet = (a: string[], b: string[]) => a.length === unique(a).length && a.length === b.length && a.every(id => b.includes(id));
  if (audit.inputRevision !== revision || !equalSet(audit.checkedCueIds, sources.cueIds) || !equalSet(audit.checkedStateIds, sources.stateIds)
    || audit.issues.length !== unique(audit.issues.map(issue => issue.id)).length
    || audit.passed !== !audit.issues.some(issue => issue.severity === 'critical')) throw new ProviderError('INVALID_AUDIT', { provider: 'openai' });
  for (const issue of audit.issues) {
    if (issue.cueIds.some(id => !sources.cueIds.includes(id)) || issue.stateIds.some(id => !sources.stateIds.includes(id))
      || issue.segmentIds.some(id => !compilation.segments.some(segment => segment.id === id))
      || issue.dependencyIds.some(id => !compilation.dependencies.some(dep => dep.id === id))) throw new ProviderError('INVALID_AUDIT', { provider: 'openai' });
  }
}

function mockCompilation(bundle: Bundle, revision: number): Compilation {
  if (!Number.isSafeInteger(revision) || revision < 1 || validateBundle(bundle).length) inputError();
  const evidence: Compilation['evidence'] = [];
  const dependencies: Compilation['dependencies'] = [];
  const claims: Compilation['claims'] = [];
  const segments: Compilation['segments'] = [];
  const visualIds = new Map<string, string>();
  for (const stateId of unique(bundle.timeline.map(entry => entry.stateId))) {
    const id = OUTPUT_IDS.evidence[evidence.length];
    visualIds.set(stateId, id);
    evidence.push({ id, kind: 'visual', stateId, observation: 'Visual image not analysed in explicit offline mock mode; no visual interpretation is asserted.' });
  }
  for (const [index, cue] of bundle.cues.entries()) {
    const speechId = OUTPUT_IDS.evidence[evidence.length];
    evidence.push({ id: speechId, kind: 'speech', cueId: cue.id, quote: cue.text, sourceStartMs: cue.startMs, sourceEndMs: cue.endMs });
    const stateIds = unique(bundle.timeline.filter(entry => entry.startMs < cue.endMs && entry.endMs > cue.startMs).map(entry => entry.stateId));
    const dependencyId = OUTPUT_IDS.dependencies[index];
    const reason = `The visual meaning for this passage cannot be determined because the image was not analysed in offline mock mode; any visually dependent detail remains unverified.`;
    dependencies.push({ id: dependencyId, cueIds: [cue.id], stateIds, kind: 'other', essential: true,
      question: 'What essential visual information is needed to understand this passage?', evidenceIds: [speechId, ...stateIds.map(id => visualIds.get(id)!)],
      status: 'unresolved', uncertaintyReason: reason });
    const speechClaim = OUTPUT_IDS.claims[index * 2];
    const warningClaim = OUTPUT_IDS.claims[index * 2 + 1];
    claims.push({ id: speechClaim, meaning: cue.text, kind: 'lecturer_claim', evidenceIds: [speechId], dependencyIds: [dependencyId] });
    claims.push({ id: warningClaim, meaning: reason, kind: 'uncertainty', evidenceIds: [speechId, ...stateIds.map(id => visualIds.get(id)!)], dependencyIds: [dependencyId] });
    segments.push({ id: OUTPUT_IDS.segments[index], text: `${cue.text} Limitation: ${reason}`, claimIds: [speechClaim, warningClaim], dependencyIds: [dependencyId], sourceRanges: [{ startMs: cue.startMs, endMs: cue.endMs }], stateIds, status: 'incomplete' });
  }
  const candidate = CompilationSchema.safeParse({ inputRevision: revision, providerMode: 'mock', evidence, dependencies, claims, segments, unresolvedEssentialIds: dependencies.map(dep => dep.id), sourceReview: 'not_reviewed' });
  if (!candidate.success || validateCompilation(candidate.data, bundle, revision).length) throw new ProviderError('INVALID_COMPILATION');
  return candidate.data;
}

const AlignmentSchema = z.object({
  characters: z.array(z.string()).max(100_000),
  character_start_times_seconds: z.array(z.number().finite().nonnegative()).max(100_000),
  character_end_times_seconds: z.array(z.number().finite().nonnegative()).max(100_000),
}).passthrough();
function checkedAlignment(value: unknown, durationMs: number): unknown {
  if (value == null) return undefined;
  const parsed = AlignmentSchema.safeParse(value);
  if (!parsed.success) throw new ProviderError('INVALID_RESPONSE', { provider: 'elevenlabs' });
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = parsed.data;
  if (characters.length !== starts.length || starts.length !== ends.length || starts.some((start, index) => start > ends[index] || (index > 0 && start < starts[index - 1]) || ends[index] * 1000 > durationMs + 250))
    throw new ProviderError('INVALID_RESPONSE', { provider: 'elevenlabs' });
  return parsed.data;
}

function timestamp(ms: number): string {
  const total = Math.round(ms);
  return `${String(Math.floor(total / 3_600_000)).padStart(2, '0')}:${String(Math.floor(total / 60_000) % 60).padStart(2, '0')}:${String(Math.floor(total / 1000) % 60).padStart(2, '0')}.${String(total % 1000).padStart(3, '0')}`;
}
function sttToVtt(body: unknown, durationMs: number): string {
  if (!object(body) || typeof body.text !== 'string' || !body.text.trim() || !Array.isArray(body.words) || body.words.length > 20_000) throw new ProviderError('INVALID_RESPONSE', { provider: 'elevenlabs' });
  const words: Array<{ text: string; start: number; end: number }> = [];
  for (const item of body.words) {
    if (!object(item) || typeof item.text !== 'string' || !['word', 'spacing', 'audio_event'].includes(String(item.type))) throw new ProviderError('INVALID_RESPONSE', { provider: 'elevenlabs' });
    if (item.type !== 'word') continue;
    if (typeof item.start !== 'number' || typeof item.end !== 'number' || !Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end <= item.start || item.end * 1000 > durationMs + 100 || (words.length && item.start < words[words.length - 1].end))
      throw new ProviderError('INVALID_RESPONSE', { provider: 'elevenlabs' });
    words.push({ text: item.text, start: item.start, end: item.end });
  }
  if (!words.length) throw new ProviderError('INVALID_RESPONSE', { provider: 'elevenlabs' });
  const groups: typeof words[] = [];
  let group: typeof words = [];
  for (const word of words) {
    if (group.length && (word.end - group[0].start > 8 || group.map(item => item.text).join(' ').length + word.text.length > 350)) { groups.push(group); group = []; }
    group.push(word);
  }
  if (group.length) groups.push(group);
  if (groups.length > 30) throw new ProviderError('INVALID_RESPONSE', { provider: 'elevenlabs' });
  const cues = groups.map((items, i) => {
    const start = Math.round(items[0].start * 1000);
    const end = Math.min(durationMs, Math.round(items[items.length - 1].end * 1000));
    if (end <= start) throw new ProviderError('INVALID_RESPONSE', { provider: 'elevenlabs' });
    const text = items.map(item => item.text).join(' ').replace(/\s+([,.;:!?])/g, '$1').replace(/-->?/g, '—').replace(/[\r\n\0]/g, ' ');
    return `STT${i + 1}\n${timestamp(start)} --> ${timestamp(end)}\n${text}`;
  });
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

export function createProviders(options: ProviderOptions = {}): ProviderAdapters {
  // Intentionally namespaced: the inherited, obsolete generic provider key is never read.
  const mode = options.mode ?? (process.env.LECTURE_ACCESS_MODE === 'mock' ? 'mock' : 'live');
  const openaiKey = options.openaiApiKey ?? process.env.LECTURE_ACCESS_OPENAI_API_KEY;
  const elevenKey = options.elevenLabsApiKey ?? process.env.LECTURE_ACCESS_ELEVENLABS_API_KEY ?? process.env.ELEVENLABS_API_KEY;
  const model = options.model ?? process.env.LECTURE_ACCESS_OPENAI_MODEL ?? 'gpt-4.1';
  const voiceId = options.voiceId ?? process.env.LECTURE_ACCESS_ELEVENLABS_VOICE_ID ?? process.env.ELEVENLABS_VOICE_ID;
  const voiceIsStock = options.voiceIsStock ?? process.env.LECTURE_ACCESS_ELEVENLABS_VOICE_KIND === 'stock';
  const ttsModel = options.ttsModel ?? process.env.LECTURE_ACCESS_ELEVENLABS_TTS_MODEL ?? 'eleven_multilingual_v2';
  const sttModel = options.sttModel ?? process.env.LECTURE_ACCESS_ELEVENLABS_STT_MODEL ?? 'scribe_v2';
  const safeVoice = voiceId && /^[A-Za-z0-9_-]{1,100}$/.test(voiceId) ? voiceId : undefined;
  const nativeAvailable = !!options.mockSpeech || (process.platform === 'darwin' && existsSync('/usr/bin/say') && existsSync('/usr/bin/afconvert'));
  const timeoutMs = options.timeoutMs ?? 90_000;
  if (!['live', 'mock'].includes(mode) || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 180_000 || !/^[\w.:-]{1,120}$/.test(model) || !/^[\w.-]{1,100}$/.test(ttsModel) || !/^[\w.-]{1,100}$/.test(sttModel)) inputError();
  const http = new ProviderHttp({ fetch: options.fetch ?? globalThis.fetch, timeoutMs, onRequest: options.onRequest, onResponse: options.onResponse, sleep: options.sleep });
  const compileCache = new Map<string, Awaited<ReturnType<ProviderAdapters['compile']>>>();
  const speechCache = new Map<string, SpeechResult>();
  const compileInFlight = new Map<string, Promise<Awaited<ReturnType<ProviderAdapters['compile']>>>>();
  const speechInFlight = new Map<string, Promise<SpeechResult>>();
  let activeRequests = 0;
  async function request(operation: 'compile' | 'audit', content: Array<Record<string, unknown>>, schema: Record<string, unknown>, signal?: AbortSignal) {
    if (!openaiKey) throw new ProviderError('NOT_CONFIGURED', { provider: 'openai' });
    return http.json('openai', operation, 'https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, store: false, instructions: operation === 'compile' ? COMPILE_SYSTEM_PROMPT : AUDIT_SYSTEM_PROMPT,
        input: [{ role: 'user', content }], max_output_tokens: operation === 'compile' ? 18000 : 6500,
        text: { format: { type: 'json_schema', name: operation === 'compile' ? 'lecture_compilation' : 'lecture_semantic_audit', strict: true, schema } },
      }),
    }, signal);
  }
  async function bounded<T>(fn: () => Promise<T>): Promise<T> {
    if (activeRequests >= 2) throw new ProviderError('SERVER_REJECTED');
    activeRequests++;
    try { return await fn(); } finally { activeRequests--; }
  }

  const adapters: ProviderAdapters = {
    capabilities() {
      const unavailable: string[] = [];
      if (mode === 'live' && !openaiKey) unavailable.push('Live multimodal requires LECTURE_ACCESS_OPENAI_API_KEY; no offline fallback is substituted.');
      if (mode === 'live' && !elevenKey) unavailable.push('ElevenLabs TTS/STT require a configured server-side ElevenLabs key.');
      if (mode === 'live' && (!safeVoice || !voiceIsStock)) unavailable.push('ElevenLabs TTS requires an account-available stock voice ID and LECTURE_ACCESS_ELEVENLABS_VOICE_KIND=stock.');
      if (mode === 'mock' && !nativeAvailable) unavailable.push('Native offline mock speech is unavailable on this platform.');
      return { mode, multimodal: mode === 'live' && !!openaiKey, tts: mode === 'mock' ? nativeAvailable : !!elevenKey && !!safeVoice && voiceIsStock,
        stt: mode === 'live' && !!elevenKey, provider: mode === 'live' ? 'openai' : 'explicit-offline-mock', model: mode === 'live' ? model : 'caption-preservation-no-visual-analysis',
        voiceId: mode === 'live' && voiceIsStock ? safeVoice : undefined, speechProvider: mode === 'live' ? 'elevenlabs' : 'native-say-mock',
        ttsModel: mode === 'live' ? ttsModel : 'native-say', sttModel, verification: mode === 'live' ? 'configured_not_live_verified' : 'explicit_offline_mock', unavailable,
        limits: { durationMs: 180000, visualStates: 6, maxConcurrentRequests: 2, repairPasses: 0 } };
    },
    async compile(bundle, revision, signal) {
      abortCheck(signal);
      const cacheKey = hash(JSON.stringify({ bundle, revision, mode, model }));
      const cached = compileCache.get(cacheKey);
      if (cached) return structuredClone({ ...cached, metadata: { ...cached.metadata, cacheHit: true } });
      const pending = compileInFlight.get(cacheKey);
      if (pending) return structuredClone(await pending);
      const job = bounded(async () => {
        const started = performance.now();
        if (mode === 'mock') {
          const compilation = mockCompilation(bundle, revision);
          return { compilation, audit: { mode: 'mock', passed: false, sourceReview: 'not_reviewed', summary: 'No multimodal transformation or semantic audit occurred. Captions are preserved with explicit visual limitations.' }, metadata: { provider: 'explicit-offline-mock', model: 'caption-preservation-no-visual-analysis', requests: 0, durationMs: Math.round(performance.now() - started), cacheHit: false } };
        }
        if (!openaiKey) throw new ProviderError('NOT_CONFIGURED', { provider: 'openai' });
        const sources = await sourceInput(bundle, revision, signal);
        const generated = await request('compile', sources.content, COMPILATION_WIRE_SCHEMA, signal);
        const parsed = CompilationSchema.safeParse(normalizeCompilationWire(responseOutput(generated.body)));
        if (!parsed.success || parsed.data.providerMode !== 'live' || parsed.data.sourceReview !== 'not_reviewed' || !allowedRecordIds(parsed.data) || validateCompilation(parsed.data, bundle, revision).length)
          throw new ProviderError('INVALID_COMPILATION', { provider: 'openai' });
        abortCheck(signal);
        const audited = await request('audit', [...sources.content, { type: 'input_text', text: JSON.stringify({ candidateCompilation: parsed.data, instruction: 'Challenge this candidate against the actual sources. Do not assume it is correct.' }) }], AUDIT_WIRE_SCHEMA, signal);
        const auditResult = AuditSchema.safeParse(responseOutput(audited.body));
        if (!auditResult.success) throw new ProviderError('INVALID_AUDIT', { provider: 'openai' });
        checkAudit(auditResult.data, parsed.data, sources, revision);
        if (!auditResult.data.passed) throw new ProviderError('AUDIT_REJECTED', { provider: 'openai' });
        abortCheck(signal);
        if (validateCompilation(parsed.data, bundle, revision).length) throw new ProviderError('INVALID_COMPILATION', { provider: 'openai' });
        return { compilation: parsed.data, audit: auditResult.data, metadata: { provider: 'openai', model, revision, sourceHashes: sources.hashes, requests: generated.attempts + audited.attempts,
          compileDurationMs: generated.durationMs, auditDurationMs: audited.durationMs, durationMs: Math.round(performance.now() - started),
          requestIds: [generated.requestId, audited.requestId].filter(Boolean), cacheHit: false, repairPasses: 0, sourceReview: 'not_reviewed', documentation: PROVIDER_DOCUMENTATION } };
      });
      compileInFlight.set(cacheKey, job);
      try {
        const result = await job;
        if (compileCache.size >= 8) compileCache.delete(compileCache.keys().next().value!);
        compileCache.set(cacheKey, structuredClone(result));
        return structuredClone(result);
      } finally { compileInFlight.delete(cacheKey); }
    },
    async synthesise(text, settings) {
      abortCheck(settings.signal);
      if (typeof text !== 'string' || !text.trim() || text.length > 12_000 || !Number.isSafeInteger(settings.revision) || settings.revision < 1 || !/^[\w-]{1,100}$/.test(settings.segmentId) || (settings.previousText?.length ?? 0) > 12_000 || (settings.nextText?.length ?? 0) > 12_000) inputError();
      const cacheKey = hash(JSON.stringify({ text, revision: settings.revision, segmentId: settings.segmentId, previousText: settings.previousText, nextText: settings.nextText, mode, ttsModel, voiceId: safeVoice }));
      const cached = speechCache.get(cacheKey);
      if (cached) return structuredClone(cached);
      const pending = speechInFlight.get(cacheKey);
      if (pending) return structuredClone(await pending);
      const job = bounded(async (): Promise<SpeechResult> => {
        if (mode === 'mock') {
          const result = await (options.mockSpeech ?? nativeMockSpeech)(text, settings.signal);
          return { ...result, mime: 'audio/wav', provider: 'native-say-mock', mode: 'mock', model: 'native-say', voiceId: 'system-stock-local' };
        }
        if (!elevenKey || !safeVoice || !voiceIsStock) throw new ProviderError('NOT_CONFIGURED', { provider: 'elevenlabs' });
        const response = await http.json('elevenlabs', 'tts', `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(safeVoice)}/with-timestamps?output_format=pcm_22050`, {
          method: 'POST', headers: { 'xi-api-key': elevenKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, model_id: ttsModel, previous_text: settings.previousText, next_text: settings.nextText, apply_text_normalization: 'off',
            voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 } }),
        }, settings.signal, 36 * 1024 * 1024);
        if (!object(response.body)) throw new ProviderError('INVALID_RESPONSE', { provider: 'elevenlabs' });
        const raw = strictBase64(response.body.audio_base64, 25 * 1024 * 1024);
        const bytes = pcm16Wav(raw);
        const durationMs = wavDurationMs(bytes);
        const alignment = checkedAlignment(response.body.alignment, durationMs);
        const normalizedAlignment = checkedAlignment(response.body.normalized_alignment, durationMs);
        if (alignment === undefined && normalizedAlignment === undefined) throw new ProviderError('INVALID_RESPONSE', { provider: 'elevenlabs' });
        abortCheck(settings.signal);
        return { bytes, mime: 'audio/wav', durationMs, alignment: { alignment, normalized_alignment: normalizedAlignment }, provider: 'elevenlabs', mode: 'live', model: ttsModel, voiceId: safeVoice };
      });
      speechInFlight.set(cacheKey, job);
      try {
        const result = await job;
        // A small, bounded in-process cache complements the service's durable script/revision cache.
        const cacheBytes = [...speechCache.values()].reduce((total, item) => total + item.bytes.byteLength, 0);
        if (cacheBytes + result.bytes.byteLength > 50 * 1024 * 1024 || speechCache.size >= 32) speechCache.clear();
        speechCache.set(cacheKey, structuredClone(result));
        return structuredClone(result);
      } finally { speechInFlight.delete(cacheKey); }
    },
    async transcribe(asset, signal) {
      abortCheck(signal);
      if (mode === 'mock') throw new ProviderError('NOT_CONFIGURED', { provider: 'elevenlabs' });
      if (!elevenKey) throw new ProviderError('NOT_CONFIGURED', { provider: 'elevenlabs' });
      if (!['audio/wav', 'audio/mpeg', 'audio/mp3'].includes(asset.mime)) inputError();
      let bytes: Uint8Array;
      try { bytes = strictBase64(asset.base64, 25 * 1024 * 1024); } catch { inputError(); }
      let durationMs: number;
      try {
        const info = await parseBuffer(bytes, { mimeType: asset.mime }, { duration: true });
        durationMs = Math.round((info.format.duration ?? 0) * 1000);
        if (durationMs < 100 || durationMs > 180_000) inputError();
      } catch (error) { if (error instanceof ProviderError) throw error; inputError(); }
      return bounded(async () => {
        const form = new FormData();
        form.set('model_id', sttModel); form.set('timestamps_granularity', 'word'); form.set('language_code', 'en');
        form.set('tag_audio_events', 'false'); form.set('diarize', 'false');
        form.set('file', new Blob([Buffer.from(bytes)], { type: asset.mime }), asset.mime === 'audio/wav' ? 'source.wav' : 'source.mp3');
        const response = await http.json('elevenlabs', 'stt', 'https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': elevenKey }, body: form }, signal, 4 * 1024 * 1024);
        const vtt = sttToVtt(response.body, durationMs);
        abortCheck(signal);
        return { vtt, raw: response.body, provider: 'elevenlabs-scribe', mode: 'live' as const };
      });
    },
  };
  return adapters;
}
