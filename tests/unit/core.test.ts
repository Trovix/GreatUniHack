import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  AssetSchema, BundleSchema, CompilationSchema, LIMITS, base64ByteLength, locateQuote,
  numericConsistencyErrors, parseVtt, statesAt, timelineErrors, validateAnswer,
  validateBundle, validateCompilation, visualReferenceWarnings, type Bundle, type Compilation,
} from '../../packages/core/index.js';
import { inspectAssetBytes, verifyAsset } from '../../packages/core/node-assets.js';
import { pcm16Wav } from '../../apps/api/providers/audio.js';
import { loadFixture } from '../../scripts/fixtures.js';

let png: Buffer;
beforeAll(async () => { png = await sharp({ create: { width: 16, height: 12, channels: 3, background: 'white' } }).png().toBuffer(); });
function source(): Bundle {
  return { title: 'Authored local test', audioAssetId: 'audio', cues: [{ id: 'C', startMs: 0, endMs: 1000, text: 'The rate is five units.' }],
    assets: [
      { id: 'audio', name: 'a.wav', mime: 'audio/wav', acquisition: 'synthetic_demo', base64: Buffer.from(pcm16Wav(new Uint8Array(44100))).toString('base64'), durationMs: 1000 },
      { id: 'image', name: 'v.png', mime: 'image/png', acquisition: 'synthetic_demo', base64: png.toString('base64'), width: 16, height: 12 },
    ], timeline: [{ id: 'T', stateId: 'V', assetId: 'image', startMs: 0, endMs: 1000, alignment: 'provided_fixture' }] };
}
function candidate(): Compilation {
  return { inputRevision: 1, providerMode: 'mock', sourceReview: 'not_reviewed',
    evidence: [{ id: 'E', kind: 'speech', cueId: 'C', quote: 'The rate is five units.', sourceStartMs: 0, sourceEndMs: 1000 }], dependencies: [],
    claims: [{ id: 'K', meaning: 'The rate is five units.', kind: 'lecturer_claim', evidenceIds: ['E'], dependencyIds: [] }],
    segments: [{ id: 'S', text: 'The rate is five units.', claimIds: ['K'], dependencyIds: [], sourceRanges: [{ startMs: 0, endMs: 1000 }], stateIds: ['V'], status: 'supported' }], unresolvedEssentialIds: [] };
}
function unresolved(status: 'unresolved' | 'conflict' = 'unresolved'): Compilation {
  const c = candidate();
  const reason = status === 'conflict' ? 'The spoken rate and printed rate conflict.' : 'The recording does not identify which option is selected.';
  c.evidence.push({ id: 'EV', kind: 'visual', stateId: 'V', observation: 'The printed rate is five units; two options are present without a pointer.' });
  c.dependencies.push({ id: 'D', cueIds: ['C'], stateIds: ['V'], kind: 'deixis', essential: true, question: 'Which option?', evidenceIds: ['E', 'EV'], status, uncertaintyReason: reason });
  c.claims.push({ id: 'KU', meaning: reason, kind: 'uncertainty', evidenceIds: ['E', 'EV'], dependencyIds: ['D'] });
  c.segments[0] = { ...c.segments[0], text: `${c.segments[0].text} ${reason}`, status: status === 'conflict' ? 'conflict' : 'incomplete', claimIds: ['K', 'KU'], dependencyIds: ['D'] };
  c.unresolvedEssentialIds = ['D']; return c;
}

