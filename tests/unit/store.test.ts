import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LectureStore, atomicWrite, contentHash } from '../../apps/api/store.js';
import type { Bundle } from '../../packages/core/index.js';

const directories: string[] = [];
async function directory() { const value = await mkdtemp(path.join(os.tmpdir(), 'lecture-store-')); directories.push(value); return value; }
afterEach(async () => { await Promise.all(directories.splice(0).map(value => rm(value, { recursive: true, force: true }))); });
function bundle(text = 'Shared bytes'): Bundle {
  const bytes = Buffer.from(text);
  return { title: 'Local lecture', audioAssetId: 'source', cues: [{ id: 'c1', startMs: 0, endMs: 1000, text: 'The rate is five units.' }], timeline: [{ id: 't1', stateId: 'v1', assetId: 'slide', startMs: 0, endMs: 1000, alignment: 'user_confirmed' }], assets: [
    { id: 'source', name: 'source.wav', mime: 'audio/wav', base64: bytes.toString('base64'), acquisition: 'manual_import', durationMs: 1000, sha256: contentHash(bytes) },
    { id: 'slide', name: 'slide.png', mime: 'image/png', base64: bytes.toString('base64'), acquisition: 'manual_import', sha256: contentHash(bytes), width: 1, height: 1 },
  ] };
}

describe('durable immutable lecture storage', () => {
  it('retains queue order, compact hash references, hydration and playback across restart', async () => {
    const dir = await directory();
    const store = await LectureStore.open(dir);
    const first = await store.create('First');
    const second = await store.create('Second');
    await store.replaceInput(first.id, 0, bundle());
    await store.update(first.id, lecture => { lecture.playback = { segmentId: 's1', offset: 0.25, rate: 1.5 }; });
    const reopened = await LectureStore.open(dir);
    expect((await reopened.list()).map(lecture => lecture.id)).toEqual([first.id, second.id]);
    expect((await reopened.get(first.id)).bundle?.assets[0].base64).toBe(bundle().assets[0].base64);
    expect((await reopened.get(first.id)).playback).toEqual({ segmentId: 's1', offset: 0.25, rate: 1.5 });
    const index = await readFile(path.join(dir, 'index.json'), 'utf8');
    expect(index).not.toContain(bundle().assets[0].base64);
    expect(await readdir(path.join(dir, 'revisions'))).toHaveLength(1);
  });

  it('preserves a shared blob until the last referencing lecture is deleted', async () => {
    const dir = await directory();
    const store = await LectureStore.open(dir);
    const first = await store.create('First'), second = await store.create('Second');
    await store.replaceInput(first.id, 0, bundle());
    await store.replaceInput(second.id, 0, bundle());
    expect(await readdir(path.join(dir, 'blobs'))).toHaveLength(1);
    expect((await store.delete(first.id)).sharedBlobsRetained).toBe(1);
    expect((await store.get(second.id)).bundle?.assets[0].base64).toBe(bundle().assets[0].base64);
    expect((await store.delete(second.id)).sharedBlobsRetained).toBe(0);
    expect(await readdir(path.join(dir, 'blobs'))).toHaveLength(0);
    expect(await readdir(path.join(dir, 'revisions'))).toHaveLength(0);
    await expect(store.get(first.id)).rejects.toMatchObject({ status: 410 });
    const reopened = await LectureStore.open(dir);
    await expect(reopened.get(first.id)).rejects.toMatchObject({ status: 410 });
  });

  it('archives old outputs and Q&A, clears current playback and invalidates running jobs on an input edit', async () => {
    const store = await LectureStore.open(await directory());
    const created = await store.create('First');
    await store.replaceInput(created.id, 0, bundle());
    await store.update(created.id, lecture => { lecture.playback = { segmentId: 's1', offset: 0.4, rate: 1 }; lecture.questions.push({ id: 'q1', inputRevision: 1, question: 'Rate?', answer: { status: 'limitation', text: 'The source does not establish this.', evidenceIds: [] }, segmentId: 's1', offset: 0.4, at: new Date().toISOString(), latencyMs: 2 }); });
    await store.enqueue(created.id, 1, 'compile', 'once', 'same', () => {});
    const job = (await store.takeJob())!;
    const revised = await store.replaceInput(created.id, 1, bundle('New source'));
    expect(revised.revision).toBe(2);
    expect(revised.history[0].questions).toHaveLength(1);
    expect(revised.history[0].playback?.offset).toBe(0.4);
    expect(revised.questions).toHaveLength(0);
    expect(revised.playback).toBeUndefined();
    let invoked = false;
    expect(await store.finishJob(job, () => { invoked = true; })).toBe(false);
    expect(invoked).toBe(false);
    await expect(store.update(created.id, () => {}, { revision: 1, generation: job.generation })).rejects.toMatchObject({ status: 409 });
  });

  it('does not publish a failed atomic write or break a subsequent retry', async () => {
    const dir = await directory();
    let fail = false;
    const store = await LectureStore.open(dir, { writeAtomic: async (file, bytes) => { if (fail && file.endsWith('index.json')) throw new Error('simulated disk full'); await atomicWrite(file, bytes); } });
    const created = await store.create('First');
    fail = true;
    await expect(store.replaceInput(created.id, 0, bundle())).rejects.toThrow('simulated disk full');
    expect((await store.get(created.id)).revision).toBe(0);
    const reopened = await LectureStore.open(dir);
    expect((await reopened.get(created.id)).revision).toBe(0);
    fail = false;
    expect((await store.replaceInput(created.id, 0, bundle('Corrected source'))).revision).toBe(1);
  });

  it('recovers pending jobs but never automatically retries a submitted unknown-outcome request', async () => {
    const dir = await directory();
    const store = await LectureStore.open(dir);
    const first = await store.create('First'), second = await store.create('Second');
    await store.replaceInput(first.id, 0, bundle()); await store.replaceInput(second.id, 0, bundle());
    await store.enqueue(first.id, 1, 'compile', 'first', 'one', () => {});
    await store.enqueue(second.id, 1, 'compile', 'second', 'two', () => {});
    await store.takeJob();
    const reopened = await LectureStore.open(dir);
    expect((await reopened.get(first.id)).unknownOutcome).toBe(true);
    expect((await reopened.get(first.id)).status).toBe('failed');
    expect((await reopened.snapshot()).jobs.map(job => job.lectureId)).toEqual([second.id]);
    expect((await reopened.snapshot()).idempotency[0].status).toBe('unknown');
  });

  it('deduplicates successful request keys and rejects a key reused for another revision or action', async () => {
    const store = await LectureStore.open(await directory());
    const created = await store.create('First'); await store.replaceInput(created.id, 0, bundle());
    await store.enqueue(created.id, 1, 'compile', 'key', 'same', () => {});
    const job = (await store.takeJob())!;
    await store.finishJob(job, lecture => { lecture.status = 'review_ready'; });
    await store.enqueue(created.id, 1, 'compile', 'key', 'same', () => { throw new Error('must not run'); });
    expect((await store.snapshot()).jobs).toHaveLength(0);
    await expect(store.enqueue(created.id, 1, 'synthesise', 'key', 'different', () => {})).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rejects path-shaped IDs and refuses late completion after a durable deletion tombstone', async () => {
    const dir = await directory(); const store = await LectureStore.open(dir);
    await expect(store.get('../outside')).rejects.toMatchObject({ status: 400 });
    const created = await store.create('First'); await store.replaceInput(created.id, 0, bundle());
    await store.enqueue(created.id, 1, 'compile', 'key', 'same', () => {});
    const job = (await store.takeJob())!;
    await store.delete(created.id);
    expect(await store.finishJob(job, () => { throw new Error('late commit'); })).toBe(false);
    expect(await readdir(path.join(dir, 'blobs'))).toHaveLength(0);
  });
});

