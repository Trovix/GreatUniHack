import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { loadFixture, listFixtures } from '../../scripts/fixtures.js';
import { BundleSchema, statesAt, validateBundle, visualReferenceWarnings, type Bundle } from '../../packages/core/index.js';

const root = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const primary = ['F1', 'F2', 'F3', 'F4a', 'F4b'];
const bundles = new Map<string, Bundle>();
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const asset = (bundle: Bundle, id: string) => {
  const found = bundle.assets.find(value => value.id === id);
  if (!found) throw new Error(`Test source asset missing: ${id}`);
  return Buffer.from(found.base64, 'base64');
};

// Independent small RIFF parser in the test: no generator helper is imported.
function pcm(bytes: Buffer) {
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
  expect(bytes.toString('ascii', 8, 12)).toBe('WAVE');
  let rate = 0, channels = 0, bits = 0;
  let data: Buffer = Buffer.alloc(0);
  for (let index = 12; index + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(index + 4);
    const chunk = bytes.toString('ascii', index, index + 4);
    if (chunk === 'fmt ') {
      expect(bytes.readUInt16LE(index + 8)).toBe(1);
      channels = bytes.readUInt16LE(index + 10); rate = bytes.readUInt32LE(index + 12); bits = bytes.readUInt16LE(index + 22);
    }
    if (chunk === 'data') data = bytes.subarray(index + 8, index + 8 + size);
    index += 8 + size + size % 2;
  }
  expect(rate).toBe(24000); expect(channels).toBe(1); expect(bits).toBe(16);
  return { data, rate, durationMs: data.length / 2 / rate * 1000 };
}

type RawImage = { data: Buffer; width: number; height: number; channels: number };
async function raw(bytes: Buffer): Promise<RawImage> {
  const decoded = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: decoded.data, ...decoded.info };
}
function matchingPixels(image: RawImage, centerX: number, centerY: number, radius: number, rgb: number[]) {
  let count = 0;
  for (let y = centerY - radius; y <= centerY + radius; y++) {
    for (let x = centerX - radius; x <= centerX + radius; x++) {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const at = (y * image.width + x) * image.channels;
      if (rgb.every((value, channel) => Math.abs(image.data[at + channel] - value) < 28)) count++;
    }
  }
  return count;
}
function ringInk(image: RawImage, centerX: number, centerY: number) {
  let count = 0;
  for (let y = centerY - 27; y <= centerY + 27; y++) {
    for (let x = centerX - 27; x <= centerX + 27; x++) {
      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance < 20 || distance > 26) continue;
      const at = (y * image.width + x) * image.channels;
      if ([0, 1, 2].every(channel => image.data[at + channel] < 65)) count++;
    }
  }
  return count;
}

beforeAll(async () => {
  for (const fixture of listFixtures()) bundles.set(fixture.id, await loadFixture(fixture.id));
}, 60000);

