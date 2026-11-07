import { BundleSchema, LIMITS, assetByteLimit, base64ByteLength, schemaErrors, type Bundle, type Cue, type TimelineEntry } from './schemas';

export class InputValidationError extends Error {
  constructor(message: string, public readonly code = 'INVALID_INPUT') { super(message); this.name = 'InputValidationError'; }
}

/** Strict supported WebVTT subset: cue IDs, times, safe styling, NOTE and positioning. */
export function parseVtt(input: string, durationMs: number = LIMITS.maxAudioDurationMs): Cue[] {
  if (typeof input !== 'string' || input.length > LIMITS.maxTranscriptBytes || new TextEncoder().encode(input).byteLength > LIMITS.maxTranscriptBytes) throw new InputValidationError('VTT exceeds the transcript byte limit');
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > LIMITS.maxAudioDurationMs) throw new InputValidationError('Invalid source audio duration');
  const source = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (source.includes('\0')) throw new InputValidationError('VTT contains NUL');
  const lines = source.split('\n');
  if (!/^WEBVTT(?:[ \t][^\n]*)?$/.test(lines[0] ?? '') || lines[0].includes('-->')) throw new InputValidationError('VTT must begin with WEBVTT');
  let cursor = 1;
  if (lines[cursor]?.trim()) throw new InputValidationError('VTT header must be followed by a blank line; metadata headers are unsupported');
  const cues: Cue[] = [];
  const used = new Set<string>();
  while (cursor < lines.length) {
    while (cursor < lines.length && !lines[cursor].trim()) cursor++;
    if (cursor >= lines.length) break;
    const block: string[] = [];
    while (cursor < lines.length && lines[cursor].trim()) block.push(lines[cursor++]);
    if (/^NOTE(?:[ \t]|$)/.test(block[0])) continue;
    if (/^(?:STYLE|REGION)(?:[ \t]|$)/.test(block[0])) throw new InputValidationError('VTT STYLE and REGION blocks are unsupported');
    let id: string;
    if (block[0].includes('-->')) {
      id = `C${cues.length + 1}`;
      let suffix = 1;
      while (used.has(id)) id = `C${cues.length + 1}_${suffix++}`;
    } else {
      id = block.shift()!;
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) throw new InputValidationError('VTT cue IDs must be bounded opaque IDs');
    }
    if (used.has(id)) throw new InputValidationError(`Duplicate VTT cue ID ${id}`);
    const timing = block.shift() ?? '';
    const match = /^((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})[ \t]+-->[ \t]+((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})(?:[ \t]+(.*))?$/.exec(timing);
    if (!match) throw new InputValidationError(`Malformed VTT timing for ${id}`);
    if (match[3]) validateCueSettings(match[3]);
    const startMs = parseTimestamp(match[1]);
    const endMs = parseTimestamp(match[2]);
    if (startMs >= endMs || endMs > durationMs) throw new InputValidationError(`VTT cue ${id} is outside audio duration or has no duration`);
    if (cues.length && startMs < cues[cues.length - 1].endMs) throw new InputValidationError(`VTT cue ${id} overlaps or is out of order`);
    const text = cleanCueText(block.join('\n'));
    if (!text.trim() || text.length > 16_000) throw new InputValidationError(`VTT cue ${id} is empty or too long`);
    cues.push({ id, startMs, endMs, text });
    used.add(id);
    if (cues.length > LIMITS.maxCues) throw new InputValidationError('VTT exceeds 30 cues; it was not truncated');
  }
  if (!cues.length) throw new InputValidationError('VTT contains no cues');
  return cues;
}

function parseTimestamp(value: string): number {
  const parts = value.split(':');
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop());
  const hours = parts.length ? Number(parts.pop()) : 0;
  if (seconds >= 60 || minutes >= 60 || !Number.isSafeInteger(hours)) throw new InputValidationError('VTT timestamps require valid hours, minutes and seconds');
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

