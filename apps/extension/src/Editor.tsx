import { useEffect, useState } from 'react';
import type { Asset, Bundle, TimelineEntry } from '../../../packages/core/index';
import { parseVtt, validateBundle } from '../../../packages/core/index';
import { workerMessage } from './api';
import { assetFromFile, base64Bytes, bytesToBase64, byteSize, checkImportBudget, normaliseCapturedAsset, validateSelection } from './ingest';
import { openPdf, selectedPages, type OpenPdf } from './pdf';
import { timelineProblems, timeLabel, type Step } from './model';

type Bound = {courseTitle: string; pageIdentity: string; recognised: boolean; sections: {id: string; title: string}[]};
type Resource = {id: string; title: string; type: string; url: string; allowed: boolean; reason?: string; canOpen?: boolean};
type Capture = {courseTitle: string; pageIdentity: string; capturedAt: string; text: string; acquisition: 'browser_capture'; resources: Resource[]};
type Props = {bundle: Bundle; step: Step; dirty: boolean; busy: boolean; transcriptOrigin?: 'supplied_captions' | 'elevenlabs_stt' | 'mock_stt'; onChange: (bundle: Bundle) => void; onSave: (bundle: Bundle) => Promise<void>; onError: (message: string) => void; onNotice: (message: string) => void; onPreview: (asset: Asset) => void; onPrepare: () => void};
const acquisitionLabels = {browser_capture: 'Browser capture', manual_import: 'Manual import', synthetic_demo: 'Synthetic demo'};
export function emptyBundle(title: string): Bundle { return {title, assets: [], audioAssetId: '', cues: [], timeline: [], context: []}; }
export function Editor({bundle, step, dirty, busy, transcriptOrigin, onChange, onSave, onError, onNotice, onPreview, onPrepare}: Props) {
  const [bound, setBound] = useState<Bound>();
  const [sectionId, setSectionId] = useState('');
  const [capture, setCapture] = useState<Capture>();
  const [resources, setResources] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [pdf, setPdf] = useState<{asset: Asset; reader: OpenPdf}>();
  const [pages, setPages] = useState('');
  const images = bundle.assets.filter(a => a.mime.startsWith('image/'));
  const audio = bundle.assets.find(a => a.id === bundle.audioAssetId);
  const transcript = bundle.assets.find(a => a.id === bundle.transcriptAssetId);
  const duration = audio?.durationMs ?? 0;
  const vtt = transcript ? new TextDecoder().decode(base64Bytes(transcript.base64)) : '';
  const problems = timelineProblems(bundle.timeline, duration);
  const tasks = async (operation: () => Promise<void>) => { setWorking(true); try { await operation(); } catch (error) { onError((error as Error).message); } finally { setWorking(false); } };
  useEffect(() => () => { void pdf?.reader.close(); }, [pdf]);
  const update = (next: Bundle) => { setReviewed(false); onChange(next); };
  const append = async (additions: Asset[], metadata?: Capture) => {
    let next = {...bundle, assets: [...bundle.assets], context: [...(bundle.context ?? [])]};
    for (const asset of additions) {
      if (next.assets.some(a => a.mime === asset.mime && a.base64 === asset.base64)) { onNotice(`“${asset.name}” is already selected; reusing the existing bytes.`); continue; }
      if (asset.mime === 'application/pdf') {
        if (pdf) throw new Error('Finish or cancel the open PDF page selection first.');
        const reader = await openPdf(asset);
        setPdf({asset, reader}); setPages('');
        onNotice(`PDF opened locally: ${reader.pageCount} pages. Choose up to six pages to render.`);
        // Preserve the original only after explicit page selection, together with its rendered evidence.
        continue;
      }
      next.assets.push(asset);
      if (asset.mime.startsWith('audio/') && !next.audioAssetId) next.audioAssetId = asset.id;
      if (asset.mime === 'text/vtt' && !next.transcriptAssetId) {
        next.transcriptAssetId = asset.id;
        next.cues = parseVtt(new TextDecoder().decode(base64Bytes(asset.base64)), next.assets.find(a => a.id === next.audioAssetId)?.durationMs);
      }
    }
    if (metadata) next.capture = {courseTitle: metadata.courseTitle, pageIdentity: metadata.pageIdentity, capturedAt: metadata.capturedAt, text: metadata.text, acquisition: 'browser_capture'};
    validateSelection(next.assets); update(next);
  };
  const remove = (assetId: string) => {
    update({...bundle, assets: bundle.assets.filter(a => a.id !== assetId), timeline: bundle.timeline.filter(t => t.assetId !== assetId),
      audioAssetId: bundle.audioAssetId === assetId ? '' : bundle.audioAssetId,
      ...(bundle.transcriptAssetId === assetId ? {transcriptAssetId: undefined, cues: []} : {})});
  };
  const changeInterval = (id: string, patch: Partial<TimelineEntry>) => update({...bundle, timeline: bundle.timeline.map(t => t.id === id ? {...t, ...patch} : t)});
  const save = () => tasks(async () => {
    if (!audio) throw new Error('Choose one source WAV or MP3 before saving.');
    if (!reviewed) throw new Error('Review and confirm the visual timeline before saving.');
    if (problems.length) throw new Error(problems.join(' '));
    if (!images.length) throw new Error('Add at least one PNG/JPEG image or a rendered PDF page.');
    const cues = transcript ? parseVtt(vtt, duration) : bundle.cues;
    validateSelection(bundle.assets);
    await onSave({...bundle, cues, timeline: bundle.timeline.map(row => ({...row, alignment: 'user_confirmed' as const}))});
    setReviewed(false);
  });

  return <div className="editor">
    {step === 'find' && <>
      <section className="block" aria-labelledby="browser-title">
        <p className="eyebrow">01 / selected course material</p><h2 id="browser-title">Bring your lecture here.</h2>
        <p>Open a course section in your normal browser. Choose exactly what to capture; your login stays in that tab.</p>
        <button disabled={working || busy} onClick={() => void tasks(async () => {
          const next = await workerMessage<Bound>({type: 'BIND_ACTIVE_TAB'}); setBound(next); setCapture(undefined); setResources([]); setSectionId('');
          onNotice(`Bound to ${next.courseTitle}. Select a section to preview.`);
        })}>Bind current course tab</button>
        {bound && <div className="subblock">
          <p><strong>{bound.courseTitle}</strong><br/><span className="caption">{bound.pageIdentity}</span></p>
          {!bound.recognised && <p className="notice">Moodle layout not recognised. Select one visible section below, or use manual import. Nothing is captured automatically.</p>}
          <label>Visible section<select value={sectionId} onChange={e => setSectionId(e.target.value)}><option value="">Choose one section</option>{bound.sections.map(section => <option key={section.id} value={section.id}>{section.title}</option>)}</select></label>
          <button disabled={!sectionId || working} onClick={() => void tasks(async () => {
            const preview = await workerMessage<Capture>({type: 'CAPTURE_SECTION', sectionId}); setCapture(preview); setResources([]); onNotice('Section preview captured locally. Choose resources to import.');
          })}>Preview selected section</button>
        </div>}
        {capture && <div className="subblock">
          <h3>Capture preview</h3><p className="caption">Browser capture · {new Date(capture.capturedAt).toLocaleString()} · {capture.pageIdentity}</p>
          <details><summary>Selected visible text</summary><p className="source-text">{capture.text || 'No visible teaching text was found in this section.'}</p></details>
          <ul className="resource-list">{capture.resources.map(resource => <li key={resource.id}>
            <label className="check"><input type="checkbox" disabled={!resource.allowed || working} checked={resources.includes(resource.id)} onChange={e => setResources(old => e.target.checked ? [...old, resource.id] : old.filter(id => id !== resource.id))}/><span><strong>{resource.title}</strong><span className="caption">{resource.type} · {resource.allowed ? 'Direct same-origin file' : resource.reason || 'Manual import required'}</span></span></label>
            {resource.canOpen && <button className="text-button" onClick={() => void tasks(async () => { await workerMessage({type: 'OPEN_ACTIVITY', resourceId: resource.id}); onNotice('Original activity opened through ordinary browser navigation.'); })}>Open original activity<span className="sr-only">: {resource.title}</span></button>}
          </li>)}</ul>
          <button disabled={!resources.length || working} onClick={() => void tasks(async () => {
            const assets: Asset[] = [];
            for (const resourceId of resources) assets.push(await normaliseCapturedAsset(await workerMessage<Asset>({type: 'IMPORT_RESOURCE', resourceId})));
            await append(assets, capture); setResources([]); onNotice('Selected browser resources imported locally. No content has been sent to a provider.');
          })}>Import selected resources ({resources.length})</button>
          {!capture.resources.length && <p>No supported resources found. Use a permitted manual download below.</p>}
        </div>}
      </section>
      <section className="block" aria-labelledby="manual-title"><h2 id="manual-title">Or choose local files.</h2>
        <p className="caption">Manual import is a fallback, not a claim of live Moodle capture. WAV/MP3 ≤25 MB; WEBVTT ≤1 MB; PNG/JPEG/PDF ≤5 MB each. One source unit, up to 180 seconds, six images and 50 MB total.</p>
        <label className="file-picker">Choose lecture files<input type="file" multiple accept=".wav,.mp3,.vtt,.png,.jpg,.jpeg,.pdf,audio/wav,audio/mpeg,text/vtt,image/png,image/jpeg,application/pdf" disabled={working || busy || !!pdf} onChange={event => {
          const selected = Array.from(event.target.files ?? []); event.target.value = '';
          void tasks(async () => { if (selected.length > 10) throw new Error('Select at most ten source files at a time.'); const additions: Asset[] = []; for (const file of selected) additions.push(await assetFromFile(file)); await append(additions); onNotice('Files checked and selected locally. Review their source timeline before saving.'); });
        }}/></label>
      </section>
    </>}
    {pdf && <section className="notice" aria-labelledby="pdf-title"><h2 id="pdf-title">Choose PDF pages</h2><p>{pdf.asset.name} · {pdf.reader.pageCount} pages. The original PDF is preserved alongside the rendered pages. Text extraction is a second, fallible evidence channel.</p>
      <label>Page numbers, separated by commas<input value={pages} placeholder="1, 3, 5" onChange={e => setPages(e.target.value)} /></label>
      <div className="button-row"><button disabled={working} onClick={() => void tasks(async () => {
        const result = await pdf.reader.render(selectedPages(pages, pdf.reader.pageCount));
        const next = {...bundle, assets: [...bundle.assets, pdf.asset, ...result.images], context: [...(bundle.context ?? []), ...result.context]};
        validateSelection(next.assets); update(next); await pdf.reader.close(); setPdf(undefined); onNotice(`${result.images.length} selected PDF pages rendered locally. Add their reviewed timing below.`);
      })}>Render selected pages</button><button disabled={working} onClick={() => { void pdf.reader.close(); setPdf(undefined); }}>Cancel PDF import</button></div>
    </section>}
    <section className="block" aria-labelledby="selected-title"><div className="section-heading"><h2 id="selected-title">Selected sources</h2><span className="caption">{bundle.assets.length} files · {(bundle.assets.reduce((sum, a) => sum + byteSize(a), 0) / 1024 / 1024).toFixed(1)} MB</span></div>
      {!bundle.assets.length ? <p className="empty-copy">Your sources will appear here. We never invent an example lecture in your queue.</p> : <ul className="asset-list">{bundle.assets.map(asset => <li key={asset.id}>
        <div><strong>{asset.name}</strong><span className="caption">{acquisitionLabels[asset.acquisition]} · {asset.mime} · {(byteSize(asset) / 1024).toFixed(0)} KB{asset.durationMs ? ` · ${timeLabel(asset.durationMs)} source audio` : ''}{asset.width ? ` · ${asset.width} × ${asset.height}` : ''}</span></div>
        <button className="text-button" disabled={busy || working} onClick={() => remove(asset.id)}>Remove<span className="sr-only"> {asset.name}</span></button>
      </li>)}</ul>}
      {bundle.assets.filter(a => a.mime.startsWith('audio/')).length > 0 && <div className="field-row"><label>Original source audio<select value={bundle.audioAssetId} onChange={e => update({...bundle, audioAssetId: e.target.value})}>{bundle.assets.filter(a => a.mime.startsWith('audio/')).map(a => <option value={a.id} key={a.id}>{a.name}</option>)}</select></label><button disabled={!audio || working} onClick={() => audio && onPreview(audio)}>Play original audio</button></div>}
      {step === 'find' && <button className="primary" disabled={!bundle.assets.length || !!pdf || working} onClick={onPrepare}>Review &amp; prepare <span aria-hidden="true">→</span></button>}
    </section>
    {step === 'prepare' && <>
      <section className="block" aria-labelledby="captions-title"><p className="eyebrow">02 / listen to the evidence first</p><h2 id="captions-title">Keep meaning. Remove guesswork.</h2>
        <p>The selected transcript guides semantic processing. Supplied captions are not a recording verification: numbers, maths and negations may still need source-audio review.</p>
        <label>Transcript source<select value={bundle.transcriptAssetId ?? ''} onChange={event => { const asset = bundle.assets.find(a => a.id === event.target.value); update({...bundle, transcriptAssetId: asset?.id, cues: asset ? parseVtt(new TextDecoder().decode(base64Bytes(asset.base64)), duration || undefined) : []}); }}><option value="">No timed captions — request transcription after saving</option>{bundle.assets.filter(a => a.mime === 'text/vtt').map(a => <option value={a.id} key={a.id}>{a.name} — supplied captions</option>)}</select></label>
        {transcript ? <details><summary>Review or correct supplied WEBVTT captions</summary><label>Timestamped captions<textarea className="mono-input" rows={12} value={vtt} maxLength={1_048_576} onChange={event => update({...bundle, assets: bundle.assets.map(a => a.id === transcript.id ? {...a, sha256: undefined, base64: bytesToBase64(new TextEncoder().encode(event.target.value))} : a)})}/></label><p className="caption">Corrections create a new input revision when saved. Timings are checked against the original audio.</p></details> : <p className="notice">No timed captions selected. Save the sources, then explicitly consent to transcription below. Plain text is never assigned invented timestamps.</p>}
      </section>
      <section className="block" aria-labelledby="timeline-title"><h2 id="timeline-title">When is each visual on screen?</h2><p>Use source-audio seconds, not adapted playback time. You can choose the same earlier image again. A static slide cannot supply an invisible pointer.</p>
        <div className="visual-grid">{images.map(image => <figure key={image.id}><img src={`data:${image.mime};base64,${image.base64}`} alt={`Selected source image: ${image.name}. Visual meaning is not yet verified.`}/><figcaption>{image.name}</figcaption></figure>)}</div>
        <ol className="timeline-list">{bundle.timeline.map((entry, index) => <li key={entry.id}>
          <span className="eyebrow">Interval {index + 1}</span>
          <label>Source image<select value={entry.assetId} onChange={event => changeInterval(entry.id, {assetId: event.target.value, stateId: event.target.value})}><option value="">Choose an image</option>{images.map(image => <option key={image.id} value={image.id}>{image.name}</option>)}</select></label>
          <div className="field-row"><label>Starts at (seconds)<input type="number" min="0" max="180" step="0.001" value={entry.startMs / 1000} onChange={event => changeInterval(entry.id, {startMs: Math.round(Number(event.target.value) * 1000)})}/></label><label>Ends at (seconds)<input type="number" min="0" max="180" step="0.001" value={entry.endMs / 1000} onChange={event => changeInterval(entry.id, {endMs: Math.round(Number(event.target.value) * 1000)})}/></label></div>
          <button className="text-button" onClick={() => update({...bundle, timeline: bundle.timeline.filter(row => row.id !== entry.id)})}>Remove interval {index + 1}</button>
        </li>)}</ol>
        <button disabled={!images.length || bundle.timeline.length >= 30 || working} onClick={() => {
          const previousEnd = bundle.timeline.at(-1)?.endMs ?? 0;
          update({...bundle, timeline: [...bundle.timeline, {id: `interval-${crypto.randomUUID()}`, stateId: images[0].id, assetId: images[0].id, startMs: Math.min(previousEnd, Math.max(0, duration - 1000)), endMs: duration, alignment: 'suggested'}]});
        }}>Add visual interval</button>
        {problems.length > 0 && <ul className="validation-list">{problems.map(problem => <li key={problem}>{problem}</li>)}</ul>}
        {!!bundle.context?.length && <details><summary>Selected PDF text / course context ({bundle.context.length})</summary>{bundle.context.map(context => <div className="subblock" key={context.id}><p className="source-text">{context.text}</p><button className="text-button" onClick={() => update({...bundle, context: bundle.context?.filter(c => c.id !== context.id)})}>Remove this context</button></div>)}</details>}
        {bundle.capture?.text && !bundle.context?.some(c => c.id === 'selected-course-section') && <label className="check"><input type="checkbox" checked={false} onChange={event => { if (event.target.checked) update({...bundle, context: [...(bundle.context ?? []), {id: 'selected-course-section', text: bundle.capture!.text}]}); }}/><span>Also include the previewed course-section text as selected context. It is not a licence to invent lecture content.</span></label>}
        <label className="check review-check"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} disabled={problems.length > 0 || !audio}/><span>I checked the images and source-time intervals, including any return to an earlier slide.</span></label>
        <button className="primary" disabled={!dirty || !reviewed || !!problems.length || working || busy} onClick={() => void save()}>{working ? 'Checking sources…' : 'Save reviewed source revision'}</button>
        {!dirty && <p className="caption">Saved source revision. Change a source only if you intend to regenerate; old audio will be marked stale.</p>}
      </section>
    </>}
    {working && <p className="caption" role="status">Checking selected material locally…</p>}
  </div>;
}
