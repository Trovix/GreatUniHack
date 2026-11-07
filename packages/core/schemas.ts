import { z } from 'zod';

/** Prototype limits, not provider limits. All sizes refer to decoded source bytes. */
export const LIMITS = Object.freeze({
  maxAudioDurationMs: 180_000,
  maxAudioBytes: 25 * 1024 * 1024,
  maxVisualBytes: 5 * 1024 * 1024,
  maxTranscriptBytes: 1024 * 1024,
  maxBundleBytes: 50 * 1024 * 1024,
  maxImageDimension: 4096,
  maxImagePixels: 8_000_000,
  maxBundlePixels: 24_000_000,
  maxPdfPages: 50,
  maxVisualStates: 6,
  maxCues: 30,
  maxTimelineEntries: 60,
  maxAssets: 40,
  maxTextChars: 200_000,
  maxOutputChars: 80_000,
  assetTimeoutMs: 10_000,
});

export const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, 'Use a bounded opaque ID without path separators');
const text = (max = 16_000) => z.string().min(1).max(max).refine(v => v.trim().length > 0 && !v.includes('\0'), 'Text must not be empty or contain NUL');
const milliseconds = z.number().finite().int().nonnegative().max(LIMITS.maxAudioDurationMs);
const ids = (max = 256) => z.array(IdSchema).max(max).refine(v => new Set(v).size === v.length, 'Duplicate reference IDs');
export const AcquisitionSchema = z.enum(['browser_capture', 'manual_import', 'synthetic_demo']);
export const AssetMimeSchema = z.enum(['image/png', 'image/jpeg', 'application/pdf', 'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'text/vtt', 'text/plain']);

export function base64ByteLength(value: string): number {
  // A repeated-group base64 regex can overflow the JS regexp stack on legitimate
  // megabyte files. Flat scanning remains linear and bounded by the caller's cap.
  if (!value || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) return -1;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.indexOf('=') !== (padding ? value.length - padding : -1)) return -1;
  // Reject non-canonical trailing bits, too; byte hashes must not depend on spelling.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (padding === 2 && (alphabet.indexOf(value[value.length - 3]) & 15) !== 0) return -1;
  if (padding === 1 && (alphabet.indexOf(value[value.length - 2]) & 3) !== 0) return -1;
  return value.length / 4 * 3 - padding;
}

export function assetByteLimit(mime: string): number {
  if (mime.startsWith('audio/')) return LIMITS.maxAudioBytes;
  if (mime.startsWith('text/')) return LIMITS.maxTranscriptBytes;
  return LIMITS.maxVisualBytes;
}

export const AssetSchema = z.object({
  id: IdSchema,
  name: text(255),
  mime: AssetMimeSchema,
  base64: z.string().min(4).max(Math.ceil(LIMITS.maxAudioBytes / 3) * 4),
  acquisition: AcquisitionSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  durationMs: z.number().finite().positive().max(LIMITS.maxAudioDurationMs).optional(),
  width: z.number().int().positive().max(LIMITS.maxImageDimension).optional(),
  height: z.number().int().positive().max(LIMITS.maxImageDimension).optional(),
}).strict().superRefine((asset, ctx) => {
  const bytes = base64ByteLength(asset.base64);
  if (bytes < 1) ctx.addIssue({ code: 'custom', path: ['base64'], message: 'Empty or invalid canonical base64' });
  if (bytes > assetByteLimit(asset.mime)) ctx.addIssue({ code: 'custom', path: ['base64'], message: 'Asset exceeds its byte limit' });
  if ((asset.width === undefined) !== (asset.height === undefined)) ctx.addIssue({ code: 'custom', message: 'Image width and height must be supplied together' });
  if (asset.width && asset.height && asset.width * asset.height > LIMITS.maxImagePixels) ctx.addIssue({ code: 'custom', message: 'Image exceeds the decoded pixel limit' });
});
export type Asset = z.infer<typeof AssetSchema>;

export const CueSchema = z.object({ id: IdSchema, startMs: milliseconds, endMs: milliseconds, text: text() }).strict()
  .refine(v => v.endMs > v.startMs, 'Cue must have a positive duration');
export type Cue = z.infer<typeof CueSchema>;
export const AlignmentSchema = z.enum(['user_confirmed', 'provided_fixture', 'suggested']);
export const TimelineEntrySchema = z.object({
  id: IdSchema, stateId: IdSchema, assetId: IdSchema,
  startMs: milliseconds, endMs: milliseconds, alignment: AlignmentSchema,
  page: z.number().int().positive().max(LIMITS.maxPdfPages).optional(), build: text(200).optional(),
}).strict().refine(v => v.endMs > v.startMs, 'Timeline occurrence must have a positive duration');
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;
export const ContextSchema = z.object({ id: IdSchema, text: text(50_000) }).strict();
export const CaptureSchema = z.object({
  courseTitle: text(500), pageIdentity: text(1000), capturedAt: z.string().datetime({ offset: true }),
  text: text(LIMITS.maxTextChars), acquisition: AcquisitionSchema,
}).strict();
export const BundleSchema = z.object({
  title: text(500), assets: z.array(AssetSchema).min(1).max(LIMITS.maxAssets), audioAssetId: IdSchema,
  // Empty cues/timeline are structurally valid drafts, never compilation-ready by default.
  transcriptAssetId: IdSchema.optional(), cues: z.array(CueSchema).max(LIMITS.maxCues),
  timeline: z.array(TimelineEntrySchema).max(LIMITS.maxTimelineEntries),
  context: z.array(ContextSchema).max(12).optional(), capture: CaptureSchema.optional(),
}).strict();
export type Bundle = z.infer<typeof BundleSchema>;

export const RegionSchema = z.object({
  x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1),
  w: z.number().finite().positive().max(1), h: z.number().finite().positive().max(1),
}).strict().refine(r => r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9, 'Crop extends outside the image');
export const EvidenceSchema = z.discriminatedUnion('kind', [
  z.object({ id: IdSchema, kind: z.literal('speech'), cueId: IdSchema, quote: text(), sourceStartMs: milliseconds, sourceEndMs: milliseconds }).strict(),
  z.object({ id: IdSchema, kind: z.literal('visual'), stateId: IdSchema, region: RegionSchema.optional(), observation: text(), extractedText: text().optional() }).strict(),
  z.object({ id: IdSchema, kind: z.literal('context'), documentId: IdSchema, quote: text(50_000) }).strict(),
]);
export type Evidence = z.infer<typeof EvidenceSchema>;
export const DependencySchema = z.object({
  id: IdSchema, cueIds: ids(LIMITS.maxCues), stateIds: ids(LIMITS.maxVisualStates),
  kind: z.enum(['deixis', 'spatial_relation', 'visual_change', 'notation', 'silent_content', 'sequence', 'other']),
  essential: z.boolean(), question: text(2000), evidenceIds: ids(),
  status: z.enum(['already_audible', 'resolved', 'unresolved', 'conflict']),
  resolution: text().optional(), uncertaintyReason: text().optional(),
}).strict();
export type Dependency = z.infer<typeof DependencySchema>;
export const ClaimSchema = z.object({
  id: IdSchema, meaning: text(), kind: z.enum(['lecturer_claim', 'visual_fact', 'context', 'uncertainty']),
  evidenceIds: ids(), dependencyIds: ids(128),
}).strict();
export type Claim = z.infer<typeof ClaimSchema>;
export const SourceRangeSchema = z.object({ startMs: milliseconds, endMs: milliseconds }).strict()
  .refine(r => r.endMs > r.startMs, 'Source range must have a positive duration');