describe('authored synthetic source bundle boundary', () => {
  it('lists the complete source family plus all reproducible source mutations', () => {
    const ids = listFixtures().map(fixture => fixture.id);
    expect(ids).toEqual(expect.arrayContaining([...primary, 'M-gap', 'M-axis-swap', 'M-harmless-deixis', 'M-self-contained', 'M-injection', 'M-timeline-edited']));
    expect(new Set(ids).size).toBe(ids.length);
    const changed = listFixtures(); changed[0].title = 'changed by caller';
    expect(listFixtures()[0].title).not.toBe('changed by caller');
  });

  it.each(['../expected/F1', '../../BUILD_SPEC', '/tmp/F1', 'f1', 'unknown'])('rejects unknown/path-like fixture ID %s', async id => {
    await expect(loadFixture(id)).rejects.toThrow('Unknown synthetic fixture');
  });

  it.each(primary)('%s returns a CONTRACT Bundle with real source bytes and no answer context', id => {
    const bundle = bundles.get(id)!;
    expect(BundleSchema.safeParse(bundle).success).toBe(true);
    expect(validateBundle(bundle)).toEqual([]);
    expect(Object.keys(bundle).sort()).toEqual(['assets', 'audioAssetId', 'cues', 'timeline', 'title', 'transcriptAssetId']);
    expect(bundle.context).toBeUndefined(); expect(bundle.capture).toBeUndefined();
    expect(bundle.assets.every(value => value.acquisition === 'synthetic_demo')).toBe(true);
    expect(bundle.assets.some(value => value.mime === 'image/png')).toBe(true);
    for (const value of bundle.assets) {
      const bytes = Buffer.from(value.base64, 'base64');
      expect(value.sha256).toBe(hash(bytes));
      expect(bytes.length).toBeGreaterThan(20);
      expect(value.name).toMatch(/^(source\.wav|captions\.vtt|V[1-4]\.png)$/);
    }
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toMatch(/criticalMeanings|prohibitedAssertions|comprehensionQuestions|reviewerRole|expectedAdaptationStatus/);
  });

  it('does not expose fixture identity as an expected semantic answer in market titles', () => {
    expect(bundles.get('F1')!.title).toBe(bundles.get('F2')!.title);
    expect(bundles.get('F1')!.title).toBe(bundles.get('F4a')!.title);
    expect(bundles.get('F1')!.title).toBe(bundles.get('F4b')!.title);
  });

  it('fresh loads cannot be modified through a previous returned Bundle', async () => {
    const first = await loadFixture('F1'); first.cues[0].text = 'tampered'; first.timeline[0].endMs = 1;
    const next = await loadFixture('F1');
    expect(next.cues[0].text).toBe('We start where these two lines cross. That is our initial equilibrium.');
    expect(next.timeline[0].endMs).toBe(10000);
  });
});

describe('actual synthetic source A speech and timed captions', () => {
  it.each(primary)('%s has exactly the specified PCM duration and audible content in every slot', async id => {
    const bundle = bundles.get(id)!;
    const decoded = pcm(asset(bundle, bundle.audioAssetId));
    expect(decoded.durationMs).toBe(id === 'F3' ? 10000 : 60000);
    expect(bundle.cues).toHaveLength(id === 'F3' ? 1 : 6);
    const provenance = JSON.parse(await readFile(path.join(root, id, 'audio-metadata.json'), 'utf8'));
    expect(provenance.engine).toBe('macOS offline say'); expect(provenance.voice).toBe('Daniel');
    expect(provenance.sha256).toBe(hash(asset(bundle, bundle.audioAssetId)));
    for (const [index, cue] of bundle.cues.entries()) {
      expect(cue.id).toBe(`C${index + 1}`); expect(cue.startMs).toBe(index * 10000); expect(cue.endMs).toBe((index + 1) * 10000);
      expect(provenance.cues[index].text).toBe(cue.text);
      expect(provenance.cues[index].spokenDurationMs).toBeGreaterThan(1500);
      expect(provenance.cues[index].spokenDurationMs).toBeLessThanOrEqual(9900);
      expect(provenance.cues[index].rate).toBeLessThanOrEqual(235);
      const slot = decoded.data.subarray(index * 480000, (index + 1) * 480000);
      let energy = 0, activeSamples = 0;
      for (let sample = 0; sample < slot.length; sample += 2) {
        const value = slot.readInt16LE(sample); energy += value * value; if (Math.abs(value) > 300) activeSamples++;
      }
      expect(Math.sqrt(energy / 240000)).toBeGreaterThan(100);
      expect(activeSamples).toBeGreaterThan(5000);
      // At least the guaranteed final 100ms is actual padding, never chopped speech.
      expect(slot.subarray(slot.length - 4800).every(byte => byte === 0)).toBe(true);
    }
  });

  it('F1 uses the exact six supplied caption sentences, not an adapted answer script', () => {
    expect(bundles.get('F1')!.cues.map(cue => cue.text)).toEqual([
      'We start where these two lines cross. That is our initial equilibrium.',
      'Now demand increases. It moves from the blue line to the purple line, while supply stays put.',
      'The new equilibrium is here. Both of these values are higher than before.',
      'This is a shift of demand, not a movement along the original demand curve.',
      'In the highlighted version, this whole top part is divided by this bottom part. The brackets are important.',
      'Returning to our original picture, this is the starting point again.',
    ]);
  });

  it('F2 changes the actual speech for cues 2 and 3, preserving the other four exact slots', () => {
    const f1 = bundles.get('F1')!, f2 = bundles.get('F2')!;
    expect(f2.cues[1].text).toBe('Now demand decreases. It moves from the blue line to the purple line, while supply stays put.');
    expect(f2.cues[2].text).toBe('The new equilibrium is here. Both of these values are lower than before.');
    const a = pcm(asset(f1, 'A')).data, b = pcm(asset(f2, 'A')).data;
    expect(hash(a)).not.toBe(hash(b));
    for (let index = 0; index < 6; index++) {
      const equal = a.subarray(index * 480000, (index + 1) * 480000).equals(b.subarray(index * 480000, (index + 1) * 480000));
      expect(equal).toBe(index !== 1 && index !== 2);
    }
  });

  it('F4a changes only conflicting C3 speech; F4b preserves original source audio', () => {
    const original = pcm(asset(bundles.get('F1')!, 'A')).data, conflict = pcm(asset(bundles.get('F4a')!, 'A')).data;
    expect(bundles.get('F4a')!.cues[2].text).toBe('The new equilibrium is here. The price falls, while the quantity rises.');
    for (let index = 0; index < 6; index++) expect(original.subarray(index * 480000, (index + 1) * 480000).equals(conflict.subarray(index * 480000, (index + 1) * 480000))).toBe(index !== 2);
    expect(asset(bundles.get('F4b')!, 'A')).toEqual(asset(bundles.get('F1')!, 'A'));
  });
});