describe('derived audio reachability', () => {
  it('reclaims displaced narration and trimmed answers only after a successful commit', async () => {
    const dir = await directory(); let fail = false;
    const store = await LectureStore.open(dir, { writeAtomic: async (file, bytes) => {
      if (fail && file.endsWith('index.json')) throw new Error('disk full');
      await atomicWrite(file, bytes);
    } });
    const lecture = await store.create('First');
    const hash = await store.putBlob(Buffer.from('old private narration'));
    const chunk = { id: 'chunk', segmentId: 's1', inputRevision: 1, durationMs: 1000, mime: 'audio/wav', mode: 'mock' as const, provider: 'test', scriptHash: hash, blobHash: hash };
    await store.update(lecture.id, value => { value.chunks = [chunk]; });
    fail = true;
    await expect(store.update(lecture.id, value => { value.chunks = []; })).rejects.toThrow('disk full');
    expect((await store.readBlob(hash)).toString()).toBe('old private narration');
    fail = false;
    await store.update(lecture.id, value => { value.chunks = []; });
    await expect(store.readBlob(hash)).rejects.toMatchObject({ code: 'ENOENT' });
    const answerHash = await store.putBlob(Buffer.from('old private answer'));
    await store.update(lecture.id, value => { value.questions = [{ id: 'q', inputRevision: 1, question: 'Question?', answer: { text: 'Unsupported.', status: 'limitation', evidenceIds: [] }, segmentId: 's1', offset: 0, at: 'now', latencyMs: 0, chunk: { ...chunk, blobHash: answerHash } }]; });
    await store.update(lecture.id, value => { value.questions = []; });
    await expect(store.readBlob(answerHash)).rejects.toMatchObject({ code: 'ENOENT' });
    await store.delete(lecture.id);
    expect(await readdir(path.join(dir, 'blobs'))).toEqual([]);
  });
  it('keeps a displaced blob while another lecture still references it', async () => {
    const store = await LectureStore.open(await directory());
    const a = await store.create('First'), b = await store.create('Second');
    const hash = await store.putBlob(Buffer.from('shared narration'));
    const chunk = { id: 'chunk', segmentId: 's1', inputRevision: 1, durationMs: 1000, mime: 'audio/wav', mode: 'mock' as const, provider: 'test', scriptHash: hash, blobHash: hash };
    for (const lecture of [a,b]) await store.update(lecture.id, value => { value.chunks = [chunk]; });
    await store.update(a.id, value => { value.chunks = []; });
    expect((await store.readBlob(hash)).toString()).toBe('shared narration');
    await store.delete(b.id);
    await expect(store.readBlob(hash)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reclaims orphaned blobs left before a manifest commit when reopening', async () => {
    const dir = await directory(); const store = await LectureStore.open(dir);
    await store.create('First'); const hash = await store.putBlob(Buffer.from('interrupted upload'));
    await writeFile(path.join(dir, 'blobs', 'unrelated-file'), 'keep');
    await LectureStore.open(dir);
    await expect(store.readBlob(hash)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(path.join(dir, 'blobs'))).toEqual(['unrelated-file']);
  });
});
