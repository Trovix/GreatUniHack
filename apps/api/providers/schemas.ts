import { z } from 'zod';

// OpenAI strict structured output requires every property, with null for optional values.
// Keep the public domain schema authoritative; the adapter additionally parses with it.
type JsonSchema = Record<string, unknown>;
const str: JsonSchema = { type: 'string' };
const num: JsonSchema = { type: 'number' };
const bool: JsonSchema = { type: 'boolean' };
const strings: JsonSchema = { type: 'array', items: str };
const en = (...values: string[]): JsonSchema => ({ type: 'string', enum: values });
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] });
const array = (items: JsonSchema): JsonSchema => ({ type: 'array', items });
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
const region = object({ x: num, y: num, w: num, h: num });
export const COMPILATION_WIRE_SCHEMA = object({
  inputRevision: { type: 'integer' },
  providerMode: en('live'),
  evidence: array({ anyOf: [
    object({ id: str, kind: en('speech'), cueId: str, quote: str, sourceStartMs: num, sourceEndMs: num }),
    object({ id: str, kind: en('visual'), stateId: str, region: nullable(region), observation: str, extractedText: nullable(str) }),
    object({ id: str, kind: en('context'), documentId: str, quote: str }),
  ] }),
  dependencies: array(object({
    id: str, cueIds: strings, stateIds: strings,
    kind: en('deixis', 'spatial_relation', 'visual_change', 'notation', 'silent_content', 'sequence', 'other'),
    essential: bool, question: str, evidenceIds: strings,
    status: en('already_audible', 'resolved', 'unresolved', 'conflict'),
    resolution: nullable(str), uncertaintyReason: nullable(str),
  })),
  claims: array(object({
    id: str, meaning: str, kind: en('lecturer_claim', 'visual_fact', 'context', 'uncertainty'),
    evidenceIds: strings, dependencyIds: strings,
  })),
  segments: array(object({
    id: str, text: str, claimIds: strings, dependencyIds: strings,
    sourceRanges: array(object({ startMs: num, endMs: num })),
    stateIds: strings, status: en('supported', 'incomplete', 'conflict'),
  })),
  unresolvedEssentialIds: strings,
  sourceReview: en('not_reviewed'),
});

export const AuditSchema = z.object({
  inputRevision: z.number().int().positive(),
  passed: z.boolean(),
  sourceReview: z.literal('not_reviewed'),
  checkedCueIds: z.array(z.string()).max(30),
  checkedStateIds: z.array(z.string()).max(6),
  issues: z.array(z.object({
    id: z.string().min(1).max(100),
    severity: z.enum(['critical', 'warning']),
    kind: z.enum(['omission', 'unsupported', 'referent', 'number_sign_unit', 'reasoning', 'premature_answer', 'uncertainty', 'other']),
    message: z.string().min(1).max(4000),
    cueIds: z.array(z.string()).max(30),
    stateIds: z.array(z.string()).max(6),
    segmentIds: z.array(z.string()).max(60),
    dependencyIds: z.array(z.string()).max(120),
  }).strict()).max(120),
  summary: z.string().min(1).max(8000),
}).strict();
export type SemanticAudit = z.infer<typeof AuditSchema>;
export const AUDIT_WIRE_SCHEMA = object({
  inputRevision: { type: 'integer' }, passed: bool, sourceReview: en('not_reviewed'),
  checkedCueIds: strings, checkedStateIds: strings,
  issues: array(object({
    id: str, severity: en('critical', 'warning'),
    kind: en('omission', 'unsupported', 'referent', 'number_sign_unit', 'reasoning', 'premature_answer', 'uncertainty', 'other'),
    message: str, cueIds: strings, stateIds: strings, segmentIds: strings, dependencyIds: strings,
  })), summary: str,
});

export function normalizeCompilationWire(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = structuredClone(value) as Record<string, unknown>;
  if (Array.isArray(result.evidence)) for (const item of result.evidence) {
    if (!item || typeof item !== 'object' || item.kind !== 'visual') continue;
    if (item.region === null) delete item.region;
    if (item.extractedText === null) delete item.extractedText;
  }
  if (Array.isArray(result.dependencies)) for (const item of result.dependencies) {
    if (!item || typeof item !== 'object') continue;
    if (item.resolution === null) delete item.resolution;
    if (item.uncertaintyReason === null) delete item.uncertaintyReason;
  }
  return result;
}

export const OUTPUT_IDS = {
  evidence: Array.from({ length: 180 }, (_, i) => `ev_${String(i + 1).padStart(3, '0')}`),
  dependencies: Array.from({ length: 120 }, (_, i) => `dep_${String(i + 1).padStart(3, '0')}`),
  claims: Array.from({ length: 180 }, (_, i) => `cl_${String(i + 1).padStart(3, '0')}`),
  segments: Array.from({ length: 60 }, (_, i) => `seg_${String(i + 1).padStart(3, '0')}`),
};