function validateCueSettings(settings: string): void {
  const seen = new Set<string>();
  for (const item of settings.split(/[ \t]+/)) {
    const name = item.split(':')[0];
    if (seen.has(name)) throw new InputValidationError('Duplicate VTT cue setting');
    seen.add(name);
    if ([...item.matchAll(/(\d+(?:\.\d+)?)%/g)].some(m => Number(m[1]) > 100)) throw new InputValidationError('VTT percentages must be within 0–100');
    if (!/^(?:align:(?:start|center|end|left|right)|vertical:(?:rl|lr)|size:(?:100|\d{1,2})(?:\.\d+)?%|position:(?:100|\d{1,2})(?:\.\d+)?%(?:,(?:line-left|center|line-right|auto))?|line:(?:auto|-?\d+|(?:100|\d{1,2})(?:\.\d+)?%)(?:,(?:start|center|end))?)$/.test(item)) throw new InputValidationError('Unsupported VTT cue setting');
  }
}

function cleanCueText(value: string): string {
  const stack: string[] = [];
  const clean = value.replace(/<[^>]*>/g, tag => {
    const open = /^<(b|i|u|ruby|rt|c)(?:\.[A-Za-z0-9_-]+)*>$/.exec(tag) ?? /^<(v|lang)(?:[ \t]+[^<>]+)?>$/.exec(tag);
    const close = /^<\/(b|i|u|ruby|rt|c|v|lang)>$/.exec(tag);
    if (open) { stack.push(open[1]); return ''; }
    if (close && stack.pop() === close[1]) return '';
    throw new InputValidationError('Unsupported or unbalanced VTT markup; executable HTML and inline timestamps are not accepted');
  });
  if (stack.length || /[<>]/.test(clean)) throw new InputValidationError('Malformed VTT markup');
  return clean.replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', nbsp: ' ', lrm: '‎', rlm: '‏' }[name]!));
}

/** Half-open intervals, except that querying the final endpoint returns the final state. */
export function statesAt(timeline: readonly TimelineEntry[], time: number): TimelineEntry[] {
  if (!Number.isFinite(time) || time < 0 || !timeline.length) return [];
  const final = Math.max(...timeline.map(entry => entry.endMs));
  return timeline.filter(entry => entry.startMs <= time && (time < entry.endMs || (time === final && entry.endMs === final)));
}