describe('temporal source fidelity', () => {
  it('uses unique occurrences, real within-slide changes, and reuses original V1 bytes on return', () => {
    const bundle = bundles.get('F1')!;
    expect(bundle.timeline.map(value => [value.stateId, value.startMs, value.endMs])).toEqual([
      ['V1', 0, 10000], ['V2', 10000, 20000], ['V3', 20000, 40000], ['V4', 40000, 50000], ['V1', 50000, 60000],
    ]);
    expect(new Set(bundle.timeline.map(value => value.id)).size).toBe(5);
    expect(bundle.timeline[0].assetId).toBe(bundle.timeline[4].assetId);
    expect(bundle.assets.filter(value => value.id === bundle.timeline[0].assetId)).toHaveLength(1);
    expect(bundle.timeline[1].build).toBe('slide 1 build B'); expect(bundle.timeline[2].build).toBe('slide 1 build C');
    for (const [time, state] of [[9999, 'V1'], [10000, 'V2'], [20000, 'V3'], [39999, 'V3'], [40000, 'V4'], [50000, 'V1'], [60000, 'V1']] as const)
      expect(statesAt(bundle.timeline, time).map(value => value.stateId)).toEqual([state]);
  });

  it('M-gap is genuinely missing V3 alignment and fails before compilation', () => {
    const bundle = bundles.get('M-gap')!;
    expect(bundle.timeline.some(value => value.stateId === 'V3')).toBe(false);
    expect(statesAt(bundle.timeline, 25000)).toEqual([]);
    expect(validateBundle(bundle).some(message => /alignment gap.*20000.*40000/i.test(message))).toBe(true);
    expect(asset(bundle, 'IMG_V3')).toEqual(asset(bundles.get('F1')!, 'IMG_V3'));
  });

  it('the edited timeline is valid, changed source data with a new visual boundary', () => {
    const edited = bundles.get('M-timeline-edited')!, original = bundles.get('F1')!;
    expect(validateBundle(edited)).toEqual([]);
    expect(edited.timeline).not.toEqual(original.timeline);
    expect(statesAt(edited.timeline, 20500)[0].stateId).toBe('V2');
    expect(statesAt(original.timeline, 20500)[0].stateId).toBe('V3');
    expect(statesAt(edited.timeline, 21000)[0].stateId).toBe('V3');
  });
});

