import { BundleSchema, parseVtt, validateBundle, type Bundle } from '../../packages/core/index.js';
import { verifyAsset, inspectAssetBytes } from '../../packages/core/node-assets.js';
import { ApiError } from './types.js';

const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
const executable = /<!doctype\s+html|<\s*\/?\s*(?:script|html|iframe|object|embed|svg|head|body|form|input|meta|link)\b|\bon(?:load|error)\s*=/i;
export async function normalizeBundle(value: unknown): Promise<Bundle> {
  const parsed = BundleSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'INVALID_BUNDLE', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 1800));
  const bundle = parsed.data;
  const approximateBytes = bundle.assets.reduce((sum, asset) => sum + asset.base64.length * 3 / 4, 0);
  if (approximateBytes > MAX_BUNDLE_BYTES + bundle.assets.length * 2) throw new ApiError(413, 'BUNDLE_TOO_LARGE', 'Selected source bytes exceed the 50 MB bundle limit.');
  let totalBytes = 0;
  let pixels = 0;
  const pageCounts = new Map<string, number>();
  for (let index = 0; index < bundle.assets.length; index++) {
    try { bundle.assets[index] = await verifyAsset(bundle.assets[index]); }
    catch { throw new ApiError(400, 'INVALID_ASSET', `Asset ${index + 1} is invalid, unsupported, corrupt, or exceeds the decoded-resource limits. Reimport a valid PNG/JPEG, PDF, WAV/MP3, or VTT file.`); }
    const asset = bundle.assets[index];
    totalBytes += Buffer.from(asset.base64, 'base64').length;
    if (asset.width && asset.height) pixels += asset.width * asset.height;
    if (asset.mime === 'application/pdf') pageCounts.set(asset.id, (await inspectAssetBytes(Buffer.from(asset.base64, 'base64'), asset.mime)).pageCount!);
  }
  for (const entry of bundle.timeline) if (pageCounts.has(entry.assetId) && (!entry.page || entry.page > pageCounts.get(entry.assetId)!)) throw new ApiError(400, 'PDF_PAGE_RANGE', 'A selected PDF page is outside the actual document.');
  if (totalBytes > MAX_BUNDLE_BYTES) throw new ApiError(413, 'BUNDLE_TOO_LARGE', 'Selected source bytes exceed the 50 MB bundle limit.');
  if (pixels > 24_000_000) throw new ApiError(400, 'PIXEL_LIMIT', 'Selected images exceed the 24 million decoded pixel bundle limit.');
  const sourceAudio = bundle.assets.find(asset => asset.id === bundle.audioAssetId);
  if (!sourceAudio?.durationMs || !sourceAudio.mime.startsWith('audio/')) throw new ApiError(400, 'INVALID_AUDIO', 'Select a valid WAV or MP3 source audio file.');
  if (bundle.transcriptAssetId) {
    const transcript = bundle.assets.find(asset => asset.id === bundle.transcriptAssetId);
    if (!transcript || transcript.mime !== 'text/vtt') throw new ApiError(400, 'TIMED_CAPTIONS_REQUIRED', 'Timed VTT captions are required; plain text cannot establish accurate timestamps.');
    let cues;
    try { cues = parseVtt(Buffer.from(transcript.base64, 'base64').toString('utf8'), sourceAudio.durationMs); }
    catch { throw new ApiError(400, 'INVALID_VTT', 'Supplied VTT captions have invalid syntax, overlap, or extend beyond the actual audio duration.'); }
    if (bundle.cues.length && JSON.stringify(bundle.cues) !== JSON.stringify(cues)) throw new ApiError(400, 'CAPTION_MISMATCH', 'Transcript cues differ from the selected VTT bytes. Import the corrected VTT, or remove that asset selection before editing cues.');
    bundle.cues = cues;
  }
  for (const context of bundle.context ?? []) if (executable.test(context.text)) throw new ApiError(400, 'EXECUTABLE_MARKUP', 'Executable HTML is not a supported course context. Import plain text.');
  if (bundle.capture) {
    if (executable.test(bundle.capture.text)) throw new ApiError(400, 'EXECUTABLE_MARKUP', 'Captured executable HTML is not accepted. Capture visible plain text only.');
    try {
      const identity = new URL(bundle.capture.pageIdentity);
      if (!['http:', 'https:'].includes(identity.protocol) || identity.username || identity.password) throw new Error('Unsupported identity');
      // Private navigation parameters are never persisted/exported or sent onward as provenance.
      bundle.capture.pageIdentity = `${identity.origin}${identity.pathname}`;
    } catch {
      if (/^[a-z]+:|[?&#]/i.test(bundle.capture.pageIdentity)) throw new ApiError(400, 'PRIVATE_SOURCE_IDENTITY', 'Use a redacted source page identity without credentials, query parameters, or fragments.');
    }
  }
  const errors = validateBundle(bundle, { allowMissingTranscript: true, allowIncompleteTimeline: true });
  if (errors.length) throw new ApiError(400, 'INVALID_BUNDLE', errors.join('; ').slice(0, 1800));
  return bundle;
}