export function intervalsOverlap(a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

export function timelineErrors(timeline: readonly TimelineEntry[], durationMs: number): string[] {
  const errors: string[] = [];
  const occurrences = new Set<string>();
  const states = new Map<string, TimelineEntry>();
  for (const entry of timeline) {
    if (occurrences.has(entry.id)) errors.push(`Duplicate timeline occurrence ${entry.id}`);
    occurrences.add(entry.id);
    const prior = states.get(entry.stateId);
    if (prior && (prior.assetId !== entry.assetId || prior.page !== entry.page || prior.build !== entry.build)) errors.push(`Visual state ${entry.stateId} changes identity; use a distinct state ID for a different image/build`);
    states.set(entry.stateId, entry);
    if (entry.startMs < 0 || entry.endMs <= entry.startMs || entry.endMs > durationMs) errors.push(`Timeline occurrence ${entry.id} is outside source audio bounds`);
    if (entry.alignment === 'suggested') errors.push(`Timeline occurrence ${entry.id} needs user-confirmed alignment`);
  }
  if (states.size > LIMITS.maxVisualStates) errors.push('More than six distinct visual states');
  const sorted = [...timeline].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  let end = 0;
  for (const entry of sorted) {
    if (entry.startMs > end) errors.push(`Visual alignment gap ${end}–${entry.startMs} ms`);
    if (entry.startMs < end) errors.push(`Conflicting visual overlap at ${entry.startMs} ms; simultaneous views are unsupported without explicit review`);
    end = Math.max(end, entry.endMs);
  }
  if (end < durationMs) errors.push(`Visual alignment gap ${end}–${durationMs} ms`);
  return errors;
}

export interface BundleValidationOptions {
  /** Draft/STT ingestion only: strict compilation always requires timed cues. */
  allowMissingTranscript?: boolean;
  /** Draft timeline editing only: no gap, overlap, or suggestion is compile-ready. */
  allowIncompleteTimeline?: boolean;
}

export function validateBundle(value: Bundle | unknown, options: BundleValidationOptions = {}): string[] {
  const parsed = BundleSchema.safeParse(value);
  if (!parsed.success) return schemaErrors(parsed.error, 'bundle');
  const bundle = parsed.data;
  const errors: string[] = [];
  const assets = new Map<string, typeof bundle.assets[number]>();
  let totalBytes = 0;
  let totalPixels = 0;
  for (const asset of bundle.assets) {
    if (assets.has(asset.id)) errors.push(`Duplicate asset ID ${asset.id}`);
    assets.set(asset.id, asset);
    totalBytes += base64ByteLength(asset.base64);
    if (asset.width && asset.height) totalPixels += asset.width * asset.height;
  }
  if (totalBytes > LIMITS.maxBundleBytes) errors.push('Selected source bundle exceeds 50 MB');
  if (totalPixels > LIMITS.maxBundlePixels) errors.push('Selected bundle exceeds 24 million decoded pixels');
  const audio = assets.get(bundle.audioAssetId);
  if (!audio || !audio.mime.startsWith('audio/')) errors.push('audioAssetId must reference a supported source audio asset');
  if (!audio?.durationMs) errors.push('Source audio needs a verified duration; supplied metadata alone is not authoritative');
  const duration = audio?.durationMs ?? LIMITS.maxAudioDurationMs;
  if (!bundle.cues.length && !options.allowMissingTranscript) errors.push('Missing timed transcript cues; separately consented transcription or supplied captions are required before compilation');
  const cues = new Set<string>();
  let previousEnd = -1;
  for (const cue of bundle.cues) {
    if (cues.has(cue.id)) errors.push(`Duplicate cue ID ${cue.id}`);
    cues.add(cue.id);
    if (cue.startMs < previousEnd) errors.push(`Cue ${cue.id} is overlapping or out of order`);
    if (cue.endMs > duration) errors.push(`Cue ${cue.id} extends beyond source audio`);
    previousEnd = cue.endMs;
  }
  if (bundle.transcriptAssetId) {
    const transcript = assets.get(bundle.transcriptAssetId);
    if (!transcript || !['text/vtt', 'text/plain'].includes(transcript.mime)) errors.push('transcriptAssetId must reference a supplied transcript');
  }
  const contexts = new Set<string>();
  for (const document of bundle.context ?? []) {
    if (contexts.has(document.id)) errors.push(`Duplicate context ID ${document.id}`);
    contexts.add(document.id);
  }
  const textLength = bundle.cues.reduce((n, cue) => n + cue.text.length, 0) + (bundle.context ?? []).reduce((n, document) => n + document.text.length, 0) + (bundle.capture?.text.length ?? 0);
  if (textLength > LIMITS.maxTextChars) errors.push('Selected source text exceeds the bounded text limit');
  const usedVisualAssets = new Set<string>();
  for (const entry of bundle.timeline) {
    const asset = assets.get(entry.assetId);
    if (!asset || !['image/png', 'image/jpeg', 'application/pdf'].includes(asset.mime)) errors.push(`Timeline ${entry.id} references a missing or nonvisual asset`);
    if (asset?.mime === 'application/pdf' && !entry.page) errors.push(`PDF timeline ${entry.id} requires an explicitly selected page`);
    if (asset?.mime !== 'application/pdf' && entry.page !== undefined) errors.push(`Image timeline ${entry.id} must not claim a PDF page`);
    if (asset?.mime.startsWith('image/') && (!asset.width || !asset.height)) errors.push(`Image ${entry.assetId} needs verified dimensions`);
    usedVisualAssets.add(entry.assetId);
  }
  // PDF render dimensions/page counts are checked in the trusted decoder, never inferred here.
  const pdfPages = new Set(bundle.timeline.filter(e => assets.get(e.assetId)?.mime === 'application/pdf').map(e => `${e.assetId}:${e.page}`));
  if (pdfPages.size > LIMITS.maxVisualStates) errors.push('More than six selected PDF pages');
  const temporalErrors = timelineErrors(bundle.timeline, duration);
  errors.push(...(options.allowIncompleteTimeline ? temporalErrors.filter(e => !/Visual alignment gap|needs user-confirmed alignment/.test(e)) : temporalErrors));
  if (totalBytes <= LIMITS.maxBundleBytes) {
    for (const asset of bundle.assets) {
      try {
        const header = inspectAssetHeader(decodeBase64(asset.base64), asset.mime);
        if (header.width && (header.width !== asset.width || header.height !== asset.height)) errors.push(`Asset ${asset.id}: supplied dimensions do not match its actual header`);
      } catch (e) { errors.push(`Asset ${asset.id}: ${e instanceof Error ? e.message : 'invalid asset bytes'}`); }
    }
  }
  return [...new Set(errors)];
}

export function uniqueIds(items: { id: string }[], label: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) errors.push(`${label}: duplicate ID ${item.id}`);
    seen.add(item.id);
  }
}