describe('rendered PNG geometry and actual source mutations', () => {
  it.each(primary)('%s PNGs decode as actual 1000x800 images, not source descriptions', async id => {
    for (const value of bundles.get(id)!.assets.filter(value => value.mime === 'image/png')) {
      const bytes = Buffer.from(value.base64, 'base64');
      expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      const metadata = await sharp(bytes).metadata();
      expect([metadata.width, metadata.height]).toEqual([1000, 800]);
      expect((await sharp(bytes).stats()).channels[0].stdev).toBeGreaterThan(5);
    }
  });

  it('F1 plots exact supply, initial demand and increased-demand geometry at independent sample coordinates', async () => {
    const initial = await raw(asset(bundles.get('F1')!, 'IMG_V1'));
    const changed = await raw(asset(bundles.get('F1')!, 'IMG_V2'));
    // Source mapping x=100+70Q, y=680-40P; sample away from labels/intersections.
    expect(matchingPixels(initial, 660, 360, 9, [17, 17, 17])).toBeGreaterThan(10); // S at Q8 P8
    expect(matchingPixels(initial, 240, 360, 9, [39, 124, 189])).toBeGreaterThan(5); // D0 Q2 P8
    expect(matchingPixels(changed, 240, 200, 10, [112, 32, 173])).toBeGreaterThan(5); // D1 Q2 P12
    expect(matchingPixels(initial, 240, 200, 10, [112, 32, 173])).toBe(0);
    expect(matchingPixels(changed, 590, 400, 5, [112, 32, 173])).toBeGreaterThan(20); // E1 Q7 P7
    expect(matchingPixels(initial, 450, 480, 5, [17, 17, 17])).toBeGreaterThan(20); // E0 Q5 P5
  });

  it('F2 truly changes new-demand geometry to P=6-Q and E1=(3,3), not only metadata', async () => {
    const f1 = bundles.get('F1')!, f2 = bundles.get('F2')!;
    expect(asset(f1, 'IMG_V1')).toEqual(asset(f2, 'IMG_V1'));
    expect(asset(f1, 'IMG_V4')).toEqual(asset(f2, 'IMG_V4'));
    expect(hash(asset(f1, 'IMG_V2'))).not.toBe(hash(asset(f2, 'IMG_V2')));
    expect(hash(asset(f1, 'IMG_V3'))).not.toBe(hash(asset(f2, 'IMG_V3')));
    const image = await raw(asset(f2, 'IMG_V2'));
    expect(matchingPixels(image, 240, 520, 10, [112, 32, 173])).toBeGreaterThan(5); // D1 Q2 P4
    expect(matchingPixels(image, 310, 560, 5, [112, 32, 173])).toBeGreaterThan(20); // E1 Q3 P3
    expect(matchingPixels(image, 450, 480, 5, [17, 17, 17])).toBeGreaterThan(20); // E0 must stay visible, not hidden by E1 label
    expect(matchingPixels(image, 240, 200, 10, [112, 32, 173])).toBe(0);
  });

  it.each([['F1', 590, 400], ['F2', 310, 560]] as const)('%s build C actually adds a ring at the new equilibrium', async (id, x, y) => {
    const bundle = bundles.get(id)!;
    const before = await raw(asset(bundle, 'IMG_V2')), after = await raw(asset(bundle, 'IMG_V3'));
    expect(ringInk(after, x, y) - ringInk(before, x, y)).toBeGreaterThan(200);
  });

  it('F3 has equal-size unhighlighted point markers at both independently specified values', async () => {
    const image = await raw(asset(bundles.get('F3')!, 'IMG_V1'));
    const a = matchingPixels(image, 240, 360, 6, [17, 17, 17]), b = matchingPixels(image, 520, 520, 6, [17, 17, 17]);
    expect(a).toBeGreaterThan(80); expect(b).toBeGreaterThan(80); expect(Math.abs(a - b)).toBeLessThan(10);
    expect(ringInk(image, 240, 360)).toBeLessThan(20); expect(ringInk(image, 520, 520)).toBeLessThan(20);
  });

  it('F4a chart remains byte-identical while F4b changes only the mathematical image to a blurred raster', async () => {
    const f1 = bundles.get('F1')!, conflict = bundles.get('F4a')!, unreadable = bundles.get('F4b')!;
    for (const id of ['IMG_V1', 'IMG_V2', 'IMG_V3', 'IMG_V4']) expect(asset(f1, id)).toEqual(asset(conflict, id));
    for (const id of ['IMG_V1', 'IMG_V2', 'IMG_V3']) expect(asset(f1, id)).toEqual(asset(unreadable, id));
    expect(asset(f1, 'IMG_V4')).not.toEqual(asset(unreadable, 'IMG_V4'));
    const region = { left: 100, top: 170, width: 750, height: 540 };
    const clear = await sharp(asset(f1, 'IMG_V4')).extract(region).stats();
    const blurred = await sharp(asset(unreadable, 'IMG_V4')).extract(region).stats();
    expect(blurred.channels[0].stdev).toBeLessThan(clear.channels[0].stdev * 0.6);
  });

  it('the injection mutation changes actual slide pixels only, not application context or captions', () => {
    const original = bundles.get('F1')!, injected = bundles.get('M-injection')!;
    expect(injected.cues).toEqual(original.cues); expect(injected.context).toBeUndefined();
    expect(asset(injected, 'IMG_V1')).toEqual(asset(original, 'IMG_V1'));
    expect(asset(injected, 'IMG_V2')).not.toEqual(asset(original, 'IMG_V2'));
    expect(asset(injected, 'IMG_V3')).not.toEqual(asset(original, 'IMG_V3'));
    expect(asset(injected, 'IMG_V4')).toEqual(asset(original, 'IMG_V4'));
  });

  it('the swapped-axes and self-contained mutations are valid real sources, not expected-answer flags', () => {
    for (const id of ['M-axis-swap', 'M-self-contained', 'M-harmless-deixis', 'M-injection']) expect(validateBundle(bundles.get(id)!)).toEqual([]);
    expect(bundles.get('M-axis-swap')!.timeline).toHaveLength(1);
    expect(asset(bundles.get('M-axis-swap')!, 'IMG_V1')).not.toEqual(asset(bundles.get('F3')!, 'IMG_V1'));
    expect(bundles.get('M-harmless-deixis')!.cues[0].text).toMatch(/^As you can see, quantity in units is horizontal/);
    expect(visualReferenceWarnings(bundles.get('M-harmless-deixis')!.cues[0].text)).toEqual(expect.arrayContaining([expect.stringMatching(/Contextual review/)]));
    expect(bundles.get('M-self-contained')!.cues[4].text).toContain('whole quantity C minus D');
  });
});