describe('bounded transcript and temporal inputs', () => {
  it('parses exact cue text, supported markup and positioning without treating harmless deixis as failure', () => {
    const cues = parseVtt('﻿WEBVTT\r\n\r\nC\r\n00:00.000 --> 00:01.000 align:start\r\n<v Lecturer><b>Five</b> &amp; six.</v>\r\n', 1000);
    expect(cues).toEqual([{ id: 'C', startMs: 0, endMs: 1000, text: 'Five & six.' }]);
    expect(visualReferenceWarnings('As you can see, quantity is on the horizontal axis.')).toHaveLength(1);
  });
  it.each([
    '', 'WEBVTT\n\n', 'WEBVTT\nmetadata\n', 'WEBVTT\n\nC\n00:00.000 --> 00:00.000\nEmpty duration',
    'WEBVTT\n\nC\n00:00.000 --> 00:01.001\nToo long', 'WEBVTT\n\nC\n00:00.000 --> 00:01.000\n<script>bad</script>',
    'WEBVTT\n\nC\n00:00.000 --> 00:01.000\n<b>unclosed', 'WEBVTT\n\nC\n00:00.000 --> 00:01.000\nOne\n\nC\n00:00.000 --> 00:01.000\nTwo',
    'WEBVTT\n\n00:00.000 --> 00:00.800\nOne\n\n00:00.500 --> 00:01.000\nTwo',
    'WEBVTT\n\nC\n00:60.000 --> 00:61.000\nInvalid seconds',
  ])('rejects malformed, overlapping, empty, executable or out-of-range VTT (%#)', input => { expect(() => parseVtt(input, 1000)).toThrow(); });
  it('rejects excess cues rather than silently truncating', () => {
    const text = `WEBVTT\n\n${Array.from({ length: 31 }, (_, i) => `C${i}\n00:00:${String(i).padStart(2, '0')}.000 --> 00:00:${String(i + 1).padStart(2, '0')}.000\nText`).join('\n\n')}`;
    expect(() => parseVtt(text, 32000)).toThrow(/30 cues/);
  });
  it('distinguishes a captionless draft from compilation readiness, without fake cues', () => {
    const b = source(); b.cues = [];
    expect(BundleSchema.safeParse(b).success).toBe(true);
    expect(validateBundle(b)).toContainEqual(expect.stringMatching(/Missing timed transcript/));
    expect(validateBundle(b, { allowMissingTranscript: true })).toEqual([]);
  });
  it('uses half-open state occurrences, including returns to the same original asset and the final endpoint', () => {
    const t = source().timeline[0];
    const timeline = [{ ...t, endMs: 10 }, { ...t, id: 'T2', stateId: 'V2', startMs: 10, endMs: 20 }, { ...t, id: 'T3', startMs: 20, endMs: 30 }];
    expect(statesAt(timeline, 10).map(e => e.stateId)).toEqual(['V2']);
    expect(statesAt(timeline, 20).map(e => e.stateId)).toEqual(['V']);
    expect(statesAt(timeline, 30).map(e => e.stateId)).toEqual(['V']);
    expect(statesAt(timeline, 31)).toEqual([]); expect(timelineErrors(timeline, 30)).toEqual([]);
    expect(timelineErrors([timeline[0], timeline[2]], 30).join(' ')).toMatch(/gap/);
    expect(timelineErrors([{ ...t, endMs: 20 }, { ...t, id: 'T2', startMs: 10, endMs: 30 }], 30).join(' ')).toMatch(/overlap/);
    expect(timelineErrors([{ ...t, alignment: 'suggested' }], 1000).join(' ')).toMatch(/user-confirmed/);
  });
  it('loads preserved independent fixture inputs and exposes the deliberate missing-alignment mutation', async () => {
    for (const id of ['F1', 'F2', 'F3', 'F4a', 'F4b']) expect(validateBundle(await loadFixture(id)), id).toEqual([]);
    expect(validateBundle(await loadFixture('M-gap')).join(' ')).toMatch(/alignment gap/);
  });
});

describe('actual media bytes, not metadata claims', () => {
  it('recomputes immutable hashes, dimensions, and actual audio sample duration', async () => {
    const b = source();
    const image = await verifyAsset({ ...b.assets[1], width: 1, height: 1, sha256: '0'.repeat(64) });
    expect(image).toMatchObject({ width: 16, height: 12 }); expect(image.sha256).not.toBe('0'.repeat(64));
    expect((await verifyAsset({ ...b.assets[0], durationMs: 123 })).durationMs).toBe(1000);
  });
  it('rejects canonical base64 violations and per-file byte caps before decoding', () => {
    expect(base64ByteLength('AB==')).toBe(-1); expect(base64ByteLength('AA==')).toBe(1);
    expect(AssetSchema.safeParse({ ...source().assets[1], base64: 'AB==' }).success).toBe(false);
    expect(AssetSchema.safeParse({ ...source().assets[1], base64: 'AAAA'.repeat(Math.ceil(LIMITS.maxVisualBytes / 3) + 1) }).success).toBe(false);
  });
  it('rejects corrupt compressed pixels, signature mismatches and truncated audio data', async () => {
    await expect(inspectAssetBytes(png.subarray(0, 40), 'image/png')).rejects.toThrow();
    await expect(inspectAssetBytes(png, 'image/jpeg')).rejects.toThrow();
    await expect(inspectAssetBytes(Buffer.from('%PDF-1.7\nnot a document\n%%EOF'), 'application/pdf')).rejects.toThrow();
    const bytes = Buffer.from(source().assets[0].base64, 'base64'); bytes.writeUInt32LE(bytes.length * 2, 40);
    await expect(inspectAssetBytes(bytes, 'audio/wav')).rejects.toThrow();
  });
  it('rejects excessive decoded dimensions before allocating image pixels', async () => {
    const bytes = Buffer.from(png); bytes.writeUInt32BE(4097, 16);
    await expect(inspectAssetBytes(bytes, 'image/png')).rejects.toThrow(/dimensions/);
  });
});