export const NarrationSegmentSchema = z.object({
  id: IdSchema, text: text(12_000), claimIds: ids(), dependencyIds: ids(128),
  sourceRanges: z.array(SourceRangeSchema).min(1).max(60), stateIds: ids(LIMITS.maxVisualStates),
  status: z.enum(['supported', 'incomplete', 'conflict']),
}).strict();
export type NarrationSegment = z.infer<typeof NarrationSegmentSchema>;
export const CompilationSchema = z.object({
  inputRevision: z.number().int().positive(), providerMode: z.enum(['live', 'mock']),
  evidence: z.array(EvidenceSchema).min(1).max(256), dependencies: z.array(DependencySchema).max(128),
  claims: z.array(ClaimSchema).min(1).max(256), segments: z.array(NarrationSegmentSchema).min(1).max(60),
  unresolvedEssentialIds: ids(128), sourceReview: z.enum(['not_reviewed', 'developer_reviewed', 'user_reviewed']),
}).strict();
export type Compilation = z.infer<typeof CompilationSchema>;
export const QuestionAnswerSchema = z.object({
  text: text(12_000), evidenceIds: ids(), status: z.enum(['supported', 'limitation', 'conflict']),
}).strict();
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;

export function schemaErrors(error: z.ZodError, prefix = ''): string[] {
  return error.issues.map(issue => `${prefix}${issue.path.length ? '.' + issue.path.join('.') : ''}: ${issue.message}`);
}
