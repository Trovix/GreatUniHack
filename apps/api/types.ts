import type { Bundle, Compilation, QuestionAnswer } from '../../packages/core/index.js';

export type LectureStatus = 'draft' | 'ready_for_analysis' | 'queued' | 'analysing' | 'review_ready' | 'synthesising' | 'ready' | 'incomplete' | 'failed' | 'cancelled' | 'stale';
export interface AudioChunk {
  id: string;
  segmentId: string;
  inputRevision: number;
  durationMs: number;
  mime: string;
  mode: 'live' | 'mock' | 'cached';
  provider: string;
  scriptHash: string;
  blobHash: string;
  model?: string;
  voiceId?: string;
  alignment?: unknown;
  purpose?: 'narration' | 'question';
  text?: string;
}
export interface Playback { segmentId: string; offset: number; rate: number }
export interface QuestionTurn {
  id: string;
  inputRevision: number;
  question: string;
  answer: QuestionAnswer;
  segmentId: string;
  offset: number;
  at: string;
  latencyMs: number;
  chunk?: AudioChunk;
}
export interface ArchivedRevision {
  revision: number;
  status: LectureStatus;
  archivedAt: string;
  bundle?: Bundle;
  compilation?: Compilation;
  audit?: unknown;
  chunks: AudioChunk[];
  questions: QuestionTurn[];
  playback?: Playback;
}
export interface Lecture {
  id: string;
  title: string;
  revision: number;
  status: LectureStatus;
  bundle?: Bundle;
  compilation?: Compilation;
  audit?: unknown;
  providerMetadata?: Record<string, unknown>;
  chunks: AudioChunk[];
  events: { at: string; stage: string; message: string }[];
  playback?: Playback;
  questions: QuestionTurn[];
  history: ArchivedRevision[];
  warnings: string[];
  error?: string;
  errorCode?: string;
  unknownOutcome?: boolean;
  createdAt: string;
  updatedAt: string;
  generation: number;
  transcriptOrigin?: 'supplied_captions' | 'elevenlabs_stt' | 'mock_stt';
  transcription?: { raw: unknown; provider: string; mode: 'live' | 'mock'; at: string };
}
export type JobKind = 'compile' | 'synthesise' | 'transcribe';
export interface QueuedJob {
  id: string;
  lectureId: string;
  revision: number;
  generation: number;
  kind: JobKind;
  key: string;
  fingerprint: string;
  status: 'pending' | 'running';
  consentAt: string;
  createdAt: string;
}
export interface IdempotencyRecord {
  lectureId: string;
  key: string;
  kind: JobKind;
  revision: number;
  fingerprint: string;
  jobId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stale' | 'unknown';
}
export interface StoreState {
  version: 1;
  order: string[];
  lectures: Record<string, Lecture>;
  tombstones: Record<string, string>;
  jobs: QueuedJob[];
  idempotency: IdempotencyRecord[];
}
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = 'ApiError'; }
}
export function event(lecture: Lecture, stage: string, message: string): void {
  lecture.updatedAt = new Date().toISOString();
  lecture.events.push({ at: lecture.updatedAt, stage, message });
  if (lecture.events.length > 200) lecture.events.splice(0, lecture.events.length - 200);
}
