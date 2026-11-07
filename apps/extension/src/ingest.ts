import { assetByteLimit, base64ByteLength, decodeBase64, inspectAssetHeader, parseVtt, type Asset } from '../../../packages/core/index';

export const LIMITS = {audio: 25 * 1024 * 1024, transcript: 1024 * 1024, visual: 5 * 1024 * 1024, bundle: 50 * 1024 * 1024, pixels: 8_000_000, bundlePixels: 24_000_000};
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x4000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x4000));
  return btoa(binary);
}
export function base64Bytes(text: string): Uint8Array<ArrayBuffer> { return decodeBase64(text); }
export function byteSize(asset: Asset): number { return Math.max(0, base64ByteLength(asset.base64)); }
function ascii(bytes: Uint8Array, start: number, length: number) { return String.fromCharCode(...bytes.subarray(start, start + length)); }
export function detectMime(bytes: Uint8Array): Asset['mime'] {
  if (bytes[0] === 137 && ascii(bytes, 1, 3) === 'PNG') return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (bytes.length <= LIMITS.transcript) {
    const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    if (/^﻿?WEBVTT(?:[ \t].*)?(?:\r?\n)/.test(text)) return 'text/vtt';
  }
  throw new Error('Unsupported file. Use WAV, MP3, WEBVTT, PNG, JPEG or PDF; a filename alone is not evidence of its type. Plain text is not timed captions.');
}
export function imageDimensions(bytes: Uint8Array, mime: string): {width: number; height: number} {
  const dimensions = inspectAssetHeader(bytes, mime);
  if (!dimensions.width || !dimensions.height) throw new Error('Image dimensions could not be read.');
  return {width: dimensions.width, height: dimensions.height};
}
export function validateSelection(assets: Asset[]): void {
  if (assets.length > 40) throw new Error('Use at most 40 selected source files.');
  let bytes = 0, pixels = 0;
  const ids = new Set<string>();
  for (const asset of assets) {
    const size = base64ByteLength(asset.base64);
    if (size < 1 || size > assetByteLimit(asset.mime)) throw new Error(`“${asset.name}” is empty, invalid or over its source-type byte limit. Reload complete source bytes before saving.`);
    if (ids.has(asset.id)) throw new Error('A selected asset ID is duplicated. Reimport that source.');
    ids.add(asset.id); bytes += size;
    if (asset.mime.startsWith('image/')) {
      if (!asset.width || !asset.height || asset.width > 4096 || asset.height > 4096 || asset.width * asset.height > LIMITS.pixels) throw new Error('Each image must be at most 4096 × 4096 and 8 million decoded pixels.');
      pixels += asset.width * asset.height;
    }
  }
  if (bytes > LIMITS.bundle) throw new Error('The selected source bundle exceeds 50 MB. Remove an asset before adding more.');
  if (assets.filter(a => a.mime.startsWith('image/')).length > 6) throw new Error('Use at most six distinct visual images. Reuse an earlier image in the timeline instead.');
  if (pixels > LIMITS.bundlePixels) throw new Error('Selected images exceed 24 million decoded pixels in total.');
}
export function checkImportBudget(existing: Asset[], files: {size: number}[], pendingPdfBytes = 0): void {
  if (files.length > 10 || files.some(file => !Number.isSafeInteger(file.size) || file.size < 1 || file.size > LIMITS.audio)) throw new Error('Choose at most ten nonempty supported files. No individual source may exceed 25 MB.');
  if (existing.reduce((sum, asset) => sum + byteSize(asset), pendingPdfBytes) + files.reduce((sum, file) => sum + file.size, 0) > LIMITS.bundle) throw new Error('This import would exceed the 50 MB aggregate source and temporary-byte limit. Remove a source or choose fewer files.');
}
export async function assetFromFile(file: File): Promise<Asset> {
  if (!file.size || file.size > LIMITS.audio) throw new Error('Empty files are not supported. Source audio must be at most 25 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = detectMime(bytes);
  if (file.size > assetByteLimit(mime)) throw new Error(`“${file.name}” exceeds the ${Math.round(assetByteLimit(mime) / 1024 / 1024)} MB limit for this type.`);
  const aliases: Record<string, string> = {'audio/x-wav':'audio/wav','audio/wave':'audio/wav','audio/mp3':'audio/mpeg','image/jpg':'image/jpeg'};
  const suppliedMime = file.type.toLowerCase();
  if (suppliedMime && suppliedMime !== 'application/octet-stream' && !(suppliedMime === 'text/plain' && mime === 'text/vtt') && (aliases[suppliedMime] ?? suppliedMime) !== mime) throw new Error(`“${file.name}” has a mismatched declared type and file signature.`);
  const dimensions = inspectAssetHeader(bytes, mime);
  if (mime === 'text/vtt') parseVtt(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  const durationMs = mime.startsWith('audio/') ? await audioDuration(new Blob([bytes], {type: mime})) : undefined;
  return {id: `asset-${crypto.randomUUID()}`, name: file.name.slice(0, 200), mime, base64: bytesToBase64(bytes), acquisition: 'manual_import', ...dimensions, ...(durationMs ? {durationMs} : {})};
}
export async function normaliseCapturedAsset(asset: Asset): Promise<Asset> {
  const bytes = base64Bytes(asset.base64), mime = detectMime(bytes);
  if (mime !== asset.mime && !(mime === 'text/vtt' && asset.mime === 'text/plain') && !(mime === 'audio/wav' && asset.mime === 'audio/x-wav')) throw new Error('Captured resource type does not match its bytes. Use a directly downloadable file.');
  const dimensions = inspectAssetHeader(bytes, mime);
  return {...asset, mime, ...dimensions};
}
export function audioDuration(blob: Blob, factory: () => HTMLAudioElement = () => new Audio()): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = factory(), url = URL.createObjectURL(blob);
    let settled = false;
    const finish = (error?: Error, duration?: number) => {
      if (settled) return; settled = true;
      clearTimeout(timer); audio.onloadedmetadata = null; audio.onerror = null;
      audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url);
      if (error) reject(error); else resolve(duration!);
    };
    const timer = setTimeout(() => finish(new Error('Audio metadata could not be read within 10 seconds.')), 10_000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const duration = Math.round(audio.duration * 1000);
      if (!Number.isFinite(duration) || duration <= 0 || duration > 180_000) finish(new Error('Source audio must have a readable duration of at most 180 seconds.'));
      else finish(undefined, duration);
    };
    audio.onerror = () => finish(new Error('This browser cannot decode the source audio. Use a valid WAV or MP3.'));
    audio.src = url;
  });
}