describe('local cited numeric, unit, label and sign forms', () => {
  it.each([
    ['The rate is five units.', ['The rate is 5 units.']],
    ['The price is seven pounds.', ['Price £7.']],
    ['The temperature is negative three Celsius.', ['Temperature -3 Celsius.']],
    ['The length is twenty-one millimetres.', ['Length 21 mm.']],
    ['The fraction is the sum of a and b divided by the difference of c and d. Assume c not equal to d.', ['r = (a + b) / (c − d). Assume c ≠ d.']],
    ['D zero shifts to D one.', ['D0 shifts to D1.']],
  ])('accepts equivalent supported wording: %s', (output, evidence) => { expect(numericConsistencyErrors(output, evidence)).toEqual([]); });
  it.each([
    ['The price is eight pounds.', ['Price £7.']], ['The value is three.', ['Value -3.']],
    ['The value is negative three.', ['Value 3.']], ['The price is five dollars.', ['Price £5.']],
    ['The length is 5 kilograms.', ['Length 5 metres.']], ['The denominator is c plus d.', ['c − d']],
    ['D2 is the new demand.', ['D0 and D1 are shown.']], ['a is greater than b.', ['a < b']],
  ])('rejects a changed value, sign, unit or identity: %s', (output, evidence) => { expect(numericConsistencyErrors(output, evidence).length).toBeGreaterThan(0); });
});

describe('evidence, coverage, revision and spoken uncertainty gates', () => {
  it('accepts a fully supported compilation and finds exact quote locations', () => {
    expect(validateCompilation(candidate(), source(), 1)).toEqual([]);
    expect(locateQuote('five then five', 'five')).toEqual([{ start: 0, end: 4 }, { start: 10, end: 14 }]);
  });
  it.each(['quote', 'cue', 'time', 'revision', 'crop', 'claim', 'unknown-fact', 'number'] as const)('rejects %s provenance/support mutation', mutation => {
    const c = candidate();
    if (mutation === 'quote') (c.evidence[0] as Extract<Compilation['evidence'][number], { kind: 'speech' }>).quote = 'The rate is six units.';
    if (mutation === 'cue') (c.evidence[0] as Extract<Compilation['evidence'][number], { kind: 'speech' }>).cueId = 'invented';
    if (mutation === 'time') (c.evidence[0] as Extract<Compilation['evidence'][number], { kind: 'speech' }>).sourceEndMs = 1001;
    if (mutation === 'revision') c.inputRevision = 2;
    if (mutation === 'crop') c.evidence.push({ id: 'EV', kind: 'visual', stateId: 'V', observation: 'Rate', region: { x: 0.9, y: 0, w: 0.2, h: 1 } });
    if (mutation === 'claim') c.claims[0].evidenceIds = [];
    if (mutation === 'unknown-fact') c.claims[0].meaning = 'Saturn contains frozen ammonia.';
    if (mutation === 'number') c.segments[0].text = 'The rate is six units.';
    expect(validateCompilation(c, source(), 1).length).toBeGreaterThan(0);
  });
  it.each(['unresolved', 'conflict'] as const)('requires the specific essential %s to be spoken and never marked supported', status => {
    const c = unresolved(status); expect(validateCompilation(c, source(), 1)).toEqual([]);
    c.segments[0].text = 'There is an unrelated problem.';
    expect(validateCompilation(c, source(), 1).join(' ')).toMatch(/specific limitation\/conflict is not narrated/);
    c.segments[0].status = 'supported';
    expect(validateCompilation(c, source(), 1).join(' ')).toMatch(/supported|must remain conflict/);
    c.unresolvedEssentialIds = [];
    expect(validateCompilation(c, source(), 1).join(' ')).toMatch(/omits D/);
  });
  it('does not turn a merely valid citation into support for an invented answer', () => {
    expect(validateAnswer({ text: 'The rate is six units.', evidenceIds: ['E'], status: 'supported' }, candidate(), source()).join(' ')).toMatch(/Unsupported numeric value/);
    expect(validateAnswer({ text: 'Saturn contains frozen ammonia.', evidenceIds: ['E'], status: 'supported' }, candidate(), source()).join(' ')).toMatch(/grounding/);
    expect(validateAnswer({ text: 'The rate is five units.', evidenceIds: ['unknown'], status: 'supported' }, candidate(), source()).length).toBeGreaterThan(0);
  });
  it('blocks an unidentified option choice and silent conflict reconciliation even with valid evidence IDs', () => {
    expect(validateAnswer({ text: 'Use Option A.', evidenceIds: ['E', 'EV'], status: 'supported' }, unresolved(), source()).join(' ')).toMatch(/ambiguity/);
    expect(validateAnswer({ text: 'The source is unclear, but choose Option A.', evidenceIds: ['E', 'EV'], status: 'limitation' }, unresolved(), source()).join(' ')).toMatch(/selection/);
    expect(validateAnswer({ text: 'The rate is five units.', evidenceIds: ['E', 'EV'], status: 'supported' }, unresolved('conflict'), source()).join(' ')).toMatch(/conflict/);
  });
  it('keeps runtime wire schemas strict and rejects omitted critical fields', () => {
    const c = candidate() as unknown as Record<string, unknown>; delete c.evidence;
    expect(CompilationSchema.safeParse(c).success).toBe(false);
  });
});

