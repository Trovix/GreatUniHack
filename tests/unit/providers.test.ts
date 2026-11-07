import { beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { createProviders, ProviderError, type ProviderOptions, type RequestEvent } from '../../apps/api/providers.js';
import { ProviderHttp } from '../../apps/api/providers/http.js';
import { pcm16Wav, wavDurationMs } from '../../apps/api/providers/audio.js';
import { parseVtt, type Bundle, type Compilation } from '../../packages/core/index.js';
import { redactForReport } from '../../apps/api/providers/privacy.js';

let png: Buffer;
beforeAll(async () => { png = await sharp({ create: { width: 12, height: 8, channels: 3, background: 'white' } }).png().toBuffer(); });
function bundle(): Bundle {
  return { title: 'Arbitrary selected source', audioAssetId: 'A', cues: [{ id: 'C', startMs: 0, endMs: 1000, text: 'The rate is five units.' }],
    assets: [{ id: 'A', name: 'source.wav', mime: 'audio/wav', base64: Buffer.from(pcm16Wav(new Uint8Array(44100))).toString('base64'), acquisition: 'manual_import', durationMs: 1000 },
      { id: 'I', name: 'private-filename.png', mime: 'image/png', base64: png.toString('base64'), acquisition: 'manual_import', width: 12, height: 8 }],
    timeline: [{ id: 'T', stateId: 'V', assetId: 'I', startMs: 0, endMs: 1000, alignment: 'user_confirmed' }] };
}
function compilation(revision = 1): Compilation {
  return { inputRevision: revision, providerMode: 'live', sourceReview: 'not_reviewed',
    evidence: [{ id: 'ev_001', kind: 'speech', cueId: 'C', quote: 'The rate is five units.', sourceStartMs: 0, sourceEndMs: 1000 }], dependencies: [],
    claims: [{ id: 'cl_001', kind: 'lecturer_claim', meaning: 'The rate is five units.', evidenceIds: ['ev_001'], dependencyIds: [] }],
    segments: [{ id: 'seg_001', text: 'The rate is five units.', claimIds: ['cl_001'], dependencyIds: [], sourceRanges: [{ startMs: 0, endMs: 1000 }], stateIds: ['V'], status: 'supported' }], unresolvedEssentialIds: [] };
}
const audit = { inputRevision: 1, passed: true, sourceReview: 'not_reviewed', checkedCueIds: ['C'], checkedStateIds: ['V'], issues: [], summary: 'Test response only; no live semantic review occurred.' };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'x-request-id': 'safe-test-request' } });
const output = (value: unknown) => response({ status: 'completed', output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
function live(options: ProviderOptions = {}) { return createProviders({ mode: 'live', openaiApiKey: 'test-not-a-real-key', elevenLabsApiKey: 'test-not-a-real-key', voiceId: 'test-stock', voiceIsStock: true, sleep: async () => {}, ...options }); }

// No test calls a live provider. Every request is injected and inspected.
describe('actual-image compilation and selected-context privacy', () => {
  it('sends actual PNGs to compile and audit, but never unselected capture preview, navigation or filenames', async () => {
    const b = bundle();
    b.context = [];
    b.capture = { acquisition: 'browser_capture', courseTitle: 'PRIVATE-COURSE-SENTINEL', pageIdentity: 'https://moodle.invalid/week?token=DO-NOT-UPLOAD', capturedAt: new Date().toISOString(), text: 'UNSELECTED-CAPTURE-PRIVACY-SENTINEL' };
    const bodies: any[] = [];
    const fetcher: typeof fetch = vi.fn(async (_url, init) => {
      expect(init?.redirect).toBe('error');
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      return bodies.length === 1 ? output(compilation()) : output(audit);
    });
    const result = await live({ fetch: fetcher }).compile(b, 1);
    expect(result.metadata.requests).toBe(2); expect(fetcher).toHaveBeenCalledTimes(2);
    for (const body of bodies) {
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/UNSELECTED-CAPTURE|PRIVATE-COURSE|DO-NOT-UPLOAD|moodle\.invalid|private-filename/);
      expect(body.store).toBe(false); expect(body.tools).toBeUndefined();
      const content = body.input[0].content;
      const images = content.filter((part: any) => part.type === 'input_image');
      expect(images).toHaveLength(1);
      const pixels = Buffer.from(images[0].image_url.split(',')[1], 'base64');
      expect(pixels.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect((await sharp(pixels).metadata()).width).toBe(12);
      expect(JSON.parse(content[0].text).context).toEqual([]);
      expect(serialized).not.toMatch(/K1:|K12:|expected-answer|critical meaning manifest/i);
    }
  });
  it('uploads explicitly chosen context only, redacting source navigation URLs', async () => {
    const b = bundle(); b.context = [{ id: 'chosen', text: 'CHOSEN-CONTEXT-SENTINEL See https://private.invalid/path?auth=secret' }];
    const bodies: string[] = [];
    await live({ fetch: async (_url, init) => { bodies.push(String(init?.body)); return bodies.length === 1 ? output(compilation()) : output(audit); } }).compile(b, 1);
    expect(bodies.join('')).toContain('CHOSEN-CONTEXT-SENTINEL'); expect(bodies.join('')).not.toContain('private.invalid'); expect(bodies.join('')).not.toContain('auth=secret');
  });
  it('deduplicates an in-flight and successful compilation without another provider request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(output(compilation())).mockResolvedValueOnce(output(audit));
    const p = live({ fetch: fetcher }); const b = bundle();
    await Promise.all([p.compile(b, 1), p.compile(b, 1)]);
    expect((await p.compile(b, 1)).metadata.cacheHit).toBe(true); expect(fetcher).toHaveBeenCalledTimes(2);
    b.cues[0].text = 'The rate is six units.';
    await expect(p.compile(b, 2)).rejects.toBeInstanceOf(ProviderError); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it.each(['malformed', 'quote', 'id', 'missing', 'revision'] as const)('rejects unusable structured output before audit (%s)', async mutation => {
    const c = compilation() as any;
    if (mutation === 'quote') c.evidence[0].quote = 'Invented caption quote';
    if (mutation === 'id') c.evidence[0].cueId = 'nonexistent';
    if (mutation === 'missing') delete c.claims;
    if (mutation === 'revision') c.inputRevision = 2;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(mutation === 'malformed' ? response({ status: 'completed', output: [] }) : output(c));
    await expect(live({ fetch: fetcher }).compile(bundle(), 1)).rejects.toMatchObject({ code: mutation === 'malformed' ? 'INVALID_RESPONSE' : 'INVALID_COMPILATION' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects a semantic audit that omits a supplied image or reports an essential defect', async () => {
    for (const check of [{ ...audit, checkedStateIds: [] }, { ...audit, passed: false, issues: [{ id: 'issue', severity: 'critical', kind: 'omission', message: 'Missing essential detail', cueIds: ['C'], stateIds: ['V'], segmentIds: ['seg_001'], dependencyIds: [] }] }]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(output(compilation())).mockResolvedValueOnce(output(check));
      await expect(live({ fetch: fetcher }).compile(bundle(), 1)).rejects.toMatchObject({ code: check.passed ? 'INVALID_AUDIT' : 'AUDIT_REJECTED' });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });
  it('never uses inherited legacy OpenAI keys or silently substitutes a mock', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const p = createProviders({ mode: 'live', openaiApiKey: '', elevenLabsApiKey: '', fetch: fetcher });
    expect(p.capabilities()).toMatchObject({ mode: 'live', multimodal: false, tts: false, stt: false });
    await expect(p.compile(bundle(), 1)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' }); expect(fetcher).not.toHaveBeenCalled();
    const mock = createProviders({ mode: 'mock', fetch: fetcher, mockSpeech: async () => ({ bytes: pcm16Wav(new Uint8Array(44100)), durationMs: 1000 }) });
    const result = await mock.compile(bundle(), 1);
    expect(result.compilation.providerMode).toBe('mock'); expect(result.compilation.unresolvedEssentialIds.length).toBeGreaterThan(0);
    expect(result.compilation.segments[0].text).toMatch(/not analysed in offline mock/); expect(fetcher).not.toHaveBeenCalled();
    await expect(mock.transcribe(bundle().assets[0])).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });
});

describe('typed rejection, bounded retry and unknown-submission semantics', () => {
  const http = (fetcher: typeof fetch, extra: Partial<ConstructorParameters<typeof ProviderHttp>[0]> = {}) => new ProviderHttp({ fetch: fetcher, timeoutMs: 100, sleep: async () => {}, ...extra });
  const invoke = (p: ProviderHttp) => p.json('openai', 'compile', 'https://api.openai.com/v1/responses', { method: 'POST', body: '{}' });
  it.each([
    [401, { error: { code: 'invalid_api_key', message: 'SECRET-RAW-BODY' } }, 'AUTHENTICATION', 1],
    [402, { detail: { status: 'quota_exceeded' } }, 'CREDIT', 1],
    [429, { error: { code: 'insufficient_quota' } }, 'CREDIT', 1],
    [429, { error: { code: 'rate_limit_exceeded' } }, 'RATE_LIMIT', 2],
    [503, { error: { type: 'server_error' } }, 'SERVER_REJECTED', 2],
    [502, { error: { message: 'gateway did not establish rejection' } }, 'OUTCOME_UNKNOWN', 1],
    [504, { error: { type: 'server_error' } }, 'OUTCOME_UNKNOWN', 1],
  ])('classifies %s as %s with at most the permitted attempts', async (status, body, code, attempts) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(body, status as number));
    let caught: unknown; try { await invoke(http(fetcher)); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code, unknownOutcome: code === 'OUTCOME_UNKNOWN' }); expect(fetcher).toHaveBeenCalledTimes(attempts as number);
    expect(JSON.stringify(caught)).not.toContain('SECRET-RAW-BODY');
  });
  it('makes one retry after an explicit rate-limit rejection and stores one successful result', async () => {
    const events: RequestEvent[] = [];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ error: { code: 'rate_limit_exceeded' } }, 429)).mockResolvedValueOnce(response({ result: 'success' }));
    expect((await invoke(http(fetcher, { onRequest: event => { events.push(event); } }))).attempts).toBe(2);
    expect(events.filter(event => event.phase === 'after').map(event => event.outcome)).toEqual(['rejected', 'success']);
  });
  it('never retries dropped submission responses, malformed successful output, redirects or timeout', async () => {
    const dropped = vi.fn<typeof fetch>().mockRejectedValue(new Error('Network lost after server received paid request'));
    await expect(invoke(http(dropped))).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', unknownOutcome: true }); expect(dropped).toHaveBeenCalledTimes(1);
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response('bad JSON', { status: 200 }));
    await expect(invoke(http(malformed))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }); expect(malformed).toHaveBeenCalledTimes(1);
    const redirect = vi.fn<typeof fetch>().mockResolvedValue(response({}, 302));
    await expect(invoke(http(redirect))).rejects.toMatchObject({ code: 'SERVER_REJECTED' }); expect(redirect).toHaveBeenCalledTimes(1);
    const stalled = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }));
    await expect(invoke(http(stalled, { timeoutMs: 5 }))).rejects.toMatchObject({ code: 'TIMEOUT', unknownOutcome: true }); expect(stalled).toHaveBeenCalledTimes(1);
  });
  it('reserves the budget before submission and never sends after cancellation during the durable hook', async () => {
    const fetcher = vi.fn<typeof fetch>(); const controller = new AbortController();
    const p = http(fetcher, { onRequest: event => { if (event.phase === 'before') controller.abort(); } });
    await expect(p.json('openai', 'compile', 'https://api.openai.com/v1/responses', { method: 'POST' }, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED', unknownOutcome: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(invoke(http(fetcher, { onRequest: () => { throw new ProviderError('BUDGET_EXHAUSTED'); } }))).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' }); expect(fetcher).not.toHaveBeenCalled();
  });
  it('bounds streamed response bytes and refuses credential-bearing off-host destinations', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1000)));
    await expect(http(fetcher).json('openai', 'compile', 'https://api.openai.com/v1/responses', {}, undefined, 100)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(http(fetcher).json('openai', 'compile', 'https://attacker.invalid/', {})).rejects.toMatchObject({ code: 'INVALID_INPUT' }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('ElevenLabs actual wire endpoints and playable timing', () => {
  it('requests PCM timestamped speech and wraps returned samples as a valid WAV with actual duration', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://api.elevenlabs.io/v1/text-to-speech/test-stock/with-timestamps?output_format=pcm_22050');
      expect((init?.headers as Record<string, string>)['xi-api-key']).toBe('test-not-a-real-key');
      expect(JSON.parse(String(init?.body))).toMatchObject({ text: 'Five units.', apply_text_normalization: 'off', model_id: 'eleven_multilingual_v2' });
      return response({ audio_base64: Buffer.alloc(44100).toString('base64'), alignment: { characters: ['F'], character_start_times_seconds: [0], character_end_times_seconds: [1] } });
    });
    const p = live({ fetch: fetcher }); const result = await p.synthesise('Five units.', { revision: 1, segmentId: 'seg_001' });
    expect(result).toMatchObject({ mime: 'audio/wav', durationMs: 1000, provider: 'elevenlabs', mode: 'live' });
    expect(Buffer.from(result.bytes).subarray(0, 4).toString()).toBe('RIFF'); expect(wavDurationMs(result.bytes)).toBe(1000);
    await p.synthesise('Five units.', { revision: 1, segmentId: 'seg_001' }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid character timing and missing voice, without fake success', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ audio_base64: Buffer.alloc(44100).toString('base64'), alignment: { characters: ['x'], character_start_times_seconds: [0], character_end_times_seconds: [10] } }));
    await expect(live({ fetch: fetcher }).synthesise('Five.', { revision: 1, segmentId: 's' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const missing = live({ voiceIsStock: false, fetch: fetcher }); expect(missing.capabilities().tts).toBe(false);
    await expect(missing.synthesise('Five.', { revision: 1, segmentId: 's' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uploads file bytes for separately consented STT, derives word-timed VTT and never submits a private URL', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://api.elevenlabs.io/v1/speech-to-text');
      const form = init?.body as FormData; expect(form.get('model_id')).toBe('scribe_v2'); expect(form.get('timestamps_granularity')).toBe('word');
      expect(form.get('cloud_storage_url')).toBeNull(); expect(await (form.get('file') as File).arrayBuffer()).toHaveProperty('byteLength', 44144);
      return response({ text: 'Five units.', words: [{ type: 'word', text: 'Five', start: 0, end: 0.4 }, { type: 'spacing', text: ' ' }, { type: 'word', text: 'units.', start: 0.4, end: 1 }] });
    });
    const result = await live({ fetch: fetcher }).transcribe(bundle().assets[0]);
    expect(result).toMatchObject({ mode: 'live', provider: 'elevenlabs-scribe' }); expect(parseVtt(result.vtt, 1000)[0]).toMatchObject({ text: 'Five units.', startMs: 0, endMs: 1000 }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('redacts reports recursively, including exact keys and private navigation URLs', () => {
    expect(redactForReport({ Authorization: 'Bearer abc', nested: ['https://moodle.invalid/x?token=hidden', 'private-key'] }, ['private-key'])).toEqual({ Authorization: '[secret withheld]', nested: ['[source URL withheld]', '[secret withheld]'] });
  });
});
