import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, readdir, open, chmod, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { Bundle } from '../../packages/core/index.js';
import { ApiError, event, type Lecture, type QueuedJob, type StoreState, type JobKind } from './types.js';

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
export const contentHash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
export function assertId(id: string): void {
  if (!ID.test(id)) throw new ApiError(400, 'INVALID_ID', 'Invalid identifier.');
}
export async function atomicWrite(filename: string, bytes: string | Uint8Array): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
    // A synced directory makes the rename durable across a host restart, not just a process restart.
    const directory = await open(path.dirname(filename), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
const fresh = (): StoreState => ({ version: 1, order: [], lectures: {}, tombstones: {}, jobs: [], idempotency: [] });
function compactBundle(bundle: Bundle): Bundle {
  const copy = structuredClone(bundle);
  for (const asset of copy.assets) asset.base64 = '';
  return copy;
}
function refs(state: StoreState): Set<string> {
  const hashes = new Set<string>();
  const addBundle = (bundle?: Bundle) => bundle?.assets.forEach(asset => { if (asset.sha256) hashes.add(asset.sha256); });
  for (const lecture of Object.values(state.lectures)) {
    addBundle(lecture.bundle);
    lecture.chunks.forEach(chunk => hashes.add(chunk.blobHash));
    lecture.questions.forEach(turn => { if (turn.chunk) hashes.add(turn.chunk.blobHash); });
    for (const history of lecture.history) {
      addBundle(history.bundle);
      history.chunks.forEach(chunk => hashes.add(chunk.blobHash));
      history.questions.forEach(turn => { if (turn.chunk) hashes.add(turn.chunk.blobHash); });
    }
  }
  return hashes;
}
export interface StoreOptions {
  /** Injectable atomic writer permits deterministic disk-failure tests. */
  writeAtomic?: typeof atomicWrite;
}
export class LectureStore {
  private state: StoreState = fresh();
  private serial: Promise<unknown> = Promise.resolve();
  private constructor(readonly directory: string, private writer: typeof atomicWrite) {}
  static async open(directory: string, options: StoreOptions = {}): Promise<LectureStore> {
    const store = new LectureStore(path.resolve(directory), options.writeAtomic ?? atomicWrite);
    await mkdir(store.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(store.directory)).isDirectory() || (await lstat(store.directory)).isSymbolicLink()) throw new Error('Data directory must be a private directory, not a symlink.');
    await chmod(store.directory, 0o700);
    await mkdir(path.join(store.directory, 'blobs'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(store.directory, 'revisions'), { recursive: true, mode: 0o700 });
    try {
      const loaded = JSON.parse(await readFile(store.indexPath(), 'utf8')) as StoreState;
      if (loaded.version !== 1 || !loaded.lectures || !Array.isArray(loaded.order) || !Array.isArray(loaded.jobs) || !Array.isArray(loaded.idempotency) || !loaded.tombstones) throw new Error('Invalid storage index.');
      store.state = loaded;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot safely read lecture storage; existing data was not overwritten.');
      await store.writer(store.indexPath(), JSON.stringify(store.state));
    }
    await store.transaction(state => {
      // A submitted call cannot be replayed safely: its billing outcome is unknown.
      for (const job of state.jobs.filter(job => job.status === 'running')) {
        const lecture = state.lectures[job.lectureId];
        if (lecture && lecture.revision === job.revision && lecture.generation === job.generation) {
          lecture.generation++;
          lecture.status = 'failed';
          lecture.errorCode = 'INTERRUPTED_OUTCOME_UNKNOWN';
          lecture.error = 'Service restarted during a provider request. Outcome unknown; an explicit retry may incur another charge.';
          lecture.unknownOutcome = true;
          event(lecture, 'failed', lecture.error);
        }
        const record = state.idempotency.find(record => record.jobId === job.id);
        if (record) record.status = 'unknown';
      }
      state.jobs = state.jobs.filter(job => job.status === 'pending' && state.lectures[job.lectureId] && !state.tombstones[job.lectureId]);
    });
    // At startup no uploads or jobs can be in flight. Recover blobs orphaned by a
    // crash between blob creation and the manifest commit, or an older version.
    await store.removeUnreferenced(await readdir(path.join(store.directory, 'blobs')));
    return store;
  }
  private indexPath(): string { return path.join(this.directory, 'index.json'); }
  async transaction<T>(operation: (draft: StoreState) => T | Promise<T>): Promise<T> {
    const run = this.serial.then(async () => {
      const previousReferences = refs(this.state);
      const draft = structuredClone(this.state);
      const result = await operation(draft);
      await this.writer(this.indexPath(), JSON.stringify(draft));
      this.state = draft;
      // Recompilation and bounded question history can displace audio without
      // deleting a lecture. Reclaim only after the new manifest is durable, in
      // this serialization lane, preserving every other lecture's references.
      const reachable = refs(draft);
      for (const hash of previousReferences) if (!reachable.has(hash)) {
        await unlink(path.join(this.directory, 'blobs', hash)).catch(() => {});
      }
      return structuredClone(result);
    });
    this.serial = run.catch(() => {});
    return run;
  }
  async snapshot(): Promise<StoreState> { await this.serial; return structuredClone(this.state); }
  private find(state: StoreState, id: string): Lecture {
    assertId(id);
    if (state.tombstones[id]) throw new ApiError(410, 'DELETED', 'This lecture was deleted.');
    const lecture = state.lectures[id];
    if (!lecture) throw new ApiError(404, 'NOT_FOUND', 'Lecture not found.');
    return lecture;
  }
  async get(id: string, hydrate = true): Promise<Lecture> {
    await this.serial;
    const lecture = structuredClone(this.find(this.state, id));
    if (hydrate && lecture.bundle) lecture.bundle = await this.hydrate(lecture.bundle);
    // History is intentionally compact; archived source assets are retrieved through their IDs.
    return lecture;
  }
  async list(): Promise<Lecture[]> {
    await this.serial;
    return this.state.order.filter(id => this.state.lectures[id]).map(id => structuredClone(this.state.lectures[id]));
  }
  async create(title: string): Promise<Lecture> {
    return this.transaction(state => {
      if (state.order.length >= 100) throw new ApiError(409, 'LECTURE_LIMIT', 'Delete an unused lecture before creating another (maximum 100).');
      const id = randomUUID();
      const now = new Date().toISOString();
      const lecture: Lecture = { id, title, revision: 0, generation: 0, status: 'draft', chunks: [], events: [], questions: [], history: [], warnings: [], createdAt: now, updatedAt: now };
      event(lecture, 'draft', 'Lecture created locally. Nothing has been sent to a provider.');
      state.lectures[id] = lecture;
      state.order.push(id);
      return lecture;
    });
  }
  async putBlob(bytes: Uint8Array): Promise<string> {
    const hash = contentHash(bytes);
    const file = path.join(this.directory, 'blobs', hash);
    try {
      const existing = await readFile(file);
      if (contentHash(existing) !== hash) throw new Error('Content-addressed blob failed integrity verification.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await atomicWrite(file, bytes);
    }
    return hash;
  }
  async readBlob(hash: string): Promise<Buffer> {
    if (!HASH.test(hash)) throw new ApiError(400, 'INVALID_HASH', 'Invalid content hash.');
    const bytes = await readFile(path.join(this.directory, 'blobs', hash));
    if (contentHash(bytes) !== hash) throw new ApiError(500, 'BLOB_INTEGRITY', 'Stored content failed its integrity check. Reimport the source.');
    return bytes;
  }
  async hydrate(bundle: Bundle): Promise<Bundle> {
    const result = structuredClone(bundle);
    for (const asset of result.assets) {
      if (!asset.sha256) throw new ApiError(500, 'BLOB_INTEGRITY', 'Source content hash is missing.');
      asset.base64 = (await this.readBlob(asset.sha256)).toString('base64');
    }
    return result;
  }
  async replaceInput(id: string, revision: number, bundle: Bundle, transcriptOrigin?: Lecture['transcriptOrigin']): Promise<Lecture> {
    return this.transaction(async state => {
      const lecture = this.find(state, id);
      if (lecture.revision !== revision) throw new ApiError(409, 'REVISION_CONFLICT', 'Inputs changed. Reload the current lecture and try again.');
      for (const asset of bundle.assets) {
        const actual = await this.putBlob(Buffer.from(asset.base64, 'base64'));
        if (asset.sha256 !== actual) throw new ApiError(400, 'HASH_MISMATCH', 'Asset hash did not match its bytes.');
      }
      if (lecture.history.length >= 30) throw new ApiError(409, 'REVISION_LIMIT', 'This prototype retains at most 30 input revisions. Create a new lecture.');
      if (lecture.bundle) lecture.history.push({ revision: lecture.revision, status: lecture.status, archivedAt: new Date().toISOString(), bundle: lecture.bundle, compilation: lecture.compilation, audit: lecture.audit, chunks: lecture.chunks, questions: lecture.questions, playback: lecture.playback });
      const hadOutput = Boolean(lecture.compilation || lecture.chunks.length);
      lecture.revision++;
      lecture.generation++;
      lecture.title = bundle.title;
      lecture.bundle = compactBundle(bundle);
      lecture.compilation = undefined;
      lecture.audit = undefined;
      lecture.providerMetadata = undefined;
      lecture.chunks = [];
      lecture.questions = [];
      lecture.playback = undefined;
      lecture.error = undefined;
      lecture.errorCode = undefined;
      lecture.unknownOutcome = undefined;
      lecture.transcriptOrigin = transcriptOrigin;
      lecture.transcription = undefined;
      lecture.warnings = [];
      lecture.status = hadOutput ? 'stale' : bundle.cues.length ? 'ready_for_analysis' : 'draft';
      for (const record of state.idempotency.filter(record => record.lectureId === id && ['pending', 'running'].includes(record.status))) record.status = 'stale';
      state.jobs = state.jobs.filter(job => job.lectureId !== id);
      const revisionBytes = JSON.stringify({ id, revision: lecture.revision, bundle: lecture.bundle });
      const revisionFile = path.join(this.directory, 'revisions', `${id}-${lecture.revision}-${contentHash(revisionBytes)}.json`);
      // Content-addressed immutable revisions are written before publishing the index pointer.
      // A failed index write can leave only an unreachable revision, never a half-published input.
      try { await readFile(revisionFile); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await this.writer(revisionFile, revisionBytes); }
      event(lecture, lecture.status, hadOutput ? 'Inputs changed. Previous output and question history are archived; regenerate before playback.' : 'Selected source bytes stored locally. Provider consent is still required.');
      return lecture;
    });
  }
  async update(id: string, operation: (lecture: Lecture) => void | Promise<void>, guard?: { revision: number; generation?: number }): Promise<Lecture> {
    return this.transaction(async state => {
      const lecture = this.find(state, id);
      if (guard && (lecture.revision !== guard.revision || (guard.generation !== undefined && lecture.generation !== guard.generation))) throw new ApiError(409, 'STALE_RESULT', 'The request no longer applies to the current lecture.');
      await operation(lecture);
      lecture.updatedAt = new Date().toISOString();
      return lecture;
    });
  }
  async enqueue(id: string, revision: number, kind: JobKind, key: string, fingerprint: string, validate: (lecture: Lecture) => void): Promise<Lecture> {
    return this.transaction(state => {
      const lecture = this.find(state, id);
      if (lecture.revision !== revision) throw new ApiError(409, 'REVISION_CONFLICT', 'Inputs changed. Reload before preparing this lecture.');
      const prior = state.idempotency.find(record => record.lectureId === id && record.key === key);
      if (prior) {
        if (prior.kind !== kind || prior.revision !== revision || prior.fingerprint !== fingerprint) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different request.');
        return lecture;
      }
      if (state.jobs.some(job => job.lectureId === id)) throw new ApiError(409, 'BUSY', 'This lecture already has a queued or running request.');
      if (state.jobs.length >= 100) throw new ApiError(429, 'QUEUE_LIMIT', 'Preparation queue is full.');
      if (state.idempotency.filter(record => record.lectureId === id).length >= 100) throw new ApiError(409, 'REQUEST_LIMIT', 'This lecture has reached its persisted request limit. Create a new lecture rather than evicting successful idempotency records.');
      validate(lecture);
      // Every explicit new request invalidates prior asynchronous completions, including Q&A audio.
      lecture.generation++;
      const job: QueuedJob = { id: randomUUID(), lectureId: id, revision, generation: lecture.generation, kind, key, fingerprint, status: 'pending', createdAt: new Date().toISOString(), consentAt: new Date().toISOString() };
      state.jobs.push(job);
      state.idempotency.push({ lectureId: id, key, revision, kind, fingerprint, jobId: job.id, status: 'pending' });
      lecture.status = 'queued';
      lecture.error = undefined;
      lecture.errorCode = undefined;
      lecture.unknownOutcome = undefined;
      event(lecture, 'queued', `${kind === 'compile' ? 'Visual analysis' : kind === 'synthesise' ? 'Narration' : 'Transcription'} queued with explicit, separate provider consent.`);
      return lecture;
    });
  }
  async takeJob(): Promise<QueuedJob | undefined> {
    return this.transaction(state => {
      const job = state.jobs.find(job => job.status === 'pending');
      if (!job) return undefined;
      job.status = 'running';
      const record = state.idempotency.find(record => record.jobId === job.id);
      if (record) record.status = 'running';
      return job;
    });
  }
  async finishJob(job: QueuedJob, operation: (lecture: Lecture) => void | Promise<void>, failed?: { unknown?: boolean }): Promise<boolean> {
    return this.transaction(async state => {
      const currentJob = state.jobs.find(candidate => candidate.id === job.id);
      const lecture = state.lectures[job.lectureId];
      if (!currentJob || !lecture || state.tombstones[job.lectureId] || lecture.revision !== job.revision || lecture.generation !== job.generation) return false;
      await operation(lecture);
      const record = state.idempotency.find(record => record.jobId === job.id);
      if (record) record.status = failed ? failed.unknown ? 'unknown' : 'failed' : 'succeeded';
      state.jobs = state.jobs.filter(candidate => candidate.id !== job.id);
      lecture.updatedAt = new Date().toISOString();
      return true;
    });
  }
  async completeTranscription(job: QueuedJob, bundle: Bundle, transcription: NonNullable<Lecture['transcription']>): Promise<boolean> {
    return this.finishJob(job, async lecture => {
      if (lecture.history.length >= 30) throw new ApiError(409, 'REVISION_LIMIT', 'This lecture reached the maximum number of input revisions.');
      if (lecture.bundle) lecture.history.push({ revision: lecture.revision, status: lecture.status, archivedAt: new Date().toISOString(), bundle: lecture.bundle, compilation: lecture.compilation, audit: lecture.audit, chunks: lecture.chunks, questions: lecture.questions, playback: lecture.playback });
      for (const asset of bundle.assets) {
        const hash = await this.putBlob(Buffer.from(asset.base64, 'base64'));
        if (hash !== asset.sha256) throw new ApiError(400, 'HASH_MISMATCH', 'Transcript asset hash mismatch.');
      }
      lecture.revision++;
      lecture.generation++;
      lecture.bundle = compactBundle(bundle);
      lecture.compilation = undefined;
      lecture.audit = undefined;
      lecture.chunks = [];
      lecture.questions = [];
      lecture.playback = undefined;
      lecture.transcription = transcription;
      lecture.transcriptOrigin = transcription.mode === 'mock' ? 'mock_stt' : 'elevenlabs_stt';
      lecture.status = 'ready_for_analysis';
      lecture.error = undefined;
      lecture.errorCode = undefined;
      const bytes = JSON.stringify({ id: lecture.id, revision: lecture.revision, bundle: lecture.bundle });
      const file = path.join(this.directory, 'revisions', `${lecture.id}-${lecture.revision}-${contentHash(bytes)}.json`);
      await this.writer(file, bytes);
      event(lecture, 'ready_for_analysis', 'Timestamped transcription stored as a new input revision. Review captions before visual analysis; audio remains authoritative.');
    });
  }
  async cancel(id: string): Promise<Lecture> {
    return this.transaction(state => {
      const lecture = this.find(state, id);
      const submitted = state.jobs.some(job => job.lectureId === id && job.status === 'running');
      lecture.generation++;
      lecture.status = 'cancelled';
      lecture.playback = undefined;
      for (const record of state.idempotency.filter(record => record.lectureId === id && ['running', 'pending'].includes(record.status))) record.status = 'cancelled';
      state.jobs = state.jobs.filter(job => job.lectureId !== id);
      event(lecture, 'cancelled', submitted ? 'Cancelled locally. A provider request may already have been billed; late results cannot become current.' : 'Cancelled before submission. No queued request will be sent.');
      return lecture;
    });
  }
  async delete(id: string): Promise<{ deleted: true; sharedBlobsRetained: number; notice: string }> {
    const result = await this.transaction(state => {
      const lecture = this.find(state, id);
      const own = refs({ ...fresh(), lectures: { [id]: lecture } });
      state.tombstones[id] = new Date().toISOString();
      delete state.lectures[id];
      state.order = state.order.filter(candidate => candidate !== id);
      state.jobs = state.jobs.filter(job => job.lectureId !== id);
      state.idempotency = state.idempotency.filter(record => record.lectureId !== id);
      const remaining = refs(state);
      return { remove: [...own].filter(hash => !remaining.has(hash)), shared: [...own].filter(hash => remaining.has(hash)).length };
    });
    // Keep GC within the same serialization lane: concurrent import cannot make a shared
    // reference between the reachability check and unlink. Recheck before each removal.
    await this.transaction(async state => {
      const reachable = refs(state);
      for (const hash of result.remove) if (!reachable.has(hash)) await unlink(path.join(this.directory, 'blobs', hash)).catch(() => {});
      for (const file of await readdir(path.join(this.directory, 'revisions'))) if (file.startsWith(`${id}-`) && file.endsWith('.json')) await unlink(path.join(this.directory, 'revisions', file)).catch(() => {});
    });
    return { deleted: true, sharedBlobsRetained: result.shared, notice: 'Deleted locally. Identical bytes remain only when referenced by another lecture. Local deletion does not erase provider retention or undo provider billing.' };
  }
  async removeUnreferenced(hashes: string[]): Promise<void> {
    await this.transaction(async state => {
      const reachable = refs(state);
      for (const hash of hashes) if (HASH.test(hash) && !reachable.has(hash)) await unlink(path.join(this.directory, 'blobs', hash)).catch(() => {});
    });
  }
}