describe('dependency-level temporal provenance', () => {
  it('rejects future-state substitution even when a segment spans both states', () => {
    const b = source(), c = candidate();
    b.timeline = [{ ...b.timeline[0], endMs: 500 }, { ...b.timeline[0], id: 'T2', stateId: 'V2', startMs: 500 }];
    b.cues = [{ ...b.cues[0], endMs: 500 }, { ...b.cues[0], id: 'C2', startMs: 500 }];
    c.evidence[0] = { id: 'E', kind: 'speech', cueId: 'C', quote: b.cues[0].text, sourceStartMs: 0, sourceEndMs: 500 };
    c.evidence.push({ id: 'EV', kind: 'visual', stateId: 'V2', observation: 'The rate is five units.' });
    c.dependencies = [{ id: 'D', cueIds: ['C'], stateIds: ['V2'], kind: 'deixis', essential: true, question: 'Which rate?', evidenceIds: ['E','EV'], status: 'resolved', resolution: 'The rate is five units.' }];
    c.claims[0].dependencyIds = ['D']; c.claims[0].evidenceIds = ['E','EV'];
    c.segments[0].dependencyIds = ['D']; c.segments[0].stateIds = ['V','V2'];
    expect(validateCompilation(c,b,1).join(' ')).toMatch(/occurs only after its source cues/);
    // An explicit later comparison may refer to an earlier state.
    c.dependencies[0].cueIds = ['C2']; c.dependencies[0].stateIds = ['V'];
    c.evidence[0] = { id: 'E', kind: 'speech', cueId: 'C2', quote: b.cues[1].text, sourceStartMs: 500, sourceEndMs: 1000 };
    c.evidence[1] = { id: 'EV', kind: 'visual', stateId: 'V', observation: 'The rate is five units.' };
    expect(validateCompilation(c,b,1)).toEqual([]);
  });
});

describe('asset parser buffer ownership', () => {
  it('keeps a provider Buffer intact after transferring bytes to its parser worker', async () => {
    const bytes = Buffer.from(pcm16Wav(new Uint8Array(22050 * 2 * 6)));
    const copy = Buffer.from(bytes);
    expect((await inspectAssetBytes(bytes, 'audio/wav')).durationMs).toBe(6000);
    expect(bytes.byteLength).toBe(copy.byteLength);
    expect(bytes).toEqual(copy);
  });
});
