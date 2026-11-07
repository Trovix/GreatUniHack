import type { Lecture, AudioChunk } from '../../api/types';
import { timelineErrors, type TimelineEntry } from '../../../packages/core/index';

export type Step = 'find' | 'prepare' | 'listen';
export type BatchItem = {lectureId: string; revision: number};
export type Batch = {items: BatchItem[]; cursor: number};
export type SavedUi = {activeId?: string; step?: Step; batch?: Batch};
export type ResumePoint = {lectureId: string; revision: number; segmentId: string; offset: number};
export const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft', ready_for_analysis: 'Sources ready', queued: 'Waiting to prepare', analysing: 'Analysing sources', review_ready: 'Script ready for review', synthesising: 'Generating speech', ready: 'Ready to listen', incomplete: 'Incomplete — source limitations', failed: 'Preparation failed', cancelled: 'Cancelled', stale: 'Sources changed — regenerate',
};
export function labelStatus(status: string): string { return STATUS_LABELS[status] ?? 'Unknown preparation state'; }
export function isCurrent(lecture: Lecture): boolean { return lecture.compilation?.inputRevision === lecture.revision; }
export function currentChunks(lecture: Lecture): AudioChunk[] {
  if (!isCurrent(lecture)) return [];
  return lecture.compilation!.segments.flatMap(segment => {
    const chunk = lecture.chunks.find(chunk => chunk.segmentId === segment.id && chunk.inputRevision === lecture.revision && chunk.purpose !== 'question');
    return chunk ? [chunk] : [];
  });
}
export function canListen(lecture: Lecture): boolean {
  return ['ready', 'incomplete'].includes(lecture.status) && isCurrent(lecture) && Boolean(lecture.compilation?.segments.length) && currentChunks(lecture).length === lecture.compilation!.segments.length;
}
export function readySnapshot(lectures: Lecture[]): Batch {
  return {items: lectures.filter(canListen).map(lecture => ({lectureId: lecture.id, revision: lecture.revision})), cursor: 0};
}
export function batchLecture(item: BatchItem | undefined, lectures: Lecture[]): Lecture | undefined {
  if (!item) return undefined;
  return lectures.find(lecture => lecture.id === item.lectureId && lecture.revision === item.revision && canListen(lecture));
}
/** Skip deleted, cancelled and stale snapshot members, without adding newly completed tracks. */
export function nextBatch(batch: Batch, lectures: Lecture[]): {batch?: Batch; lecture?: Lecture} {
  for (let cursor = batch.cursor + 1; cursor < batch.items.length; cursor++) {
    const lecture = batchLecture(batch.items[cursor], lectures);
    if (lecture) return {batch: {...batch, cursor}, lecture};
  }
  return {};
}
export function addToBatch(batch: Batch, lecture: Lecture): Batch {
  if (!canListen(lecture) || batch.items.some(item => item.lectureId === lecture.id && item.revision === lecture.revision)) return batch;
  return {...batch, items: [...batch.items, {lectureId: lecture.id, revision: lecture.revision}]};
}
export function safeSavedUi(value: unknown): SavedUi {
  if (!value || typeof value !== 'object') return {};
  const input = value as Record<string, unknown>, result: SavedUi = {};
  const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id);
  if (validId(input.activeId)) result.activeId = input.activeId;
  if (input.step === 'find' || input.step === 'prepare' || input.step === 'listen') result.step = input.step;
  if (input.batch && typeof input.batch === 'object') {
    const batch = input.batch as Batch;
    if (Array.isArray(batch.items) && batch.items.length > 0 && batch.items.length <= 100 && Number.isInteger(batch.cursor) && batch.cursor >= 0 && batch.cursor < batch.items.length && batch.items.every(item => item && validId(item.lectureId) && Number.isSafeInteger(item.revision) && item.revision > 0)) {
      result.batch = {items: batch.items.map(item => ({lectureId: item.lectureId, revision: item.revision})), cursor: batch.cursor};
    }
  }
  return result;
}
/** Do not override controls, editable descendants, composition, modifiers or screen-reader commands. */
export function shortcutAction(event: Pick<KeyboardEvent, 'key' | 'target' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat' | 'isComposing' | 'defaultPrevented'>): 'stop' | 'toggle' | undefined {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat) return undefined;
  if (event.key === 'Escape') return 'stop';
  if (event.key !== ' ' || isEditableTarget(event.target)) return undefined;
  return 'toggle';
}
export function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as Element | null;
  return typeof element?.closest === 'function' && Boolean(element.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],button,a,audio,video,summary,[role="button"],[role="slider"]'));
}
export function canResume(point: ResumePoint | undefined, lecture: Lecture): boolean {
  return Boolean(point && point.lectureId === lecture.id && point.revision === lecture.revision && canListen(lecture) && currentChunks(lecture).some(chunk => chunk.segmentId === point.segmentId));
}
export function timeLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(Number.isFinite(milliseconds) ? milliseconds / 1000 : 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function timelineProblems(timeline: TimelineEntry[], duration: number): string[] {
  if (!Number.isFinite(duration) || duration <= 0) return ['Choose a readable source recording before reviewing the timeline.'];
  return timelineErrors(timeline.map(entry => ({...entry, alignment: 'user_confirmed'})), duration);
}
/** List and mutation responses intentionally contain compact, byte-less source metadata. */
export function mergeLectureSummary(summary: Lecture, previous?: Lecture): Lecture {
  if (!summary.bundle || !previous?.bundle || previous.id !== summary.id || previous.revision !== summary.revision) return summary;
  const previousAssets = new Map(previous.bundle.assets.map(asset => [asset.id, asset]));
  return {...summary, bundle: {...summary.bundle, assets: summary.bundle.assets.map(asset => {
    const old = previousAssets.get(asset.id);
    return !asset.base64 && old?.base64 && old.sha256 === asset.sha256 ? {...asset, base64: old.base64} : asset;
  })}};
}
export function hasSourceBytes(lecture: Lecture): boolean {
  return !lecture.bundle || lecture.bundle.assets.every(asset => asset.base64.length > 0);
}
