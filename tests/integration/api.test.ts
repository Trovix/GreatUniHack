import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import sharp from 'sharp';
import { createServer, type AppOptions } from '../../apps/api/server.js';
import type { ProviderAdapters, ProviderCapabilities } from '../../apps/api/providers.js';
import type { Bundle, Compilation } from '../../packages/core/index.js';
import { validateCompilation } from '../../packages/core/index.js';
import type { Lecture } from '../../apps/api/types.js';

const origin = `chrome-extension://${'a'.repeat(32)}`;
const token = 'test-only-pairing-token-'.repeat(3);
const running: Awaited<ReturnType<typeof createServer>>[] = [];
const dirs: string[] = [];
const wav = (durationMs = 1000) => {
  const samples = Math.round(durationMs * 8), bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
};
let png: Buffer;
beforeAll(async () => { png = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'white' } }).png().toBuffer(); });
afterEach(async () => { await Promise.all(running.splice(0).map(app => app.close())); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
function input(caption = true): Bundle {
  return { title: 'A bounded lecture', audioAssetId: 'source', assets: [
    { id: 'source', name: 'source.wav', mime: 'audio/wav', base64: wav().toString('base64'), acquisition: 'manual_import', durationMs: 500, sha256: '0'.repeat(64) },
    { id: 'slide', name: 'slide.png', mime: 'image/png', base64: png.toString('base64'), acquisition: 'manual_import', width: 1, height: 1 },
  ], cues: caption ? [{ id: 'c1', startMs: 0, endMs: 1000, text: 'The rate is five units.' }] : [], timeline: [{ id: 't1', stateId: 'v1', assetId: 'slide', startMs: 0, endMs: 1000, alignment: 'user_confirmed' }] };
}
function compilation(bundle: Bundle, revision: number, status: 'supported' | 'incomplete' | 'conflict' = 'supported'): Compilation {
  const incomplete = status !== 'supported';
  const reason = status === 'conflict' ? 'The recorded rate conflicts with the visual rate.' : 'The recording does not identify which option the lecturer selected.';
  const text = incomplete ? `${bundle.cues[0].text} ${reason}` : bundle.cues[0].text;
  return { inputRevision: revision, providerMode: 'mock', sourceReview: 'not_reviewed', evidence: [
    { id: 'e1', kind: 'speech', cueId: 'c1', quote: bundle.cues[0].text, sourceStartMs: 0, sourceEndMs: 1000 },
    ...(status === 'conflict' ? [{ id: 'e2', kind: 'visual' as const, stateId: 'v1', observation: 'The visual rate is six units.' }] : []),
  ], dependencies: incomplete ? [{ id: 'd1', cueIds: ['c1'], stateIds: ['v1'], kind: 'deixis', essential: true, question: 'Which option?', evidenceIds: status === 'conflict' ? ['e1', 'e2'] : ['e1'], status: status === 'conflict' ? 'conflict' : 'unresolved', uncertaintyReason: reason }] : [], claims: [
    { id: 'cl1', meaning: bundle.cues[0].text, kind: 'lecturer_claim', evidenceIds: ['e1'], dependencyIds: [] },
    ...(incomplete ? [{ id: 'cl2', meaning: reason, kind: 'uncertainty' as const, evidenceIds: status === 'conflict' ? ['e1', 'e2'] : ['e1'], dependencyIds: ['d1'] }] : []),
  ], segments: [{ id: 's1', text, claimIds: incomplete ? ['cl1', 'cl2'] : ['cl1'], dependencyIds: incomplete ? ['d1'] : [], sourceRanges: [{ startMs: 0, endMs: 1000 }], stateIds: ['v1'], status }], unresolvedEssentialIds: incomplete ? ['d1'] : [] };
}
function providers(overrides: Partial<ProviderAdapters> = {}): ProviderAdapters {
  const capabilities: ProviderCapabilities = { multimodal: true, tts: true, stt: true, provider: 'test-mock', model: 'test-model', ttsModel: 'test-voice', sttModel: 'test-stt', speechProvider: 'test-mock', mode: 'mock', verification: 'explicit_offline_mock', unavailable: [], limits: { durationMs: 180000, visualStates: 6, maxConcurrentRequests: 2, repairPasses: 0 } };
  return { capabilities: () => capabilities, compile: vi.fn(async (bundle, revision) => ({ compilation: compilation(bundle, revision), audit: { mode: 'mock' }, metadata: {} })), synthesise: vi.fn(async () => ({ bytes: wav(), mime: 'audio/wav', durationMs: 99999, provider: 'test-mock', mode: 'mock' as const, model: 'test-voice' })), transcribe: vi.fn(async () => ({ vtt: 'WEBVTT\n\nc1\n00:00:00.000 --> 00:00:01.000\nThe rate is five units.\n', raw: { mode: 'mock' }, provider: 'test-stt', mode: 'mock' as const })), ...overrides };
}
async function setup(adapter = providers(), options: Partial<AppOptions> = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'lecture-api-')); dirs.push(dataDir);
  const app = await createServer({ dataDir, allowedOrigins: [origin], token, providers: adapter, ...options });
  running.push(app);
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address() as import('node:net').AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  async function request(route: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(url + route, { method, headers: { Origin: origin, Authorization: `Bearer ${token}`, ...(value !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: value === undefined ? undefined : JSON.stringify(value) });
    const result = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.arrayBuffer();
    return { response, result: result as any };
  }
  async function create(bundle = input()) {
    const initial = await request('/lectures', 'POST', { title: bundle.title });
    const stored = await request(`/lectures/${initial.result.id}/input`, 'PUT', { expectedRevision: 0, bundle });
    expect(stored.response.status).toBe(200);
    return (await app.store.get(initial.result.id)) as Lecture;
  }
  async function prepare(lecture: Lecture, key = 'compile') {
    const queued = await request(`/lectures/${lecture.id}/compile`, 'POST', { expectedRevision: lecture.revision, consent: true, idempotencyKey: key });
    expect(queued.response.status, JSON.stringify(queued.result)).toBe(202);
    await app.waitForIdle();
    return app.store.get(lecture.id);
  }
  return { app, request, create, prepare, adapter, dataDir, url };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(predicate: () => boolean | Promise<boolean>) { for (let index = 0; index < 200; index++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Condition not reached'); }

describe('loopback pairing and input boundaries', () => {
  it('requires the exact Origin and bearer pair, rejects Host rebinding, and reveals only minimal unauthenticated health', async () => {
    const { request, url } = await setup();
    expect((await request('/lectures', 'GET', undefined, { Origin: 'https://evil.example' })).response.status).toBe(403);
    expect((await request('/lectures', 'GET', undefined, { Authorization: 'Bearer wrong' })).response.status).toBe(401);
    expect((await fetch(`${url}/lectures`)).status).toBe(403);
    const health = await fetch(`${url}/health`);
    expect(await health.json()).toEqual({ service: 'Lecture Access', version: '0.1.0' });
    const result = await new Promise<number>(resolve => { const req = http.get(url + '/health', { headers: { Host: 'attacker.invalid' } }, res => { res.resume(); resolve(res.statusCode!); }); req.on('error', () => resolve(0)); });
    expect(result).toBe(403);
    const preflight = await fetch(`${url}/lectures`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    expect((await fetch(`${url}/lectures`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } })).status).toBe(403);
  });

  it('generates a restrictive pairing token file without exposing it through health or capabilities', async () => {
    const { app, dataDir, request } = await setup(providers(), { token: undefined });
    expect(app.token).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(path.join(dataDir, 'pairing-token'))).mode & 0o777).toBe(0o600);
    const response = await request('/capabilities', 'GET', undefined, { Authorization: `Bearer ${app.token}` });
    expect(JSON.stringify(response.result)).not.toContain(app.token);
  });

  it('computes actual hash, image dimensions and duration rather than trusting metadata', async () => {
    const { create } = await setup(); const lecture = await create();
    expect(lecture.bundle!.assets[0].durationMs).toBe(1000);
    expect(lecture.bundle!.assets[0].sha256).not.toBe('0'.repeat(64));
    expect(lecture.bundle!.assets[1].width).toBe(16);
  });

  it('rejects executable HTML, MIME mismatch, malformed VTT, out-of-range captions and oversized JSON', async () => {
    const { request, url } = await setup(providers(), { maxJsonBytes: 200000 });
    const { result } = await request('/lectures', 'POST', { title: 'Boundaries' });
    const put = (bundle: Bundle) => request(`/lectures/${result.id}/input`, 'PUT', { expectedRevision: 0, bundle });
    const html = input(); html.context = [{ id: 'x', text: '<script>exfiltrate()</script>' }];
    expect((await put(html)).response.status).toBe(400);
    const mismatch = input(); mismatch.assets[1].base64 = Buffer.from('<html>login</html>').toString('base64');
    expect((await put(mismatch)).response.status).toBe(400);
    const ranges = input(); ranges.cues[0].endMs = 1001;
    expect((await put(ranges)).response.status).toBe(400);
    const vtt = input(); vtt.transcriptAssetId = 'captions'; vtt.assets.push({ id: 'captions', name: 'bad.vtt', mime: 'text/vtt', base64: Buffer.from('WEBVTT\n\nThis has no timings').toString('base64'), acquisition: 'manual_import' });
    expect((await put(vtt)).response.status).toBe(400);
    const huge = input(); huge.assets[0].base64 = 'AAAA'.repeat(60000);
    expect((await put(huge)).response.status).toBe(413);
    expect((await request(`/lectures/${result.id}/input`, 'PUT', { expectedRevision: 0, bundle: input() }, { 'Content-Encoding': 'gzip' })).response.status).toBe(415);
    expect((await request('/fetch', 'POST', { url: 'https://example.com' })).response.status).toBe(404);
    // Native fetch normalises dot segments before sending; send the raw path to
    // actually exercise the service's encoded-traversal boundary.
    const traversal = await new Promise<number>((resolve, reject) => {
      const destination = new URL(url);
      const req = http.get({ hostname: destination.hostname, port: destination.port, path: '/lectures/%2e%2e', headers: { Origin: origin, Authorization: `Bearer ${token}` } }, res => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject);
    });
    expect(traversal).toBe(400);
  });

  it('keeps captions and STT consent separate; missing captions block compile but explicit STT creates a new revision', async () => {
    const { app, request, create, adapter } = await setup(); const lecture = await create(input(false));
    expect((await request(`/lectures/${lecture.id}/compile`, 'POST', { expectedRevision: 1, consent: true, idempotencyKey: 'no-captions' })).response.status).toBe(409);
    expect((await request(`/lectures/${lecture.id}/transcribe`, 'POST', { expectedRevision: 1, consent: false, idempotencyKey: 'no-consent' })).response.status).toBe(400);
    expect(adapter.transcribe).not.toHaveBeenCalled();
    expect((await request(`/lectures/${lecture.id}/transcribe`, 'POST', { expectedRevision: 1, consent: true, idempotencyKey: 'stt' })).response.status).toBe(202);
    await app.waitForIdle();
    const next = await app.store.get(lecture.id);
    expect(next.revision).toBe(2); expect(next.transcriptOrigin).toBe('mock_stt'); expect(next.bundle!.cues[0].text).toBe('The rate is five units.');
    expect(adapter.transcribe).toHaveBeenCalledTimes(1);
  });
});

describe('persistent queue, cancellation, stale results and idempotency', () => {
  it('runs one compilation at a time in persisted order and cancels a queued second request without affecting the first', async () => {
    const gate = deferred<void>(); const started: string[] = [];
    const adapter = providers({ compile: vi.fn(async (bundle, revision) => { started.push(bundle.title); await gate.promise; return { compilation: compilation(bundle, revision), audit: {}, metadata: {} }; }) });
    const { app, create, request } = await setup(adapter);
    const firstBundle = input(); firstBundle.title = 'First'; const secondBundle = input(); secondBundle.title = 'Second';
    const first = await create(firstBundle), second = await create(secondBundle);
    await request(`/lectures/${first.id}/compile`, 'POST', { expectedRevision: 1, consent: true, idempotencyKey: 'first' });
    await until(() => started.length === 1);
    await request(`/lectures/${second.id}/compile`, 'POST', { expectedRevision: 1, consent: true, idempotencyKey: 'second' });
    expect((await app.store.snapshot()).jobs.map(job => job.lectureId)).toEqual([first.id, second.id]);
    await request(`/lectures/${second.id}/cancel`, 'POST');
    gate.resolve(); await app.waitForIdle();
    expect(started).toEqual(['First']); expect((await app.store.get(first.id)).status).toBe('review_ready'); expect((await app.store.get(second.id)).status).toBe('cancelled');
  });

  it('deduplicates concurrent and completed compile/synthesis keys and independently validates generated audio', async () => {
    const { app, request, create, adapter, prepare } = await setup(); const lecture = await create();
    const command = { expectedRevision: 1, consent: true, idempotencyKey: 'same' };
    const results = await Promise.all([request(`/lectures/${lecture.id}/compile`, 'POST', command), request(`/lectures/${lecture.id}/compile`, 'POST', command)]);
    expect(results.map(result => result.response.status)).toEqual([202, 202]); await app.waitForIdle();
    await request(`/lectures/${lecture.id}/compile`, 'POST', command); await app.waitForIdle(); expect(adapter.compile).toHaveBeenCalledTimes(1);
    const checked = await app.store.get(lecture.id); expect(validateCompilation(checked.compilation!, checked.bundle!, 1)).toEqual([]);
    await request(`/lectures/${lecture.id}/synthesise`, 'POST', { ...command, idempotencyKey: 'speech' }); await app.waitForIdle();
    await request(`/lectures/${lecture.id}/synthesise`, 'POST', { ...command, idempotencyKey: 'speech' }); await app.waitForIdle();
    expect(adapter.synthesise).toHaveBeenCalledTimes(1);
    await request(`/lectures/${lecture.id}/synthesise`, 'POST', { ...command, idempotencyKey: 'reuse-saved-speech' }); await app.waitForIdle();
    expect(adapter.synthesise).toHaveBeenCalledTimes(1);
    expect((await app.store.get(lecture.id)).chunks[0]).toMatchObject({ mode: 'cached', provider: 'test-mock' });
    const ready = await app.store.get(lecture.id); expect(ready.status).toBe('ready'); expect(ready.chunks[0].durationMs).toBe(1000);
    const audio = await request(`/lectures/${lecture.id}/audio/${ready.chunks[0].id}`); expect(audio.response.status).toBe(200); expect(Buffer.from(audio.result).subarray(0, 4).toString()).toBe('RIFF');
  });

  it('discards a provider completion after an input edit, keeping old question turns out of current revision', async () => {
    const gate = deferred<void>(); const started = deferred<void>();
    const adapter = providers({ compile: vi.fn(async (bundle, revision) => { started.resolve(); await gate.promise; return { compilation: compilation(bundle, revision), audit: {}, metadata: {} }; }) });
    const { app, request, create } = await setup(adapter); const lecture = await create();
    await request(`/lectures/${lecture.id}/compile`, 'POST', { expectedRevision: 1, consent: true, idempotencyKey: 'late' }); await started.promise;
    expect((await request(`/lectures/${lecture.id}/input`, 'PUT', { expectedRevision: 1, bundle: input() })).response.status).toBe(200);
    gate.resolve(); await app.waitForIdle();
    const revised = await app.store.get(lecture.id); expect(revised.revision).toBe(2); expect(revised.compilation).toBeUndefined(); expect(revised.questions).toHaveLength(0);
  });

  it('tombstones deletion during synthesis so a late response cannot recreate audio or a manifest', async () => {
    const gate = deferred<void>(), started = deferred<void>();
    const adapter = providers({ synthesise: vi.fn(async () => { started.resolve(); await gate.promise; return { bytes: wav(), mime: 'audio/wav', durationMs: 1000, provider: 'test', mode: 'mock' as const, model: 'test' }; }) });
    const { app, request, create, prepare, dataDir } = await setup(adapter); const lecture = await prepare(await create());
    await request(`/lectures/${lecture.id}/synthesise`, 'POST', { expectedRevision: 1, consent: true, idempotencyKey: 'late-audio' }); await started.promise;
    const deleted = await request(`/lectures/${lecture.id}`, 'DELETE'); expect(deleted.result.deleted).toBe(true);
    gate.resolve(); await app.waitForIdle();
    expect((await request(`/lectures/${lecture.id}`)).response.status).toBe(410);
    expect(await readdir(path.join(dataDir, 'blobs'))).toHaveLength(0); expect(await readdir(path.join(dataDir, 'revisions'))).toHaveLength(0);
  });

  it('rejects malformed compilations and unvalidated audio before storing playable chunks', async () => {
    const adapter = providers({ compile: vi.fn(async (bundle, revision) => { const c = compilation(bundle, revision); c.evidence[0] = { id: 'invented', kind: 'speech', cueId: 'not-real', quote: 'invented', sourceStartMs: 0, sourceEndMs: 1 }; return { compilation: c, audit: {}, metadata: {} }; }) });
    const { app, create, prepare, request } = await setup(adapter); const lecture = await prepare(await create()); expect(lecture.status).toBe('failed'); expect(lecture.chunks).toHaveLength(0);
    expect((await request(`/lectures/${lecture.id}/synthesise`, 'POST', { expectedRevision: 1, consent: true, idempotencyKey: 'no' })).response.status).toBe(409);
    void app;
    const badAudio = providers({ synthesise: vi.fn(async () => ({ bytes: Buffer.from('<html>not audio</html>'), mime: 'audio/wav', durationMs: 1000, provider: 'test', mode: 'mock' as const, model: 'test' })) });
    const second = await setup(badAudio); const checked = await second.prepare(await second.create());
    await second.request(`/lectures/${checked.id}/synthesise`, 'POST', { expectedRevision: 1, consent: true, idempotencyKey: 'bad' }); await second.app.waitForIdle();
    expect((await second.app.store.get(checked.id)).status).toBe('failed'); expect((await second.app.store.get(checked.id)).chunks).toHaveLength(0);
  });
});

describe('grounded local questions, warnings and exact resume position', () => {
  it('retrieves checked source text, saves bounded revision-scoped question history, and restores the exact playback offset', async () => {
    const { app, request, create, prepare } = await setup(); const lecture = await prepare(await create());
    await request(`/lectures/${lecture.id}/synthesise`, 'POST', { expectedRevision: 1, consent: true, idempotencyKey: 'speech' }); await app.waitForIdle();
    const response = await request(`/lectures/${lecture.id}/questions`, 'POST', { expectedRevision: 1, question: 'What is the rate?', segmentId: 's1', offset: 0.35, consent: true });
    expect(response.response.status, JSON.stringify(response.result)).toBe(200); expect(response.result.answer.status).toBe('supported'); expect(response.result.answer.text).toBe('The rate is five units.');
    const current = await app.store.get(lecture.id); expect(current.playback?.offset).toBe(0.35); expect(current.questions).toHaveLength(1); expect(current.questions[0].chunk?.mode).toBe('mock');
    const unsupported = await request(`/lectures/${lecture.id}/questions`, 'POST', { expectedRevision: 1, question: 'How many moons orbit Mars?', segmentId: 's1', offset: 0.35, consent: true }); expect(unsupported.result.answer.status).toBe('limitation'); expect(unsupported.result.answer.text).not.toMatch(/\b2\b|\btwo\b/);
    await request(`/lectures/${lecture.id}/input`, 'PUT', { expectedRevision: 1, bundle: input() });
    const revised = await app.store.get(lecture.id); expect(revised.questions).toHaveLength(0); expect(revised.history[0].questions).toHaveLength(2); expect(revised.status).toBe('stale');
    expect((await request(`/lectures/${lecture.id}/playback`, 'PUT', { segmentId: 's1', offset: 0.35, rate: 1 })).response.status).toBe(409);
  });

  for (const status of ['incomplete', 'conflict'] as const) it(`preserves ${status} source limitations in Q&A and prepends a real audible warning before TTS`, async () => {
    const adapter = providers({ compile: vi.fn(async (bundle, revision) => ({ compilation: compilation(bundle, revision, status), audit: {}, metadata: {} })) });
    const { app, create, prepare, request } = await setup(adapter); const lecture = await prepare(await create());
    expect(lecture.status, lecture.error).toBe('incomplete');
    const question = await request(`/lectures/${lecture.id}/questions`, 'POST', { expectedRevision: 1, question: 'Which option should I select?', segmentId: 's1', offset: 0, consent: true });
    expect(question.response.status, JSON.stringify(question.result)).toBe(200); expect(question.result.answer.status).toBe(status === 'conflict' ? 'conflict' : 'limitation');
    expect(question.result.answer.text).toContain(status === 'conflict' ? 'conflicts' : 'does not identify');
    await request(`/lectures/${lecture.id}/synthesise`, 'POST', { expectedRevision: 1, consent: true, idempotencyKey: 'warn' }); await app.waitForIdle();
    const spoken = vi.mocked(adapter.synthesise).mock.calls.map(call => call[0]); expect(spoken.some(text => text.startsWith('AI-generated adaptation. Essential visual information is unresolved or conflicting.'))).toBe(true);
  });
});
