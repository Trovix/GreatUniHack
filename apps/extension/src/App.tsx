import { useCallback, useEffect, useRef, useState } from 'react';
import type { Lecture } from '../../api/types';
import type { Asset, Bundle } from '../../../packages/core/index';
import { ApiError, LocalApi, forgetToken, rememberToken, restoreToken, restoreUi, saveUi, workerMessage, type AnswerResult, type Capabilities, type Fixture } from './api';
import { AudioOwner, type AudioState } from './audio';
import { Editor, emptyBundle } from './Editor';
import { base64Bytes } from './ingest';
import { addToBatch, batchLecture, canListen, currentChunks, hasSourceBytes, isCurrent, labelStatus, mergeLectureSummary, nextBatch, readySnapshot, shortcutAction, timeLabel, type Batch, type Step } from './model';

type ResumePoint = {lectureId: string; revision: number; segmentId: string; offset: number};
const keyFor = (lecture: Lecture, segmentId: string) => `${lecture.id}|${lecture.revision}|${segmentId}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : 'That action could not be completed.';
export function App() {
  const [api, setApi] = useState<LocalApi>();
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [tokenInput, setTokenInput] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [fixtureId, setFixtureId] = useState('');
  const [activeId, setActiveId] = useState<string>();
  const [step, setStep] = useState<Step>('find');
  const [draft, setDraft] = useState<Bundle>();
  const [draftKey, setDraftKey] = useState('');
  const [dirty, setDirty] = useState(false);
  const [batch, setBatch] = useState<Batch>();
  const [segmentId, setSegmentId] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('Pair this browser session to begin. Nothing plays automatically.');
  const [error, setError] = useState('');
  const [consent, setConsent] = useState({compile: false, tts: false, stt: false, question: false});
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AnswerResult>();
  const [resume, setResume] = useState<ResumePoint>();
  const [owner] = useState(() => new AudioOwner());
  const [sound, setSound] = useState<AudioState>(owner.snapshot());
  const [hydrated, setHydrated] = useState(false);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const active = lectures.find(l => l.id === activeId);
  const current = useRef({api, lectures, active, dirty, batch, segmentId, resume});
  current.current = {api, lectures, active, dirty, batch, segmentId, resume};
  const activeRef = useRef<string | undefined>(undefined);
  const oldStatuses = useRef(new Map<string, string>());
  const apply = useCallback((lecture: Lecture) => setLectures(old => old.some(l => l.id === lecture.id) ? old.map(l => {
    if (l.id !== lecture.id) return l;
    if (l.revision > lecture.revision) return l;
    return l.revision === lecture.revision && l.updatedAt > lecture.updatedAt ? mergeLectureSummary(l, lecture) : mergeLectureSummary(lecture, l);
  }) : [...old, lecture]), []);
  const positionWrites = useRef(Promise.resolve());
  const taskRunning = useRef(false);
  const fail = useCallback((value: unknown) => {
    owner.pause(); setError(errorText(value));
    if (value instanceof ApiError && value.status === 401) { setApi(undefined); void forgetToken(); }
  }, [owner]);
  const task = async (label: string, operation: () => Promise<void>) => {
    if (taskRunning.current) return;
    taskRunning.current = true; setBusy(label); setError('');
    try { await operation(); } catch (value) { fail(value); } finally { taskRunning.current = false; setBusy(''); }
  };
  const persistPosition = useCallback((state = owner.snapshot()) => {
    const now = current.current;
    if (!now.api || now.dirty || !now.active || state.kind !== 'explanation' || !isCurrent(now.active)) return;
    const segment = now.active.compilation?.segments.find(s => keyFor(now.active!, s.id) === state.key);
    if (segment) {
      const client = now.api, id = now.active.id;
      // Serialize writes so a delayed old segment cannot overwrite the precise Q&A resume point.
      positionWrites.current = positionWrites.current.then(async () => { await client.playback(id, segment.id, state.offset, state.rate); }).catch(() => {
        setError('Playback is paused locally, but its saved position could not reach the service. Keep this workspace open and reconnect before reloading.');
      });
    }
  }, [owner]);
  const stop = useCallback(() => { persistPosition(); owner.stop(); setBatch(undefined); setNotice('Audio stopped. Playback only starts when you ask.'); }, [owner, persistPosition]);
  const rememberExplanation = useCallback((): ResumePoint | undefined => {
    const now = current.current; const state = owner.snapshot();
    if (!now.active || !canListen(now.active) || now.dirty) return undefined;
    const segment = now.active.compilation?.segments.find(s => s.id === now.segmentId && keyFor(now.active!, s.id) === state.key && state.kind === 'explanation');
    const point = segment ? {lectureId: now.active.id, revision: now.active.revision, segmentId: segment.id, offset: state.offset} :
      now.resume?.lectureId === now.active.id && now.resume.revision === now.active.revision ? now.resume :
      {lectureId: now.active.id, revision: now.active.revision, segmentId: now.segmentId || now.active.compilation!.segments[0].id, offset: now.active.playback?.segmentId === now.segmentId ? now.active.playback.offset : 0};
    setResume(point); persistPosition(state); return point;
  }, [owner, persistPosition]);
  const play = useCallback(async (lecture: Lecture, requestedSegment?: string, offset = 0) => {
    const now = current.current;
    if (!now.api || !canListen(lecture) || (now.active?.id === lecture.id && now.dirty)) throw new Error('This source version is not playable. Save and regenerate the current input first.');
    const segment = lecture.compilation!.segments.find(s => s.id === requestedSegment) ?? lecture.compilation!.segments[0];
    const chunk = currentChunks(lecture).find(c => c.segmentId === segment.id);
    if (!chunk) throw new Error('This checked segment has no current audio yet.');
    setActiveId(lecture.id); setSegmentId(segment.id); setStep('listen');
    setNotice(lecture.status === 'incomplete' ? 'Playing an incomplete adaptation. Specific source limitations are included in its narration and transcript.' : 'Playing the source-grounded adaptation.');
    await owner.start({key: keyFor(lecture, segment.id), kind: 'explanation', blob: signal => now.api!.audio(lecture.id, chunk.id, signal)}, offset);
    persistPosition();
  }, [owner, persistPosition]);
  const toggle = useCallback(() => {
    const state = owner.snapshot();
    if (state.playing || state.loading) { persistPosition(state); owner.pause(); setNotice('Paused.'); return; }
    const now = current.current;
    if (!now.active) return;
    const saved = now.resume?.lectureId === now.active.id && now.resume.revision === now.active.revision ? now.resume : undefined;
    const offset = state.kind === 'explanation' && state.key === keyFor(now.active, now.segmentId) ? state.offset : saved?.segmentId === now.segmentId ? saved.offset : now.active.playback?.segmentId === now.segmentId ? now.active.playback.offset : 0;
    void play(now.active, now.segmentId, offset).catch(fail);
  }, [owner, persistPosition, play, fail]);

  useEffect(() => {
    let live = true;
    void Promise.all([restoreUi(), restoreToken().catch(() => '')]).then(async ([saved, token]) => {
      if (!live) return;
      setActiveId(saved.activeId); setBatch(saved.batch); setStep(saved.step ?? 'find'); setHydrated(true);
      if (token) {
        try { const client = new LocalApi(token); const caps = await client.capabilities(); if (!live) return; setCapabilities(caps); setApi(client); setNotice('Local service paired. Saved positions are restored paused.'); }
        catch (value) { if (live) setError(errorText(value)); }
      }
    });
    const unsubscribe = owner.subscribe(setSound); owner.onError(fail);
    return () => { live = false; unsubscribe(); owner.pause(); };
  }, [owner, fail]);
  useEffect(() => { if (hydrated) void saveUi({activeId, step, batch}); }, [hydrated, activeId, step, batch]);
  useEffect(() => {
    if (!api) return;
    let alive = true, loading = false;
    const refresh = async () => {
      if (loading) return; loading = true;
      try {
        const list = await api.lectures();
        if (!alive) return;
        const newlyReady = list.filter(l => canListen(l) && oldStatuses.current.has(l.id) && oldStatuses.current.get(l.id) !== l.status);
        oldStatuses.current = new Map(list.map(l => [l.id, l.status]));
        setLectures(previous => list.map(summary => mergeLectureSummary(summary, previous.find(item => item.id === summary.id))));
        if (current.current.active && !list.some(item => item.id === current.current.active!.id)) {
          owner.stop(); setActiveId(undefined); setDraft(undefined); setDirty(false); setBatch(undefined); activeRef.current = undefined;
          setNotice('The selected lecture was deleted. Its audio and pending UI state have been cleared.');
        }
        if (newlyReady.length) setNotice(`${newlyReady.map(l => l.title).join(', ')} is ready. It will not join an existing playback batch unless you choose Add to playback.`);
        if (!current.current.active && list.length && !activeRef.current) { setActiveId(list[0].id); activeRef.current = list[0].id; }
      } catch (value) { if (alive) fail(value); } finally { loading = false; }
    };
    void refresh(); void api.fixtures().then(list => { if (alive) setFixtures(list); }).catch(() => {});
    const timer = setInterval(() => { void refresh(); }, 2500);
    return () => { alive = false; clearInterval(timer); };
  }, [api, fail]);
  useEffect(() => {
    if (!active || !api) { setDraft(undefined); setDraftKey(''); return; }
    let alive = true;
    const id = active.id, revision = active.revision;
    // Batch continuation may already own the next lecture; do not cancel its explicit start.
    const continuing = owner.snapshot().key?.startsWith(`${id}|${revision}|`);
    if (!continuing) owner.pause();
    setDraft(undefined); setDraftKey(''); setDirty(false); setAnswer(undefined); setResume(undefined); setQuestion('');
    setConsent({compile: false, tts: false, stt: false, question: false});
    setSegmentId(active.compilation?.segments.find(item => keyFor(active, item.id) === owner.snapshot().key)?.id ?? active.playback?.segmentId ?? active.compilation?.segments[0]?.id ?? '');
    if (!continuing) owner.rate(active.playback?.rate ?? 1);
    activeRef.current = id;
    // GET /lectures is deliberately compact: source bytes MUST be fetched before editing.
    void api.lecture(id).then(detail => {
      if (!alive || detail.revision !== revision) return;
      if (!hasSourceBytes(detail)) throw new Error('The service returned source metadata without bytes. Reconnect before editing this lecture.');
      apply(detail); setDraft(detail.bundle ?? emptyBundle(detail.title)); setDraftKey(`${id}|${revision}`);
      setSegmentId(old => old || detail.playback?.segmentId || detail.compilation?.segments[0]?.id || '');
      if (detail.playback && canListen(detail) && !continuing) setResume({lectureId: id, revision, segmentId: detail.playback.segmentId, offset: detail.playback.offset});
    }).catch(value => { if (alive) fail(value); });
    return () => { alive = false; };
  }, [active?.id, active?.revision, api, owner, apply, fail]);
  useEffect(() => {
    if (active?.compilation && !segmentId) setSegmentId(active.compilation.segments[0]?.id ?? '');
    if (sound.kind === 'explanation' && active && (!canListen(active) || dirty || !active.compilation?.segments.some(s => keyFor(active, s.id) === sound.key))) owner.pause();
  }, [active?.status, active?.compilation, active?.revision, segmentId, sound.key, sound.kind, dirty, owner]);
  useEffect(() => {
    owner.onEnded(state => {
      const now = current.current;
      if (state.kind !== 'explanation' || !now.active || now.dirty || !canListen(now.active)) return;
      const index = now.active.compilation!.segments.findIndex(s => keyFor(now.active!, s.id) === state.key);
      if (index < 0) return;
      const next = now.active.compilation!.segments[index + 1];
      if (next) { void play(now.active, next.id).catch(fail); return; }
      const item = now.batch?.items[now.batch.cursor];
      if (now.batch && item?.lectureId === now.active.id && item.revision === now.active.revision) {
        const following = nextBatch(now.batch, now.lectures); setBatch(following.batch);
        if (following.lecture) void play(following.lecture).catch(fail); else setNotice('Your explicitly started playback batch is complete.');
      } else setNotice('Lecture finished. Choose what to listen to next.');
    });
  }, [owner, play, fail]);
  useEffect(() => {
    const timer = setInterval(() => { if (owner.snapshot().playing) persistPosition(); }, 1000);
    const hidden = () => persistPosition(); window.addEventListener('pagehide', hidden);
    const keyboard = (event: KeyboardEvent) => {
      const action = shortcutAction(event);
      if (action === 'stop') { stop(); }
      if (action === 'toggle' && current.current.active && canListen(current.current.active) && !current.current.dirty) { event.preventDefault(); toggle(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => { clearInterval(timer); window.removeEventListener('pagehide', hidden); document.removeEventListener('keydown', keyboard); };
  }, [owner, persistPosition, stop, toggle]);

  const chooseLecture = (lecture: Lecture) => {
    if (dirty && !window.confirm('Discard the unsaved source edits for this lecture?')) return;
    persistPosition(); owner.pause(); setActiveId(lecture.id); setBatch(undefined); setStep(canListen(lecture) ? 'listen' : lecture.bundle ? 'prepare' : 'find'); setError('');
  };
  const edit = (next: Bundle) => { persistPosition(); owner.pause(); setDraft(next); setDirty(true); setAnswer(undefined); setResume(undefined); setConsent({compile: false, tts: false, stt: false, question: false}); };
  const sourcePreview = async (asset: Asset) => {
    rememberExplanation();
    await owner.start({key: `local-source|${active?.id}|${active?.revision}|${asset.id}|${asset.sha256 ?? asset.base64}`, kind: 'source', blob: async () => new Blob([base64Bytes(asset.base64)], {type: asset.mime})});
    setNotice('Playing original source audio, not the AI adaptation.');
  };
  const runAction = (action: 'compile' | 'synthesise' | 'transcribe') => {
    if (!active || dirty || !editorReady) return;
    if (active.unknownOutcome && !window.confirm('The previous submitted provider request has an unknown outcome. Retrying may incur another charge. Deliberately submit a new request?')) return;
    void task(action, async () => { owner.pause(); const lecture = await api!.action(active.id, active.revision, action); apply(lecture); setConsent(old => ({...old, [action === 'synthesise' ? 'tts' : action === 'transcribe' ? 'stt' : 'compile']: false})); setNotice(labelStatus(lecture.status)); });
  };
  const ask = async () => {
    if (!active || !question.trim() || !consent.question || dirty) return;
    const point = rememberExplanation(); owner.pause();
    if (!point) throw new Error('Select a current playable segment before asking a question.');
    const revision = active.revision, id = active.id;
    await positionWrites.current;
    const result = await api!.question(id, revision, question.trim(), point.segmentId, point.offset);
    const now = current.current;
    if (now.active?.id !== id || now.active.revision !== revision || now.dirty) { setNotice('The sources changed while answering. That old-version answer was not made current.'); return; }
    setAnswer(result); setNotice(`Answer ready in ${(result.latencyMs / 1000).toFixed(1)} seconds. Audio is paused; choose Play answer or Resume explanation.`); setConsent(old => ({...old, question: false}));
    apply(await api!.lecture(id));
  };
  const segment = active?.compilation?.segments.find(s => s.id === segmentId) ?? active?.compilation?.segments[0];
  const segments = active?.compilation?.segments ?? [];
  const index = segments.findIndex(s => s.id === segment?.id);
  const playable = !!active && canListen(active) && !dirty;
  const activeWork = !!active && ['queued','analysing','synthesising'].includes(active.status);
  const ready = lectures.filter(canListen);
  const totalMs = ready.reduce((sum, l) => sum + currentChunks(l).reduce((ms, c) => ms + c.durationMs, 0), 0);
  const soundLabel = sound.loading ? 'Loading selected audio' : sound.playing ? (sound.kind === 'source' ? 'Original source playing' : sound.kind === 'answer' ? 'Grounded answer playing' : 'Explanation playing') : activeWork ? labelStatus(active!.status) : 'Audio paused';
  const activeAnimation = sound.playing || sound.loading || activeWork;
  const realTime = sound.kind === 'explanation' && active && segment && sound.key === keyFor(active, segment.id) ? sound.offset : active?.playback && segment && active.playback.segmentId === segment.id ? active.playback.offset : 0;
  const editorReady = !!active && draftKey === `${active.id}|${active.revision}` && !!draft;
  const activeChunk = active && segment ? currentChunks(active).find(c => c.segmentId === segment.id) : undefined;
  const currentHistory = (active?.questions ?? []).filter((turn: unknown) => typeof turn === 'object' && turn !== null && ((turn as Record<string, unknown>).inputRevision ?? (turn as Record<string, unknown>).revision) === active?.revision);
  const archivedHistory = [...(active?.questions ?? []).filter(turn => !currentHistory.includes(turn)), ...(active?.history ?? []).flatMap(revision => revision.questions ?? [])];

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to lecture workspace</a><div className="inset-frame" aria-hidden="true" />
    <header className="brand-line"><div className="brand"><Mark/><span>Lecture Access</span></div><div className="header-tools"><span className="service-state">{api ? `${capabilities?.mode === 'mock' ? 'Offline mock' : 'Provider-ready'} · paired` : 'Local, until you choose'}</span><button className="text-button" onClick={() => void workerMessage({type: 'OPEN_WORKSPACE'}).catch(fail)}>Open workspace</button>{api && <button className="text-button" onClick={() => { stop(); setApi(undefined); setCapabilities(undefined); void forgetToken(); setNotice('Unpaired. Your local lectures remain on the service; this browser session no longer holds its token.'); }}>Unpair</button>}</div></header>
    <main id="main-content" className="workspace" tabIndex={-1}>
      <div className="workspace-main">
        {!api ? <section className="pairing block" aria-labelledby="pair-title"><p className="eyebrow">Your lecture. Your say.</p><h1 id="pair-title">Make the meaning<br/>clear without<br/><span className="outline-word">the slides.</span></h1><p className="intro">An audio-first explanation of your lecture — grounded in what was said and what was shown. Missing evidence stays a question, never a guess.</p><form onSubmit={event => { event.preventDefault(); void task('pairing', async () => {
          if (!tokenInput.trim()) throw new Error('Enter the pairing token shown by your local service.');
          setConnecting(true);
          try { const client = new LocalApi(tokenInput.trim()); const caps = await client.capabilities(); await rememberToken(tokenInput.trim()); setTokenInput(''); setApi(client); setCapabilities(caps); setNotice('Paired securely for this browser session. Choose source material to begin.'); }
          finally { setConnecting(false); }
        }); }}><label>Local service pairing token<input type="password" autoComplete="off" spellCheck={false} value={tokenInput} onChange={event => setTokenInput(event.target.value)} placeholder="Paste once for this browser session"/></label><button className="primary" disabled={connecting || !!busy}>{connecting ? 'Connecting…' : 'Pair local service'}</button></form><p className="caption">Service: 127.0.0.1:4317. The token is held only in trusted extension session storage, never in a URL or website storage. Browser restart may require re-pairing.</p><details><summary>Setup and privacy</summary><p>Start the local Lecture Access service, authorise this exact extension origin in its configuration, then paste its random pairing token. Capture/import remains local until you separately consent to analysis, transcription or speech. Provider retention may apply; local deletion does not erase provider copies.</p><p className="mono-input">Extension origin: {typeof chrome !== 'undefined' && chrome.runtime?.id ? `chrome-extension://${chrome.runtime.id}` : 'Install the unpacked extension first'}</p></details></section> : <>
          <nav className="steps" aria-label="Lecture workflow">{(['find','prepare','listen'] as Step[]).map((name, i) => <button key={name} aria-current={step === name ? 'step' : undefined} onClick={() => setStep(name)}><span className="step-number">0{i + 1}</span>{name[0].toUpperCase() + name.slice(1)}</button>)}</nav>
          {!active && <section className="block"><p className="eyebrow">A little preparation. A clearer listen.</p><h1>Start with<br/>one lecture.</h1><p className="intro">Bring the original audio, timed captions and the visual states it depends on. Prepare now. Listen when you’re ready.</p></section>}
          {step === 'find' && <section className="block"><form onSubmit={event => { event.preventDefault(); void task('creating', async () => { if (!title.trim()) throw new Error('Give this lecture a title.'); if (dirty && !window.confirm('Discard unsaved source edits and create another lecture?')) return; const lecture = await api.create(title.trim()); apply(lecture); setActiveId(lecture.id); setTitle(''); setNotice('Lecture created locally. Add the original audio, captions and slide images.'); }); }}><div className="field-row"><label>New lecture title<input required maxLength={160} value={title} placeholder="Course · topic or session" onChange={event => setTitle(event.target.value)}/></label><button disabled={!!busy}>Create lecture</button></div></form>
            {!!fixtures.length && <details><summary>Use an authored synthetic source</summary><p className="caption">Real source files, explicitly labelled synthetic. Preparation still uses the configured live or mock provider; no static answer is presented as generated.</p><div className="field-row"><label>Synthetic source<select value={fixtureId} onChange={event => setFixtureId(event.target.value)}><option value="">Choose a fixture</option>{fixtures.map(f => <option key={f.id} value={f.id}>{f.id} · {f.title}</option>)}</select></label><button disabled={!fixtureId || !!busy} onClick={() => void task('importing fixture', async () => { if (dirty && !window.confirm('Discard unsaved source edits and import this synthetic lecture?')) return; const lecture = await api.fixture(fixtureId); apply(lecture); setActiveId(lecture.id); setStep('prepare'); setNotice('Authored synthetic source loaded locally. It has not been compiled or spoken.'); })}>Load synthetic source</button></div></details>}
          </section>}
          {active && <div className="lecture-heading"><p className="eyebrow">{draft?.capture?.acquisition === 'browser_capture' ? 'Browser capture' : active.bundle?.assets.some(a => a.acquisition === 'synthetic_demo') ? 'Synthetic demo' : 'Selected lecture'} · input revision {active.revision}</p><h1 className="lecture-title">{active.title}</h1><p className={`status-line ${activeWork ? 'is-live' : ''}`}><span className="signal-dot" aria-hidden="true"/>{dirty ? 'Unsaved source changes — playback disabled' : labelStatus(active.status)}</p>{active.error && <p className="notice">{active.error}</p>}</div>}
          {active && !editorReady && step !== 'listen' && <p className="caption" role="status">Loading this revision’s original source bytes before editing…</p>}
          {active && draft && editorReady && step !== 'listen' && <Editor key={`${active.id}:${active.revision}`} bundle={draft} step={step} dirty={dirty} busy={!!busy} onChange={edit} onError={setError} onNotice={setNotice} onPreview={asset => { void sourcePreview(asset).catch(fail); }} onPrepare={() => setStep('prepare')} transcriptOrigin={active.transcriptOrigin} onSave={async bundle => {
            owner.pause(); await positionWrites.current;
            const saved = await api.input(active.id, active.revision, bundle);
            apply(saved); setDirty(false); setDraft(undefined); setDraftKey('');
            setNotice('Reviewed sources saved as a new input revision. Prior outputs remain archived, not current; regenerate before playback.');
          }}/ >}
          {active && step === 'prepare' && <>
            <section className="block" aria-labelledby="generation-title"><h2 id="generation-title">Prepare an explanation, not a summary.</h2><p className="caption">Configured mode: <strong>{capabilities?.mode === 'mock' ? 'Offline mock — visual limitations remain unresolved; not a live semantic test' : `${capabilities?.provider} · ${capabilities?.model}`}</strong>. Only selected material is used. AI analysis is fallible and does not certify accessibility.</p>
              {!active.bundle?.cues.length && <div className="consent-block"><h3>1 / Optional timed transcription</h3><label className="check"><input type="checkbox" checked={consent.stt} onChange={event => setConsent(old => ({...old, stt: event.target.checked}))}/><span>I permit the selected source audio to be sent to {capabilities?.mode === 'mock' ? 'the labelled offline transcription adapter' : 'ElevenLabs for timed transcription'}. This is separate from supplied captions and speech generation; provider retention may apply.</span></label><button disabled={!consent.stt || !capabilities?.stt || dirty || !editorReady || !!busy || activeWork || !active.bundle} onClick={() => runAction('transcribe')}>Transcribe selected audio</button>{!capabilities?.stt && <p className="caption">Transcription is not configured. Import valid WEBVTT captions to continue.</p>}</div>}
              <div className="consent-block"><h3>{active.bundle?.cues.length ? '1' : '2'} / Resolve the visual dependencies</h3><label className="check"><input type="checkbox" checked={consent.compile} onChange={event => setConsent(old => ({...old, compile: event.target.checked}))}/><span>I permit the selected captions, actual slide images and explicitly selected context for this revision to be sent to {capabilities?.mode === 'mock' ? 'the offline mock compiler' : capabilities?.provider || 'the configured analysis provider'}. No university login or private navigation URL is sent. Provider retention may apply.</span></label><button className="primary" disabled={!consent.compile || !(capabilities?.multimodal || capabilities?.mode === 'mock') || dirty || !editorReady || !!busy || activeWork || !active.bundle?.cues.length} onClick={() => runAction('compile')}>{capabilities?.mode === 'mock' ? 'Prepare labelled mock transcript' : 'Make audio independent of slides'}</button>{dirty && <p className="caption">Save the reviewed source revision first.</p>}{!capabilities?.multimodal && capabilities?.mode !== 'mock' && <p className="caption">Multimodal analysis is not configured. The service must configure a supported provider or explicit offline mock mode.</p>}</div>
              {active.compilation && isCurrent(active) && <div className="consent-block"><h3>Review, then make speech</h3><p>Read the descriptive script and any source limitations below. Generated audio is an AI adaptation, not the lecturer’s original recording.</p><label className="check"><input type="checkbox" checked={consent.tts} onChange={event => setConsent(old => ({...old, tts: event.target.checked}))}/><span>I reviewed this revision’s script and permit only its checked text to be sent to {capabilities?.mode === 'mock' ? 'the labelled local mock voice' : 'ElevenLabs'} for speech. This is not voice cloning. Provider retention may apply.</span></label><button disabled={!consent.tts || !capabilities?.tts || dirty || !editorReady || !!busy || activeWork} onClick={() => runAction('synthesise')}>{canListen(active) ? 'Check / reuse current speech' : 'Generate reviewed speech'}</button>{!capabilities?.tts && <p className="caption">Speech generation is not configured. The descriptive transcript remains available.</p>}</div>}
            </section>
            <Workflow lecture={active}/>
          </>}
          {active && step === 'listen' && <section className="block player" aria-labelledby="player-title"><p className="eyebrow">03 / no need to look</p><h2 id="player-title">Listen for<br/>the whole idea.</h2>
            {!playable ? <p className="notice">{dirty ? 'Save your source changes and regenerate before listening.' : active.status === 'stale' || !isCurrent(active) ? 'There is no current playable adaptation. Prepare the current source revision first.' : 'Speech is not ready for every checked segment. Review and generate it in Prepare.'}</p> : <>
              <div className="player-meta"><span>Segment {index + 1} of {segments.length}</span><span className="mono">{timeLabel(realTime * 1000)} / {timeLabel(activeChunk?.durationMs ?? 0)} adapted time</span></div>
              <label className="segment-select">Current adapted segment<select value={segment?.id ?? ''} onChange={event => { persistPosition(); owner.pause(); setSegmentId(event.target.value); setResume(undefined); }}>{segments.map((s, i) => <option key={s.id} value={s.id}>{i + 1}. {s.text.slice(0, 70)}{s.text.length > 70 ? '…' : ''}</option>)}</select></label>
              <p className="listening-text">{segment?.text}</p>
              <p className="caption">AI-generated adaptation · {active.compilation?.providerMode === 'mock' ? 'Offline mock analysis, not verified visual transformation' : 'Live analysis'} · {activeChunk?.mode === 'cached' ? `Cached audio · ${activeChunk.provider}` : activeChunk?.mode === 'mock' ? 'Mock / local voice — not ElevenLabs' : `${activeChunk?.provider || 'Configured provider'} audio`}{active.compilation?.sourceReview ? ` · source review: ${active.compilation.sourceReview.replaceAll('_',' ')}` : ''}</p>
              {active.status === 'incomplete' && <p className="notice"><strong>Incomplete source meaning.</strong> This version includes explicit limitations. Listen to them and inspect the ledger rather than assuming the missing evidence was resolved.</p>}
              <div className="player-controls"><button aria-label="Previous adapted segment" disabled={index <= 0} onClick={() => { rememberExplanation(); owner.pause(); setResume(undefined); setSegmentId(segments[index - 1].id); }}>Previous</button><button className="primary play-button" onClick={toggle}>{sound.playing || sound.loading ? 'Pause' : 'Play explanation'}</button><button aria-label="Next adapted segment" disabled={index >= segments.length - 1} onClick={() => { rememberExplanation(); owner.pause(); setResume(undefined); setSegmentId(segments[index + 1].id); }}>Next</button><button onClick={() => { if (active && segment) void play(active, segment.id, 0).catch(fail); }}>Repeat segment</button><button onClick={() => { if (sound.kind === 'explanation') { owner.seek(Math.max(0, sound.offset - 10)); persistPosition(); } }}>Rewind 10 seconds</button><button onClick={stop}>Stop audio</button></div>
              <div className="field-row"><label>Playback rate<select value={sound.rate} onChange={event => { owner.rate(Number(event.target.value)); persistPosition(); }}>{[.75,1,1.25,1.5,1.75,2].map(rate => <option key={rate} value={rate}>{rate}×</option>)}</select></label><button onClick={() => { rememberExplanation(); owner.pause(); questionRef.current?.focus(); }}>Ask about this segment</button></div>
              {!!resume && resume.lectureId === active.id && resume.revision === active.revision && <button className="text-button" onClick={() => void play(active, resume.segmentId, resume.offset).catch(fail)}>Resume explanation · exact saved segment at {timeLabel(resume.offset * 1000)}</button>}
              {segment && <details><summary>Where did this come from?</summary><p className="caption">These are original source times, not adapted playback times. Starting original audio pauses the explanation.</p>{segment.sourceRanges.map((range, n) => <div className="source-range" key={`${range.startMs}-${range.endMs}-${n}`}><span>Source {timeLabel(range.startMs)}–{timeLabel(range.endMs)}</span><button onClick={() => void task('opening source', async () => {
                rememberExplanation(); const audioId = active.bundle?.audioAssetId; if (!audioId) throw new Error('Original source audio is unavailable.');
                await owner.start({key: `source|${active.id}|${active.revision}|${range.startMs}`, kind: 'source', stopAt: range.endMs / 1000, blob: signal => api.asset(active.id, audioId, signal)}, range.startMs / 1000); setNotice('Playing the selected original source range. Resume explanation restores your exact adapted position.');
              })}>Play original range</button></div>)}<p>Aligned visual states: {segment.stateIds.join(', ') || 'No aligned state supplied'}</p><p>Evidence is listed in the descriptive transcript and ledger below.</p></details>}
              <form className="question-form" onSubmit={event => { event.preventDefault(); void task('answering', ask); }}><label>Ask the selected lecture<textarea ref={questionRef} rows={3} maxLength={2000} value={question} placeholder="What does the source establish here?" onChange={event => setQuestion(event.target.value)}/></label><label className="check"><input type="checkbox" checked={consent.question} onChange={event => setConsent(old => ({...old, question: event.target.checked}))}/><span>Answer this typed question from current-revision source evidence. I also permit the checked answer text to be sent to {capabilities?.mode === 'mock' ? 'the labelled mock voice' : 'ElevenLabs, if configured'} for optional speech. Retrieval is local; provider retention may apply to generated speech.</span></label><button className="primary" disabled={!question.trim() || !consent.question || !!busy}>Ask &amp; pause explanation</button></form>
              {answer && <section className="answer" aria-labelledby="answer-title"><h3 id="answer-title">{answer.answer.status === 'supported' ? 'Grounded answer' : 'Source limitation / conflict'}</h3><p>{answer.answer.text}</p><p className="caption">Evidence: {answer.answer.evidenceIds.join(', ') || 'No unsupported factual claim made'} · {(answer.latencyMs / 1000).toFixed(1)}s observed response{answer.chunk ? ` · ${answer.chunk.mode} audio` : ' · text answer, no audio generated'}</p><div className="button-row">{answer.chunk && <button onClick={() => void task('playing answer', async () => { rememberExplanation(); await owner.start({key: `answer|${active.id}|${active.revision}|${answer.chunk!.id}`, kind: 'answer', blob: signal => api.audio(active.id, answer.chunk!.id, signal)}); })}>Play answer</button>}{resume && <button onClick={() => void play(active, resume.segmentId, resume.offset).catch(fail)}>Resume explanation</button>}</div></section>}
              {!!currentHistory.length && <details><summary>Current-revision question history ({currentHistory.length})</summary><History turns={currentHistory}/></details>}{!!archivedHistory.length && <details><summary>Archived prior-revision history ({archivedHistory.length}) — not current evidence</summary><History turns={archivedHistory}/></details>}
            </>}
          </section>}
          {active?.compilation && <Transcript lecture={active} currentSegment={segment?.id} onChoose={id => { persistPosition(); owner.pause(); setResume(undefined); setSegmentId(id); setStep('listen'); }}/ >}
          {!!active?.history?.some(revision => revision.compilation) && <details className="block"><summary>Archived prior source revisions — not current or playable</summary>{active.history.filter(revision => revision.compilation).map(revision => <Transcript key={revision.revision} lecture={{...active, bundle: revision.bundle, compilation: revision.compilation}} archivedOverride onChoose={() => {}}/>)}</details>}
          {active && <section className="block local-management"><details><summary>Local lecture controls</summary><div className="button-row"><button disabled={!!busy} onClick={() => void task('cancelling', async () => { owner.pause(); setBatch(undefined); apply(await api.cancel(active.id)); setNotice('Local job cancelled. A submitted provider request may already have been billed; cancellation cannot promise remote deletion.'); })}>Cancel preparation</button><button disabled={!!busy} onClick={() => void task('deleting', async () => { if (!window.confirm(`Delete “${active.title}” and its locally owned derived files? Identical source bytes may remain for other lectures. Provider retention is not erased.`)) return; owner.stop(); const result = await api.delete(active.id); setLectures(old => old.filter(l => l.id !== active.id)); setActiveId(undefined); activeRef.current = undefined; setBatch(undefined); setDraft(undefined); setDirty(false); setStep('find'); setNotice(`${result.notice} Shared source blobs retained: ${result.sharedBlobsRetained}. Local deletion does not retrospectively erase provider retention.`); })}>Delete this lecture locally</button></div></details></section>}
        </>}
        {!!error && <section className="error-message" role="alert"><strong>Let’s fix that.</strong><p>{error}</p><button className="text-button" onClick={() => setError('')}>Dismiss message</button></section>}
        <p className="live-status" role="status" aria-live="polite" aria-atomic="true">{busy ? `${busy[0].toUpperCase()}${busy.slice(1)}…` : notice}</p>
      </div>
      <aside className="queue" aria-labelledby="queue-title"><div className="section-heading"><h2 id="queue-title">Your listening queue</h2><span className="caption">{lectures.length} {lectures.length === 1 ? 'lecture' : 'lectures'}</span></div>
        {!lectures.length ? <p className="empty-copy">Prepare a little ahead.<br/>Listen on your terms.<br/><span className="caption">Requested lectures and their real status will appear here.</span></p> : <ol className="queue-list">{lectures.map((lecture, n) => <li key={lecture.id} className={lecture.id === activeId ? 'selected-lecture' : ''}><span className="queue-number">{String(n + 1).padStart(2,'0')}</span><div className="queue-item"><button className="queue-title" aria-label={lecture.title} onClick={() => chooseLecture(lecture)} aria-current={lecture.id === activeId ? 'true' : undefined}>{lecture.title}</button><span className="caption">{labelStatus(lecture.status)} · rev {lecture.revision}</span>{canListen(lecture) && <span className="caption">{timeLabel(currentChunks(lecture).reduce((sum,c) => sum + c.durationMs,0))} adapted audio</span>}
          {batch && canListen(lecture) && !batch.items.some(i => i.lectureId === lecture.id && i.revision === lecture.revision) && <button className="text-button" onClick={() => { setBatch(addToBatch(batch, lecture)); setNotice(`${lecture.title} explicitly added to the end of playback.`); }}>Add to playback</button>}
          {['queued','analysing','synthesising'].includes(lecture.status) && <button className="text-button" disabled={!!busy} onClick={() => void task('cancelling queued lecture', async () => { if (activeId === lecture.id) owner.pause(); apply(await api!.cancel(lecture.id)); setNotice(`Cancelled ${lecture.title}. Other lectures are unchanged.`); })}>Cancel this request</button>}
        </div></li>)}</ol>}
        <button className="primary batch-button" disabled={!api || !ready.length || dirty} onClick={() => {
          const snapshot = readySnapshot(lectures); const first = batchLecture(snapshot.items[0], lectures); if (!first) return;
          setBatch(snapshot); void play(first).catch(fail);
        }}>Play ready lectures <span aria-hidden="true">→</span></button>
        <p className="caption">{ready.length ? `${ready.length} current ready ${ready.length === 1 ? 'lecture' : 'lectures'} · ${timeLabel(totalMs)} adapted audio. ` : ''}An explicit snapshot, never surprise autoplay. Newly completed lectures need “Add to playback”.</p>
        {batch && <div className="batch-note"><p className="caption">Playback snapshot: {Math.min(batch.cursor + 1,batch.items.length)} / {batch.items.length}. Reload restores it paused.</p><button className="text-button" onClick={stop}>Stop playback batch</button></div>}
        <div className="queue-footnote"><p className="eyebrow">Source first. Always.</p><p>Clear when the evidence is clear.<br/>Honest when it isn’t.</p></div>
      </aside>
    </main>
    <div className={`voice-circle ${activeAnimation ? 'is-active' : ''}`} aria-hidden="true"><svg viewBox="0 0 120 120"><g><path className="wave wave-back" d="M-120 60 Q-105 46 -90 60 T-60 60 T-30 60 T0 60 T30 60 T60 60 T90 60 T120 60 T150 60 T180 60 T210 60 T240 60"/><path className="wave wave-middle" d="M-100 60 Q-87.5 71 -75 60 T-50 60 T-25 60 T0 60 T25 60 T50 60 T75 60 T100 60 T125 60 T150 60 T175 60 T200 60 T225 60"/><path className="wave wave-front" d="M-100 60 Q-90 38 -80 60 T-60 60 T-40 60 T-20 60 T0 60 T20 60 T40 60 T60 60 T80 60 T100 60 T120 60 T140 60 T160 60 T180 60 T200 60 T220 60 T240 60 T260 60"/></g></svg></div>
    <footer className="audio-footer"><span className={`audio-label ${activeAnimation ? 'is-live' : ''}`}><span className="signal-dot" aria-hidden="true"/>{soundLabel}</span><button disabled={!sound.playing && !sound.loading} onClick={stop}>Stop</button><span className="keyboard-hint"><kbd>space</kbd> play / pause outside fields · <kbd>esc</kbd> stop</span></footer>
  </div>;
}
function Mark() { return <svg viewBox="0 0 100 100" width="30" height="30" aria-hidden="true"><path d="M8 56 V8 H92 V92 H44" fill="none" stroke="currentColor" strokeWidth="10"/><circle cx="22" cy="78" r="18" fill="currentColor"/><path d="M10 78 Q14 71 18 78 T26 78 T34 78" fill="none" stroke="white" strokeWidth="4.5" strokeLinecap="round"/></svg>; }
function Workflow({lecture}: {lecture: Lecture}) {
  return <section className="block workflow" aria-labelledby="workflow-title"><h3 id="workflow-title">The actual preparation</h3><p className="caption">Real service events, not estimated percentages. The source review and generation clocks are separate from listening time.</p>{lecture.events.length ? <ol>{lecture.events.map((event, index) => <li key={`${event.at}-${index}`}><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time><strong>{event.stage.replaceAll('_',' ')}</strong><span>{event.message}</span></li>)}</ol> : <p>No processing events yet. Save reviewed sources, then choose analysis.</p>}</section>;
}
function Transcript({lecture, currentSegment, onChoose, archivedOverride = false}: {lecture: Lecture; currentSegment?: string; onChoose: (id: string) => void; archivedOverride?: boolean}) {
  const compilation = lecture.compilation!; const archived = archivedOverride || !isCurrent(lecture);
  const titleId = `transcript-${lecture.id}-${compilation.inputRevision}${archived ? '-archived' : ''}`;
  return <section className="block transcript" aria-labelledby={titleId}><div className="section-heading"><h2 id={titleId}>Descriptive transcript</h2><span className="caption">{archived ? `Archived revision ${compilation.inputRevision} — not current / not playable` : `Current input revision ${compilation.inputRevision}`}</span></div>
    <p className="caption">AI-generated adaptation, not supplied captions or a verbatim recording. {compilation.providerMode === 'mock' ? 'Offline mock output does not verify visual dependency resolution.' : 'Grounding checks are fallible, not accessibility certification.'}</p>
    {compilation.segments.map((segment, index) => <article className={currentSegment === segment.id && !archived ? 'transcript-segment current-segment' : 'transcript-segment'} key={segment.id}><div className="section-heading"><h3>Segment {index + 1}</h3><span className="caption">{segment.status}</span></div><p>{segment.text}</p><p className="caption">Source: {segment.sourceRanges.map(r => `${timeLabel(r.startMs)}–${timeLabel(r.endMs)}`).join(', ')} · visual states: {segment.stateIds.join(', ') || 'none'}</p><details><summary>Claims and supporting evidence</summary>{segment.claimIds.map(id => {
      const claim = compilation.claims.find(c => c.id === id); if (!claim) return null;
      return <div className="evidence-item" key={id}><p><strong>{claim.kind.replaceAll('_',' ')}</strong> · {claim.meaning}</p><ul>{claim.evidenceIds.map(eid => {
        const evidence = compilation.evidence.find(e => e.id === eid); if (!evidence) return <li key={eid}>Unavailable evidence {eid}</li>;
        return <li key={eid}><span className="mono">{eid}</span> · {evidence.kind === 'speech' ? `Supplied / selected transcript ${evidence.cueId}: “${evidence.quote}”` : evidence.kind === 'visual' ? `AI visual observation of ${evidence.stateId}: ${evidence.observation}${evidence.extractedText ? ` · extracted text: ${evidence.extractedText}` : ''}` : `Selected context ${evidence.documentId}: “${evidence.quote}”`}</li>;
      })}</ul></div>;
    })}</details>{!archived && <button className="text-button" onClick={() => onChoose(segment.id)}>Select segment {index + 1} in player</button>}</article>)}
    <details className="ledger"><summary>Visual dependency ledger ({compilation.dependencies.length})</summary><p className="caption">A resolved ledger entry is a checked model claim, not proof that every visual dependency was found.</p>{compilation.dependencies.map(dependency => <div className="evidence-item" key={dependency.id}><h3>{dependency.question}</h3><p>{dependency.status.replaceAll('_',' ')}{dependency.essential ? ' · essential meaning' : ''}</p><p>{dependency.resolution || dependency.uncertaintyReason || 'No source-supported resolution recorded.'}</p><p className="caption">Cues {dependency.cueIds.join(', ')} · states {dependency.stateIds.join(', ')} · evidence {dependency.evidenceIds.join(', ') || 'none'}</p></div>)}</details>
  </section>;
}
function History({turns}: {turns: unknown[]}) {
  return <ol className="question-history">{turns.map((unknownTurn, index) => {
    const turn = unknownTurn as Record<string, unknown>; const answer = turn.answer as {text?: string; status?: string} | undefined;
    return <li key={String(turn.id ?? index)}><p><strong>{typeof turn.question === 'string' ? turn.question : 'Saved question'}</strong></p><p>{answer?.text ?? (typeof turn.text === 'string' ? turn.text : 'Answer retained in local lecture history.')}</p><p className="caption">Revision {String(turn.inputRevision ?? turn.revision ?? 'archived')} {answer?.status ? `· ${answer.status}` : ''}</p></li>;
  })}</ol>;
}
