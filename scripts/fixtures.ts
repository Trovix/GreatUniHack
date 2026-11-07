import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BundleSchema, parseVtt, type Asset, type Bundle, type TimelineEntry } from '../packages/core/index.js';

const fixtureRoot = fileURLToPath(new URL('../fixtures/', import.meta.url));
const marketTitle = 'Demand, supply and grouped algebra — synthetic lecture';
const catalog = [
  { id: 'F1', title: marketTitle },
  { id: 'F2', title: marketTitle },
  { id: 'F3', title: 'Two labelled options — synthetic lecture' },
  { id: 'F4a', title: marketTitle },
  { id: 'F4b', title: marketTitle },
  { id: 'M-gap', title: `${marketTitle} (timeline gap)` },
  { id: 'M-axis-swap', title: 'Price and quantity observations — synthetic lecture' },
  { id: 'M-harmless-deixis', title: 'Self-contained chart explanation — synthetic lecture' },
  { id: 'M-self-contained', title: 'Self-contained chart explanation — synthetic lecture' },
  { id: 'M-injection', title: marketTitle },
  { id: 'M-timeline-edited', title: marketTitle },
] as const;

type SourceFile = { assetId: string; file: string; mime: Asset['mime']; width?: number; height?: number };
type SourceManifest = {
  schemaVersion: 1; synthetic: true; id: string; title: string; durationMs: number;
  audio: SourceFile; transcript: SourceFile; visuals: (SourceFile & { stateId: string; build: string })[];
  timeline: string;
};

/** Return fresh catalog objects so callers cannot mutate later fixture loads. */
export function listFixtures(): { id: string; title: string }[] {
  return catalog.map(({ id, title }) => ({ id, title }));
}

/**
 * Loads authored INPUTS only. In particular, this module never reads expected/,
 * review manifests, audio provenance prose, SVGs, metadata.json or PDF text.
 * Actual PNG bytes (not descriptions) are supplied to the production adapter.
 */
export async function loadFixture(id: string): Promise<Bundle> {
  if (!catalog.some(fixture => fixture.id === id)) throw new Error('Unknown synthetic fixture');
  const directory = path.join(fixtureRoot, id);
  const source = JSON.parse(await readFile(path.join(directory, 'source.json'), 'utf8')) as SourceManifest;
  if (source.schemaVersion !== 1 || source.synthetic !== true || source.id !== id) throw new Error('Invalid synthetic fixture source manifest');
  const readSource = async (file: string): Promise<Buffer> => {
    if (!/^[A-Za-z0-9_-]+\.(?:wav|vtt|png|json)$/.test(file)) throw new Error('Invalid synthetic fixture source filename');
    return readFile(path.join(directory, file));
  };
  const toAsset = async (file: SourceFile): Promise<Asset> => {
    const bytes = await readSource(file.file);
    return {
      id: file.assetId, name: file.file, mime: file.mime, base64: bytes.toString('base64'),
      acquisition: 'synthetic_demo', sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(file === source.audio ? { durationMs: source.durationMs } : {}),
      ...(file.width === undefined ? {} : { width: file.width, height: file.height }),
    };
  };
  const assets = await Promise.all([source.audio, source.transcript, ...source.visuals].map(toAsset));
  const captions = await readSource(source.transcript.file);
  const timeline = JSON.parse((await readSource(source.timeline)).toString('utf8')) as TimelineEntry[];
  // Structural schema validation is intentional here; M-gap is a deliberately
  // invalid alignment fixture for validateBundle's pre-compilation gate.
  return BundleSchema.parse({
    title: source.title, assets, audioAssetId: source.audio.assetId, transcriptAssetId: source.transcript.assetId,
    cues: parseVtt(captions.toString('utf8'), source.durationMs), timeline,
  });
}