/** Bounded canonical decoding shared with the trusted server. No Node imports. */
export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  if (base64ByteLength(value) < 1 || value.length > Math.ceil(LIMITS.maxAudioBytes / 3) * 4) throw new InputValidationError('Invalid, empty, or oversized canonical base64');
  const binary = atob(value);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

export function checkDimensions(width: number, height: number): { width: number; height: number } {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > LIMITS.maxImageDimension || height > LIMITS.maxImageDimension || width * height > LIMITS.maxImagePixels) throw new InputValidationError('Image dimensions exceed decoded-resource limits');
  return { width, height };
}

/** Fast signature/header checks only. A valid header does not establish complete decodability. */
export function inspectAssetHeader(bytes: Uint8Array, mime: string): { width?: number; height?: number } {
  if (!bytes.length || bytes.length > assetByteLimit(mime)) throw new InputValidationError('Empty or oversized asset bytes');
  const ascii = (offset: number, count: number) => String.fromCharCode(...bytes.subarray(offset, offset + count));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'image/png') {
    if (bytes.length < 33 || ascii(0, 8) !== '\x89PNG\r\n\x1a\n' || view.getUint32(8) !== 13 || ascii(12, 4) !== 'IHDR') throw new InputValidationError('PNG MIME/signature mismatch or truncated header');
    return checkDimensions(view.getUint32(16), view.getUint32(20));
  }
  if (mime === 'image/jpeg') {
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) throw new InputValidationError('JPEG MIME/signature mismatch');
    let pos = 2;
    while (pos + 3 < bytes.length) {
      if (bytes[pos++] !== 255) throw new InputValidationError('Malformed JPEG marker');
      while (bytes[pos] === 255) pos++;
      const marker = bytes[pos++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (pos + 2 > bytes.length) break;
      const length = view.getUint16(pos);
      if (length < 2 || pos + length > bytes.length) throw new InputValidationError('Truncated JPEG segment');
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        if (length < 8) throw new InputValidationError('Malformed JPEG frame dimensions');
        return checkDimensions(view.getUint16(pos + 5), view.getUint16(pos + 3));
      }
      pos += length;
    }
    throw new InputValidationError('Unreadable JPEG dimensions');
  }
  if (mime === 'application/pdf') {
    if (!/^%PDF-(?:1\.[0-7]|2\.0)/.test(ascii(0, 8))) throw new InputValidationError('PDF MIME/signature mismatch');
  } else if (mime === 'audio/wav' || mime === 'audio/x-wav') {
    if (bytes.length < 44 || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') throw new InputValidationError('WAV MIME/signature mismatch');
  } else if (mime === 'audio/mpeg' || mime === 'audio/mp3') {
    if (bytes.length < 4 || !(ascii(0, 3) === 'ID3' || bytes[0] === 255 && (bytes[1] & 224) === 224)) throw new InputValidationError('MP3 MIME/signature mismatch');
  } else if (mime === 'text/vtt' || mime === 'text/plain') {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new InputValidationError('Transcript bytes must be UTF-8 text'); }
    if (text.includes('\0') || /^\s*(?:<!doctype\s+html|<html|<head|<body|<script|<\?xml)/i.test(text)) throw new InputValidationError('HTML or binary data is not a transcript');
    if (mime === 'text/vtt') parseVtt(text);
    else if (!text.trim()) throw new InputValidationError('Transcript text is empty');
  } else throw new InputValidationError('Unsupported asset MIME');
  return {};
}

/** Review flags, not automatic lexical rejection or an accessibility certificate. */
export function visualReferenceWarnings(text: string): string[] {
  const matches = text.match(/\b(?:as you can see|this (?:one|curve|line|point)|over here|shown (?:here|above|below)|the (?:red|blue|purple) one)\b/gi) ?? [];
  return [...new Set(matches)].map(term => `Contextual review: “${term}” may need an explained referent`);
}
