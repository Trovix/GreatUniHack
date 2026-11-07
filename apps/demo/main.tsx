import React,{useEffect,useRef,useState} from 'react';
import{createRoot}from'react-dom/client';
import './style.css';
import {ProductText} from './ProductText';
import type {Activity} from './activity';
type Run={id:string;request:string;status:'running'|'ready'|'error'|'cancelled';events:Activity[];title?:string;course?:string;date?:string;sources?:{label:string;kind:string;url:string}[];script?:string;audio?:boolean;duration?:number;error?:string;scope?:string;activityNotice?:string};
function App(){
 const[open,setOpen]=useState(false),[request,setRequest]=useState(''),[run,setRun]=useState<Run>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[showScript,setShowScript]=useState(false),[playing,setPlaying]=useState(false),[time,setTime]=useState(0),[duration,setDuration]=useState(0),[activityOpen,setActivityOpen]=useState(true);
 const input=useRef<HTMLTextAreaElement>(null),audio=useRef<HTMLAudioElement>(null),stream=useRef<EventSource|undefined>(undefined),dialog=useRef<HTMLDivElement>(null),feed=useRef<HTMLOListElement>(null),follow=useRef(true);
 useEffect(()=>{const key=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();setOpen(true);requestAnimationFrame(()=>input.current?.focus());}if(e.key==='Escape'){audio.current?.pause();if(!busy&&!run)setOpen(false);}};document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);};},[busy,run]);
 useEffect(()=>{if(open&&!run)setTimeout(()=>input.current?.focus(),350);},[open,run]);
 useEffect(()=>()=>stream.current?.close(),[]);
 const watch=(id:string)=>{stream.current?.close();const source=new EventSource('/demo-api/runs/'+id+'/events');stream.current=source;source.onmessage=event=>{const next=JSON.parse(event.data)as Run;setRun(next);setRequest(next.request);if(next.status!=='running'){setBusy(false);source.close();}};source.onerror=()=>{source.close();setBusy(false);setError('The local connection closed. Your request and any completed audio remain saved.');};};
 useEffect(()=>{const id=new URLSearchParams(location.search).get('run');if(id&&/^[a-f0-9-]{36}$/.test(id)){setOpen(true);setBusy(true);watch(id);}},[]);

 async function start(e:React.FormEvent,refresh=false){e.preventDefault();if(!request.trim()||busy)return;audio.current?.pause();stream.current?.close();setBusy(true);setError('');setRun(undefined);setShowScript(false);setTime(0);setActivityOpen(true);follow.current=true;
  try{const response=await fetch('/demo-api/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request:request.trim(),refresh})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not start your request.');watch(data.id);}catch(e){setBusy(false);setError(e instanceof Error?e.message:'Could not start.');}}
 async function cancel(){if(!run)return;await fetch('/demo-api/runs/'+run.id+'/cancel',{method:'POST'});}
 useEffect(()=>{if(follow.current&&feed.current)feed.current.scrollTop=feed.current.scrollHeight;},[run?.events.length]);
 const ready=run?.status==='ready';const active=busy||playing;const currentStage=run?.events.slice().reverse().find(e=>e.status==='running');
 const minutes=(v:number)=>`${Math.floor(v/60)}:${String(Math.floor(v%60)).padStart(2,'0')}`;
 return <main className={`canvas ${open?'is-open':''} ${run?'has-run':''} ${ready?'is-ready':''}`}>
  <div className="frame" aria-hidden="true"/>
  <button className={`orb ${active?'is-active':''}`} aria-label={open?'Focus your lecture request':'Open lecture request. Command or Control K'} aria-keyshortcuts="Meta+K Control+K" onClick={()=>{setOpen(true);input.current?.focus();}}>
   <svg viewBox="0 0 120 120" aria-hidden="true"><defs><clipPath id="orb-clip"><circle cx="60" cy="60" r="48"/></clipPath></defs><g clipPath="url(#orb-clip)"><path className="back" d="M-60 60 Q-45 47 -30 60 T0 60 T30 60 T60 60 T90 60 T120 60 T150 60 T180 60"/><path className="middle" d="M-50 60 Q-37 73 -25 60 T0 60 T25 60 T50 60 T75 60 T100 60 T125 60 T150 60"/><path className="front" d="M-40 60 Q-30 40 -20 60 T0 60 T20 60 T40 60 T60 60 T80 60 T100 60 T120 60 T140 60 T160 60"/></g></svg>
  </button>
  {open&&<div className="experience" ref={dialog}>
   {!run&&<div className="welcome"><p className="eyebrow">A lecture, on your terms.</p><h1>What would you like to learn?</h1></div>}
   {run?<div className="submitted"><p><ProductText>{run.request}</ProductText></p></div>:<form className="request" onSubmit={start}>
    <label className="sr-only" htmlFor="request">Your lecture request</label><textarea id="request" ref={input} value={request} onChange={e=>setRequest(e.target.value)} placeholder="Teach me the content from my latest microeconomics lecture" rows={run?1:2} disabled={busy} maxLength={1200} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void start(e);}}}/>
    <button type="submit" disabled={busy||!request.trim()} aria-label="Start learning"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7"/></svg></button>
   </form>}
   {!run&&<div className="request-foot"><span><ProductText>From your Moodle course to a lecture you can listen to.</ProductText></span><kbd>↵</kbd></div>}
   {error&&<p className="error" role="alert"><ProductText>{error}</ProductText></p>}
   {run&&<section className="work" aria-label="Agent activity">
    <header className="work-heading"><span className="status-dot"/><p><ProductText>{run.status==='ready'?'Ready when you are.':run.status==='error'?'Something needs your attention.':run.status==='cancelled'?'Request stopped.':currentStage?.title||'Working on your request'}</ProductText></p>{busy&&<button className="quiet" onClick={()=>void cancel()}>Stop</button>}</header>
    <details className="completed-work" open={busy||activityOpen} onToggle={e=>{if(!busy)setActivityOpen(e.currentTarget.open);}}>
     <summary>Lecture activity <span>{run.events.filter(event=>event.status==='done').length} completed{run.events.some(event=>event.status==='error')?' · '+run.events.filter(event=>event.status==='error').length+' failed attempts':''}{busy?' · live':''}</span></summary>
     {run.activityNotice&&<p className="activity-notice" role="status">{run.activityNotice}</p>}
     <ol className="activity" ref={feed} role="log" aria-label="Lecture activity" onScroll={e=>{const list=e.currentTarget;follow.current=list.scrollHeight-list.scrollTop-list.clientHeight<60;}}>
      {run.events.map((event,index)=><li key={event.key||event.id} className={`${event.status} ${index===run.events.length-1?'latest':''}`}>
       <span className="activity-mark" aria-hidden="true">{event.status==='done'?'✓':event.status==='error'?'!':<span/>}</span>
       <div className="activity-copy"><p className="activity-title"><ProductText>{event.title}</ProductText></p>
        {event.detail&&<p className="activity-detail"><ProductText>{event.detail}</ProductText></p>}
        <p className="activity-context">{event.agent&&<span>{event.agent}</span>}<time dateTime={event.at}>{new Date(event.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time>{event.status==='error'&&<span>Attempt failed</span>}{event.finishedAt&&<span>{Math.max(0,(Date.parse(event.finishedAt)-Date.parse(event.at))/1000).toFixed(1)}s</span>}</p>
       </div>
      </li>)}
     </ol>
    </details>
    {run.error&&<div className="error" role="alert"><ProductText>{run.error}</ProductText><p>Your retrieved materials remain saved.</p></div>}
    {ready&&<article className="lesson"><div className="lesson-meta"><span>YOUR LECTURE, RE-EXPLAINED</span><span>Narrated lesson</span></div><h1>{run.title}</h1><p className="course">{[run.course?.replace(/\s*\([^)]*Moodle[^)]*\)/i,''),run.date?.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?[,\s]+\d{1,2}\s+\w+\s+\d{4}\b/)?.[0]||run.date?.slice(0,60)].filter(Boolean).join(' · ')}</p>{run.scope&&<p className="scope" title={run.scope}>{run.scope.split('. ')[0]}</p>}
     <audio ref={audio} src={'/demo-api/runs/'+run.id+'/audio'} preload="metadata" onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onTimeUpdate={e=>setTime(e.currentTarget.currentTime)} onLoadedMetadata={e=>setDuration(e.currentTarget.duration)} onEnded={()=>setPlaying(false)}/>
     <div className="player"><button className="play" aria-label={playing?'Pause lecture':'Play lecture'} onClick={()=>{if(audio.current){if(playing)audio.current.pause();else void audio.current.play().catch(()=>setError('Press Play again to allow audio.'));}}}>{playing?<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>:<svg viewBox="0 0 24 24"><path d="m8 4 12 8-12 8Z"/></svg>}</button><div className="seek"><input aria-label="Lecture playback position" type="range" min="0" max={duration||1} step="0.1" value={time} onChange={e=>{if(audio.current)audio.current.currentTime=Number(e.target.value);}}/><div><span>{minutes(time)}</span><span>{minutes(duration)}</span></div></div><select aria-label="Playback speed" defaultValue="1" onChange={e=>{if(audio.current)audio.current.playbackRate=Number(e.target.value);}}>{[.75,1,1.25,1.5,2].map(v=><option key={v} value={v}>{v}×</option>)}</select></div>
     <div className="lesson-links"><button className="quiet" onClick={()=>setShowScript(!showScript)}>{showScript?'Hide transcript':'Read transcript'} <span>↗</span></button><a href={'/demo-api/runs/'+run.id+'/audio'} download="lecture.wav">Save audio <span>↓</span></a></div>
     {showScript&&<div className="script">{run.script?.split('\n\n').map((p,i)=><p key={i}>{p}</p>)}</div>}
     {!!run.sources?.length&&<details className="sources"><summary>From your course materials <span>{run.sources.length}</span></summary>{run.sources.map((s,i)=><a key={i} href={s.url} target="_blank" rel="noreferrer"><span>{s.kind}</span><ProductText>{s.label}</ProductText><b>↗</b></a>)}</details>}
    </article>}
   </section>}
   {ready&&<button className="refresh quiet" onClick={e=>void start(e,true)}><ProductText>Refresh from Moodle</ProductText> <span>↻</span></button>}
   {run&&!busy&&<button className="again quiet" onClick={()=>{audio.current?.pause();setRun(undefined);setRequest('');setError('');requestAnimationFrame(()=>input.current?.focus());}}>Ask for another lecture <span>↵</span></button>}
  </div>}
  {open&&!run&&<button className="close" aria-label="Close request" onClick={()=>setOpen(false)}>esc</button>}
  <span className="sr-only" role="status" aria-live="polite">{busy?currentStage?.title:ready?'Your lecture is ready to play.':''}</span>
 </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