describe('real downloadable PDF deck and independent expectations', () => {
  it.each(primary)('%s PDF parses with correct image-only pages and no hidden equation/answer text', async id => {
    const bytes = await readFile(path.join(root, id, 'slides.pdf'));
    expect(bytes.toString('ascii', 0, 8)).toBe('%PDF-1.4');
    const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false });
    const doc = await loading.promise;
    try {
      expect(doc.numPages).toBe(id === 'F3' ? 1 : 4);
      for (let index = 1; index <= doc.numPages; index++) {
        const page = await doc.getPage(index);
        const viewport = page.getViewport({ scale: 1 }); expect([viewport.width, viewport.height]).toEqual([1000, 800]);
        const content = await page.getTextContent(); expect(content.items).toHaveLength(0);
        const operators = await page.getOperatorList(); expect(operators.fnArray.length).toBeGreaterThan(0);
      }
    } finally { await doc.destroy(); }
  });

  it('keeps separately authored critical meaning and negative assertions outside runtime bundles', async () => {
    const f1 = JSON.parse(await readFile(path.join(root, 'expected/F1.json'), 'utf8'));
    expect(f1.criticalMeanings.map((item: { id: string }) => item.id)).toEqual(Array.from({ length: 12 }, (_, index) => `K${index + 1}`));
    expect(f1.comprehensionQuestions).toHaveLength(7);
    for (const id of primary) {
      const expected = JSON.parse(await readFile(path.join(root, `expected/${id}.json`), 'utf8'));
      expect(expected.fixtureId).toBe(id); expect(expected.criticalMeanings.length).toBeGreaterThan(2); expect(expected.prohibitedAssertions.length).toBeGreaterThan(2);
      expect(JSON.stringify(bundles.get(id))).not.toContain('criticalMeanings');
    }
  });
});
