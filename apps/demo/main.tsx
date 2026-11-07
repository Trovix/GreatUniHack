import React,{useEffect,useRef,useState} from 'react';
import{createRoot}from'react-dom/client';
import './style.css';
import {ProductText} from './ProductText';
import {Narration} from './Narration';
import {Trace} from './ActivityTrace';
import {preparationTitle} from './trace';
import type {Run} from './types';
import {stageFrame,stageTimeline,type PreparedStage} from './stage';
const stageMode=location.pathname.replace(/\/$/,'')==='/stage';
function App(){
 const[open,setOpen]=useState(false),[request,setRequest]=useState(''),[run,setRun]=useState<Run>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[showScript,setShowScript]=useState(false),[playing,setPlaying]=useState(false),[time,setTime]=useState(0),[duration,setDuration]=useState(0),[activityOpen,setActivityOpen]=useState(true);
 const[prepared,setPrepared]=useState<PreparedStage>();
 const replayTimer=useRef<ReturnType<typeof setInterval>|undefined>(undefined);
 const input=useRef<HTMLTextAreaElement>(null),audio=useRef<HTMLAudioElement>(null),stream=useRef<EventSource|undefined>(undefined);
 useEffect(()=>{const key=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();setOpen(true);requestAnimationFrame(()=>input.current?.focus());}if(e.key==='Escape'){audio.current?.pause();if(!busy&&!run)setOpen(false);}};document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);};},[busy,run]);
 useEffect(()=>{if(open&&!run)setTimeout(()=>input.current?.focus(),350);},[open,run]);
 useEffect(()=>()=>{stream.current?.close();clearInterval(replayTimer.current);},[]);
 useEffect(()=>{if(!stageMode)return;const controller=new AbortController();void fetch('/demo-api/stage',{signal:controller.signal}).then(async response=>{const value=await response.json();if(!response.ok)throw new Error(value.error||'This lecture is unavailable. Please reconnect and try again.');setPrepared(value);setRequest(value.run.request);}).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'This lecture is unavailable. Please reconnect and try again.');});return()=>controller.abort();},[]);
 const watch=(id:string)=>{stream.current?.close();const source=new EventSource('/demo-api/runs/'+id+'/events');stream.current=source;source.onmessage=event=>{const next=JSON.parse(event.data)as Run;setRun(next);setRequest(next.request);if(next.status!=='running'){setBusy(false);source.close();}};source.onerror=()=>{source.close();setBusy(false);setError('The local connection closed. Your request and any completed audio remain saved.');};};
 useEffect(()=>{if(stageMode)return;const id=new URLSearchParams(location.search).get('run');if(id&&/^[a-f0-9-]{36}$/.test(id)){setOpen(true);setBusy(true);watch(id);}},[]);

 async function start(e:React.FormEvent,refresh=true){e.preventDefault();if(!request.trim()||busy)return;audio.current?.pause();stream.current?.close();setBusy(true);setPlaying(false);setError('');setRun(undefined);setShowScript(false);setTime(0);setActivityOpen(true);
  if(stageMode){
   if(!prepared){setBusy(false);setError('This lecture is unavailable. Please reconnect and try again.');return;}
   clearInterval(replayTimer.current);if(audio.current)audio.current.currentTime=0;
   const timeline=stageTimeline(prepared.run),started=performance.now();setRun(stageFrame(prepared.run,timeline,0));
   replayTimer.current=setInterval(()=>{const elapsed=performance.now()-started;setRun(stageFrame(prepared.run,timeline,elapsed));if(elapsed>=prepared.durationMs){clearInterval(replayTimer.current);setBusy(false);}},50);
   return;
  }
  try{const response=await fetch('/demo-api/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request:request.trim(),refresh})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not start your request.');watch(data.id);}catch(e){setBusy(false);setError(e instanceof Error?e.message:'Could not start.');}}
 async function cancel(){if(!run)return;if(stageMode){clearInterval(replayTimer.current);setRun({...run,status:'cancelled'});setBusy(false);return;}await fetch('/demo-api/runs/'+run.id+'/cancel',{method:'POST'});}
 useEffect(()=>{if(run?.status==='ready')setActivityOpen(false);},[run?.id,run?.status]);
 const ready=run?.status==='ready';const active=busy||playing;const currentStage=run?{title:preparationTitle(run)}:undefined;
 const minutes=(v:number)=>`${Math.floor(v/60)}:${String(Math.floor(v%60)).padStart(2,'0')}`;
 return <main className={`canvas ${open?'is-open':''} ${run?'has-run':''} ${ready?'is-ready':''} ${stageMode?'is-stage':''}`}>
  <div className="frame" aria-hidden="true"/>
  <button className={`orb ${active?'is-active':''}`} aria-label={open?'Focus your lecture request':'Open lecture request. Command or Control K'} aria-keyshortcuts="Meta+K Control+K" onClick={()=>{setOpen(true);input.current?.focus();}}>
   <svg viewBox="0 0 120 120" aria-hidden="true"><defs><clipPath id="orb-clip"><circle cx="60" cy="60" r="48"/></clipPath></defs><g clipPath="url(#orb-clip)"><path className="back" d="M-60 60 Q-45 47 -30 60 T0 60 T30 60 T60 60 T90 60 T120 60 T150 60 T180 60"/><path className="middle" d="M-50 60 Q-37 73 -25 60 T0 60 T25 60 T50 60 T75 60 T100 60 T125 60 T150 60"/><path className="front" d="M-40 60 Q-30 40 -20 60 T0 60 T20 60 T40 60 T60 60 T80 60 T100 60 T120 60 T140 60 T160 60"/></g></svg>
  </button>
  {(stageMode&&prepared||!stageMode&&ready)&&<audio ref={audio} src={stageMode?prepared?.audioUrl:'/demo-api/runs/'+run?.id+'/audio'} preload={stageMode?'auto':'metadata'} onPlay={()=>{setPlaying(true);setActivityOpen(false);}} onPause={()=>setPlaying(false)} onTimeUpdate={e=>setTime(e.currentTarget.currentTime)} onLoadedMetadata={e=>setDuration(e.currentTarget.duration)} onEnded={()=>setPlaying(false)}/>}
  <div className="content-viewport">
  {open&&<div className="experience">
   {!run&&<div className="welcome"><p className="eyebrow">Earshot · A lecture, on your terms.</p><h1>What would you like to learn?</h1></div>}
   {run?<div className="submitted"><p><ProductText>{run.request}</ProductText></p></div>:<form className="request" onSubmit={start}>
    <label className="sr-only" htmlFor="request">Your lecture request</label><textarea id="request" ref={input} value={request} onChange={e=>setRequest(e.target.value)} readOnly={stageMode} placeholder="Teach me the content from my latest microeconomics lecture" rows={run?1:2} disabled={busy} maxLength={1200} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void start(e);}}}/>
    <button type="submit" disabled={busy||!request.trim()||stageMode&&!prepared} aria-label="Start learning"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7"/></svg></button>
   </form>}
   {!run&&<div className="request-foot"><span><ProductText>From your Moodle course to a lecture you can listen to.</ProductText></span><kbd>↵</kbd></div>}
   {error&&<p className="error" role="alert"><ProductText>{error}</ProductText></p>}
   {run&&<section className="work" aria-label="Agent activity">
    <header className="work-heading"><span className="status-dot"/><p><ProductText>{run.status==='ready'?'Ready when you are.':run.status==='error'?'Something needs your attention.':run.status==='cancelled'?'Request stopped.':currentStage?.title||'Working on your request'}</ProductText></p>{busy&&<button className="quiet" onClick={()=>void cancel()}>Stop</button>}</header>
    <Trace run={run} open={busy||activityOpen} onToggle={value=>{if(!busy)setActivityOpen(value);}}/>
    {run.error&&<div className="error" role="alert"><ProductText>{run.error}</ProductText><p>Your retrieved materials remain saved.</p></div>}
    {ready&&<article className="lesson"><div className="lesson-meta"><span>EARSHOT · YOUR LECTURE, RE-EXPLAINED</span><span>Narrated lesson</span></div><h1>{run.title}</h1><p className="course">{[run.course?.replace(/\s*\([^)]*Moodle[^)]*\)/i,''),run.date?.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?[,\s]+\d{1,2}\s+\w+\s+\d{4}\b/)?.[0]||run.date?.slice(0,60)].filter(Boolean).join(' · ')}</p>{run.scope&&<p className="scope" title={run.scope}>{run.scope.split('. ')[0]}</p>}
     <div className="player"><button className="play" aria-label={playing?'Pause lecture':'Play lecture'} onClick={()=>{if(audio.current){if(playing)audio.current.pause();else void audio.current.play().catch(()=>setError('Press Play again to allow audio.'));}}}>{playing?<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>:<svg viewBox="0 0 24 24"><path d="m8 4 12 8-12 8Z"/></svg>}</button><div className="seek"><input aria-label="Lecture playback position" type="range" min="0" max={duration||1} step="0.1" value={time} onChange={e=>{if(audio.current)audio.current.currentTime=Number(e.target.value);}}/><div><span>{minutes(time)}</span><span>{minutes(duration)}</span></div></div><select aria-label="Playback speed" defaultValue="1" onChange={e=>{if(audio.current)audio.current.playbackRate=Number(e.target.value);}}>{[.75,1,1.25,1.5,2].map(v=><option key={v} value={v}>{v}×</option>)}</select></div>
     {run.words?.length?<Narration words={run.words} audio={audio} playing={playing}/>:<p className="caption-notice">{run.captionNotice||'Synchronized text is unavailable for this recording. Read the full transcript below.'}</p>}
     <div className="lesson-links"><button className="quiet" onClick={()=>setShowScript(!showScript)}>{showScript?'Hide transcript':'Read transcript'} <span>↗</span></button><a href={stageMode?prepared?.audioUrl:'/demo-api/runs/'+run.id+'/audio'} download="lecture.wav">Save audio <span>↓</span></a></div>
     {showScript&&<div className="script">{run.script?.split('\n\n').map((p,i)=><p key={i}>{p}</p>)}</div>}
     {!!run.sources?.length&&<details className="sources"><summary>From your course materials <span>{run.sources.length}</span></summary>{run.sources.map((s,i)=><a key={i} href={s.url} target="_blank" rel="noreferrer"><span>{s.kind}</span><ProductText>{s.label}</ProductText><b>↗</b></a>)}</details>}
    </article>}
   </section>}
   {ready&&<button className="refresh quiet" onClick={e=>void start(e,true)}><ProductText>Prepare again</ProductText> <span>↻</span></button>}
   {run&&!busy&&<button className="again quiet" aria-label="Back to request" onClick={()=>{audio.current?.pause();setRun(undefined);setRequest(stageMode?prepared?.run.request||'':'');setError('');requestAnimationFrame(()=>input.current?.focus());}}>Back to request <span aria-hidden="true">↵</span></button>}
  </div>}
  </div>
  {open&&!run&&<button className="close" aria-label="Close request" onClick={()=>setOpen(false)}>esc</button>}
  <span className="sr-only" role="status" aria-live="polite">{busy?currentStage?.title:ready?'Your lecture is ready to play.':''}</span>
 </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
