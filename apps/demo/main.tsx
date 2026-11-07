import React,{useEffect,useMemo,useRef,useState} from 'react';
import{createRoot}from'react-dom/client';
import './style.css';
import {ProductText} from './ProductText';
import {Narration} from './Narration';
import {OrbArt} from './OrbArt';
import {Trace} from './ActivityTrace';
import {preparationTitle,tracePhases} from './trace';
import type {Run} from './types';
import {stageFrame,stageTimeline,type PreparedStage} from './stage';
import {browserRecognition,createVoice,recognise,record,transcribe,VoiceInputError} from './voice';
import {cueText,nextSpeed,parseCommand,speak,speeds,spokenCourse,stepCues,stillCues,type CueName} from './voice-commands';
const stageMode=location.pathname.replace(/\/$/,'')==='/stage';
type Lecture={id:string;request:string;status:Run['status'];title?:string;course?:string;date?:string;duration?:number;at?:string};
type Listen='idle'|'listening'|'transcribing';
const minutes=(v:number)=>`${Math.floor(v/60)}:${String(Math.floor(v%60)).padStart(2,'0')}`;
const shortWhen=(at?:string)=>{const date=at?new Date(at):undefined;if(!date||Number.isNaN(date.getTime()))return'';const time=date.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});return new Date().toDateString()===date.toDateString()?`Today ${time}`:`${date.toLocaleDateString('en-GB',{day:'numeric',month:'short'})} ${time}`;};
const typing=(target:EventTarget|null)=>target instanceof HTMLElement&&(target.isContentEditable||['INPUT','SELECT','BUTTON','A','SUMMARY'].includes(target.tagName)||target.tagName==='TEXTAREA'&&!!(target as HTMLTextAreaElement).value);

function App(){
 const[open,setOpen]=useState(false),[request,setRequest]=useState(''),[run,setRun]=useState<Run>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[showScript,setShowScript]=useState(false),[playing,setPlaying]=useState(false),[time,setTime]=useState(0),[duration,setDuration]=useState(0),[activityOpen,setActivityOpen]=useState(true);
 const[prepared,setPrepared]=useState<PreparedStage>();
 const[rate,setRate]=useState(1),[source,setSource]=useState<'stage'|'saved'>('stage');
 const[listen,setListenState]=useState<Listen>('idle'),[pushToTalk,setPushToTalk]=useState(false),[heard,setHeard]=useState(''),[note,setNote]=useState('');
 const[library,setLibrary]=useState<Lecture[]>([]),[libraryOpen,setLibraryOpen]=useState(false);
 const replayTimer=useRef<ReturnType<typeof setInterval>|undefined>(undefined);
 const input=useRef<HTMLTextAreaElement>(null),audio=useRef<HTMLAudioElement>(null),stream=useRef<EventSource|undefined>(undefined),orb=useRef<HTMLButtonElement>(null),download=useRef<HTMLAnchorElement>(null);
 const voice=useMemo(()=>createVoice(),[]);
 const voiceMode=useRef(false),recording=useRef<{stop():void;cancel():void}|undefined>(undefined),listenRef=useRef<Listen>('idle'),released=useRef(false),resumeAfter=useRef(false);
 const announced=useRef({phase:-1,status:'',at:0});
 const ready=run?.status==='ready';
 const live=useRef({run,busy,ready,time,duration,rate,libraryOpen});live.current={run,busy,ready,time,duration,rate,libraryOpen};
 const setListen=(value:Listen)=>{listenRef.current=value;setListenState(value);};

 useEffect(()=>{if(open&&!run&&listenRef.current==='idle')setTimeout(()=>{if(listenRef.current==='idle')input.current?.focus();},350);},[open,run]);
 useEffect(()=>()=>{stream.current?.close();clearInterval(replayTimer.current);recording.current?.cancel();voice.silence();},[voice]);
 useEffect(()=>{if(!stageMode)return;const controller=new AbortController();void fetch('/demo-api/stage',{signal:controller.signal}).then(async response=>{const value=await response.json();if(!response.ok)throw new Error(value.error||'This lecture is unavailable. Please reconnect and try again.');setPrepared(value);}).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'This lecture is unavailable. Please reconnect and try again.');});return()=>controller.abort();},[]);
 const watch=(id:string)=>{stream.current?.close();const source=new EventSource('/demo-api/runs/'+id+'/events');stream.current=source;source.onmessage=event=>{const next=JSON.parse(event.data)as Run;setRun(next);setRequest(next.request);if(next.status!=='running'){setBusy(false);source.close();}};source.onerror=()=>{source.close();setBusy(false);setError('The local connection closed. Your request and any completed audio remain saved.');};};
 useEffect(()=>{if(stageMode)return;const id=new URLSearchParams(location.search).get('run');if(id&&/^[a-f0-9-]{36}$/.test(id)){setOpen(true);setBusy(true);setSource('saved');watch(id);}},[]);
 const refreshLibrary=async()=>{try{const response=await fetch('/demo-api/runs');if(!response.ok)return[];const list=((await response.json()).runs||[])as Lecture[];setLibrary(list);return list;}catch{return[];}};
 useEffect(()=>{if(open)void refreshLibrary();},[open,run?.status]);
 useEffect(()=>{if(!heard&&!note)return;const timer=setTimeout(()=>{setHeard('');setNote('');},5000);return()=>clearTimeout(timer);},[heard,note]);

 async function begin(text:string,refresh=true){const value=text.trim();if(!value||live.current.busy)return;audio.current?.pause();stream.current?.close();setBusy(true);setPlaying(false);setError('');setRun(undefined);setShowScript(false);setTime(0);setActivityOpen(true);setSource('stage');setLibraryOpen(false);
  announced.current={phase:0,status:'running',at:Date.now()};
  if(voiceMode.current)voice.say(speak.confirm(value));
  if(stageMode){
   if(!prepared){setBusy(false);setError('This lecture is unavailable. Please reconnect and try again.');return;}
   clearInterval(replayTimer.current);if(audio.current)audio.current.currentTime=0;
   const replay={...prepared.run,request:value},timeline=stageTimeline(replay),started=performance.now();setRun(stageFrame(replay,timeline,0));
   replayTimer.current=setInterval(()=>{const elapsed=performance.now()-started;setRun(stageFrame(replay,timeline,elapsed));if(elapsed>=prepared.durationMs){clearInterval(replayTimer.current);setBusy(false);}},50);
   return;
  }
  try{const response=await fetch('/demo-api/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request:value,refresh})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not start your request.');watch(data.id);}catch(e){setBusy(false);const message=e instanceof Error?e.message:'Could not start.';setError(message);if(voiceMode.current)voice.say(speak.error(message));}}
 function start(e:React.FormEvent){e.preventDefault();voiceMode.current=false;voice.silence();void begin(request);}
 async function cancel(){if(!run)return;if(stageMode){clearInterval(replayTimer.current);setRun({...run,status:'cancelled'});setBusy(false);return;}await fetch('/demo-api/runs/'+run.id+'/cancel',{method:'POST'});}
 function backToRequest(){clearInterval(replayTimer.current);stream.current?.close();audio.current?.pause();setBusy(false);setRun(undefined);setRequest('');setError('');setSource('stage');setOpen(true);requestAnimationFrame(()=>{if(listenRef.current==='idle')input.current?.focus();});}
 function openSaved(item:Lecture,announce:boolean){
  clearInterval(replayTimer.current);audio.current?.pause();setLibraryOpen(false);setOpen(true);setError('');setShowScript(false);setTime(0);setPlaying(false);setActivityOpen(false);setSource('saved');
  announced.current={phase:99,status:item.status,at:Date.now()};
  if(announce)voice.say(speak.opening(item));
  setBusy(true);watch(item.id);
 }

 // Spoken progress for someone who is only listening: each step, a reminder during long steps, the result.
 useEffect(()=>{
  if(!run||!voiceMode.current)return;
  const phases=tracePhases(run),current=phases.findIndex(phase=>phase.status==='running');
  if(run.status==='running'&&current>announced.current.phase){announced.current.phase=current;announced.current.at=Date.now();const cue=stepCues[phases[current].id];voice.cue(cue,cueText[cue]);}
  if(run.status!==announced.current.status){announced.current.status=run.status;
   if(run.status==='ready')voice.say(speak.ready(run));
   if(run.status==='error')voice.say(speak.error(run.error||'Something went wrong.'));
  }
 },[run,voice]);
 useEffect(()=>{if(!busy||stageMode)return;const timer=setInterval(()=>{const current=live.current.run;if(!voiceMode.current||current?.status!=='running'||voice.speaking||listenRef.current!=='idle'||Date.now()-announced.current.at<30000)return;announced.current.at=Date.now();const phase=tracePhases(current).find(item=>item.status==='running')?.id||'find';const cue=stillCues[phase];voice.cue(cue,cueText[cue]);},5000);return()=>clearInterval(timer);},[busy,voice]);

 const cue=(name:CueName)=>voice.cue(name,cueText[name]);
 const resume=()=>{if(resumeAfter.current&&audio.current){resumeAfter.current=false;const player=audio.current;const wait=()=>{if(voice.speaking)setTimeout(wait,150);else void player.play().catch(()=>{});};setTimeout(wait,200);}};
 async function readLibrary(){const lectures=(await refreshLibrary()).filter(item=>item.status==='ready');if(!lectures.length)cue('noLectures');else voice.say(speak.library(lectures));}
 async function openNumber(index:number){const lectures=(await refreshLibrary()).filter(item=>item.status==='ready');const item=lectures[index];if(!item){cue('noLectures');return;}openSaved(item,true);}
 /** Carry out what the listener said, given where they are: asking, waiting, or listening to a lesson. */
 function act(text:string){
  const state=live.current,command=parseCommand(text),player=audio.current;
  if(command.kind==='help'){cue('help');resume();return;}
  if(command.kind==='library'){resumeAfter.current=false;void readLibrary();return;}
  if(command.kind==='open'){resumeAfter.current=false;void openNumber(command.index);return;}
  if(state.busy){
   if(['cancel','pause','new'].includes(command.kind)){void cancel();cue('stopped');return;}
   const phase=state.run?tracePhases(state.run).find(item=>item.status==='running')?.id||'find':'find';const step=stepCues[phase];voice.cue(step,cueText[step]);return;
  }
  if(!state.run||!state.ready||!player){
   if(command.kind==='new'){backToRequest();return;}
   if(command.kind==='request'||text.trim().split(/\s+/).length>=2){setRequest(text);void begin(text);return;}
   cue('unknown');return;
  }
  const seek=(to:number)=>{player.currentTime=Math.max(0,Math.min(to,player.duration||to));};
  switch(command.kind){
   case 'request':resumeAfter.current=false;backToRequest();setRequest(text);void begin(text);return;
   case 'new':resumeAfter.current=false;backToRequest();return;
   case 'play':resumeAfter.current=false;void player.play().catch(()=>{});return;
   case 'pause':case 'cancel':resumeAfter.current=false;player.pause();return;
   case 'restart':resumeAfter.current=false;seek(0);void player.play().catch(()=>{});return;
   case 'back':seek(player.currentTime-command.seconds);resumeAfter.current=true;resume();return;
   case 'forward':seek(player.currentTime+command.seconds);resumeAfter.current=true;resume();return;
   case 'slower':case 'faster':case 'normal':{const value=command.kind==='normal'?1:nextSpeed(state.rate,command.kind==='faster'?1:-1);setRate(value);player.playbackRate=value;voice.say(speak.speed(value));resume();return;}
   case 'where':voice.say(speak.where(player.currentTime,player.duration||state.duration));resume();return;
   case 'transcript':setShowScript(true);resume();return;
   case 'save':download.current?.click();resume();return;
   default:cue('unknown');resume();
  }
 }
 /** Tap the bubble (stops on a pause in speech) or hold Space (stops on release). */
 async function startListening(hold:boolean){
  if(listenRef.current!=='idle')return;
  setOpen(true);setHeard('');setNote('');released.current=false;
  await voice.loaded;
  const viaBrowser=!voice.stt&&browserRecognition;
  if(!viaBrowser&&(!voice.stt||!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined')){setNote(voice.stt?'Voice input is not available in this browser. Type your request instead.':'Voice input needs speech-to-text permission on your ElevenLabs key. Type your request instead.');requestAnimationFrame(()=>input.current?.focus());return;}
  voice.silence();resumeAfter.current=!!audio.current&&!audio.current.paused;audio.current?.pause();
  setPushToTalk(hold);setListen('listening');voice.tone('listen');
  try{
   if(viaBrowser){
    const session=recognise({hold,onWords:words=>setHeard(words)});recording.current=session;if(hold&&released.current)session.stop();
    const text=await session.done;recording.current=undefined;setListen('idle');
    if(text===undefined){setHeard('');resume();return;}
    voice.tone('done');voiceMode.current=true;
    if(!text){setNote('I didn’t hear anything. Tap the bubble or hold Space and try again.');cue('silence');resume();return;}
    setHeard(text);act(text);return;
   }
   const active=await record({autoStop:!hold,onLevel:level=>orb.current?.style.setProperty('--level',level.toFixed(3))});
   recording.current=active;if(hold&&released.current)active.stop();
   const result=await active.done;recording.current=undefined;
   if(!result){setListen('idle');resume();return;}
   voice.tone('done');voiceMode.current=true;
   if(!result.heard){setListen('idle');setNote('I didn’t hear anything. Tap the bubble or hold Space and try again.');cue('silence');resume();return;}
   setListen('transcribing');
   const text=await transcribe(result.blob);setListen('idle');
   if(!text){setNote('I didn’t hear anything. Tap the bubble or hold Space and try again.');cue('silence');resume();return;}
   setHeard(text);act(text);
  }catch(e){
   recording.current=undefined;setListen('idle');voice.tone('error');
   if(e instanceof VoiceInputError&&e.code==='stt_permission'){voice.disableStt();setNote(browserRecognition?'Switched to your browser’s speech recognition, because this ElevenLabs key can’t transcribe. Tap the bubble and say it again.':e.message);cue('voiceError');resume();return;}
   const blocked=e instanceof DOMException&&['NotAllowedError','SecurityError','NotFoundError'].includes(e.name);
   setNote(blocked?'Microphone access is unavailable. Allow it in your browser, or type your request.':e instanceof Error?e.message:'Voice input failed. Type your request instead.');
   if(!blocked&&voiceMode.current)cue('voiceError');resume();
  }
 }
 const toggleListening=()=>{if(listenRef.current==='listening'){recording.current?.stop();return;}if(listenRef.current==='idle')void startListening(false);};

 const handlers=useRef({startListening,toggleListening});handlers.current={startListening,toggleListening};
 useEffect(()=>{
  const down=(e:KeyboardEvent)=>{
   if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();setOpen(true);requestAnimationFrame(()=>input.current?.focus());return;}
   if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='b'){e.preventDefault();setOpen(true);setLibraryOpen(value=>!value);return;}
   if(e.key===' '&&!e.repeat&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&!typing(e.target)){e.preventDefault();void handlers.current.startListening(true);return;}
   if(e.key==='Escape'){
    if(listenRef.current==='listening'){recording.current?.cancel();return;}
    if(live.current.libraryOpen){setLibraryOpen(false);return;}
    voice.silence();audio.current?.pause();if(!live.current.busy&&!live.current.run)setOpen(false);
   }
  };
  const up=(e:KeyboardEvent)=>{if(e.key===' '){released.current=true;if(listenRef.current==='listening')recording.current?.stop();}};
  document.addEventListener('keydown',down);document.addEventListener('keyup',up);
  return()=>{document.removeEventListener('keydown',down);document.removeEventListener('keyup',up);};
 },[voice]);
 useEffect(()=>{if(run?.status==='ready')setActivityOpen(false);},[run?.id,run?.status]);

 const active=busy||playing||listen==='transcribing';const currentStage=run?{title:preparationTitle(run)}:undefined;
 const audioSrc=stageMode&&source==='stage'?prepared?.audioUrl:run?'/demo-api/runs/'+run.id+'/audio':undefined;
 const voiceStatus=listen==='listening'&&heard?`“${heard}…”`:listen==='listening'?(pushToTalk?'Listening… release Space to send':'Listening… just pause when you’re done'):listen==='transcribing'?'Understanding…':heard?`“${heard}”`:note;
 const readyCount=library.filter(item=>item.status==='ready').length;
 return <main className={`canvas ${open?'is-open':''} ${run?'has-run':''} ${ready?'is-ready':''} ${stageMode?'is-stage':''}`}>
  <div className="frame" aria-hidden="true"/>
  <button ref={orb} className={`orb ${active?'is-active':''} ${listen==='listening'?'is-listening':''}`} aria-pressed={listen==='listening'} aria-label={listen==='listening'?'Stop listening':run?'Speak a command':'Speak your request'} aria-keyshortcuts="Space" onClick={toggleListening}>
   <OrbArt/>
  </button>
  {(stageMode&&prepared||ready)&&audioSrc&&<audio ref={audio} src={audioSrc} preload={stageMode?'auto':'metadata'} onPlay={()=>{setPlaying(true);setActivityOpen(false);}} onPause={()=>setPlaying(false)} onTimeUpdate={e=>setTime(e.currentTarget.currentTime)} onLoadedMetadata={e=>{setDuration(e.currentTarget.duration);e.currentTarget.playbackRate=live.current.rate;}} onEnded={()=>{setPlaying(false);if(voiceMode.current)cue('end');}}/>}
  <div className="content-viewport">
  {open&&<div className="experience">
   {!run&&<div className="welcome"><h1>What would you like to learn?</h1></div>}
   {run?<div className="submitted"><p><ProductText>{run.request}</ProductText></p></div>:<form className="request" onSubmit={start}>
    <label className="sr-only" htmlFor="request">Your lecture request</label><textarea id="request" ref={input} value={request} onChange={e=>setRequest(e.target.value)} placeholder={stageMode?'':'Teach me the content from my latest microeconomics lecture'} rows={run?1:2} disabled={busy} maxLength={1200} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();start(e);}}}/>
    <button type="submit" disabled={busy||!request.trim()||stageMode&&!prepared} aria-label="Start learning"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7"/></svg></button>
   </form>}
   {!run&&<div className="request-foot"><span><ProductText>From your Moodle course to a lecture you can listen to.</ProductText></span><span className="voice-hint">Tap the bubble or hold <kbd>Space</kbd> to speak</span></div>}
   {error&&<p className="error" role="alert"><ProductText>{error}</ProductText></p>}
   {run&&<section className="work" aria-label="Agent activity">
    <header className="work-heading"><span className="status-dot"/><p><ProductText>{run.status==='ready'?'Ready when you are.':run.status==='error'?'Something needs your attention.':run.status==='cancelled'?'Request stopped.':currentStage?.title||'Working on your request'}</ProductText></p>{busy&&<button className="quiet" onClick={()=>void cancel()}>Stop</button>}</header>
    <Trace run={run} open={busy||activityOpen} onToggle={value=>{if(!busy)setActivityOpen(value);}}/>
    {run.error&&<div className="error" role="alert"><ProductText>{run.error}</ProductText><p>Your retrieved materials remain saved.</p></div>}
    {ready&&<article className="lesson"><div className="lesson-meta"><span>EARSHOT · YOUR LECTURE, RE-EXPLAINED</span><span>Narrated lesson</span></div><h1>{run.title}</h1><p className="course">{[run.course?.replace(/\s*\([^)]*Moodle[^)]*\)/i,''),run.date?.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?[,\s]+\d{1,2}\s+\w+\s+\d{4}\b/)?.[0]||run.date?.slice(0,60)].filter(Boolean).join(' · ')}</p>{run.scope&&<p className="scope" title={run.scope}>{run.scope.split('. ')[0]}</p>}
     <div className="player"><button className="play" aria-label={playing?'Pause lecture':'Play lecture'} onClick={()=>{if(audio.current){if(playing)audio.current.pause();else void audio.current.play().catch(()=>setError('Press Play again to allow audio.'));}}}>{playing?<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>:<img src="/prism/play.svg" alt="" aria-hidden="true"/>}</button><div className="seek"><input aria-label="Lecture playback position" type="range" min="0" max={duration||1} step="0.1" value={time} onChange={e=>{if(audio.current)audio.current.currentTime=Number(e.target.value);}}/><div><span>{minutes(time)}</span><span>{minutes(duration)}</span></div></div><select aria-label="Playback speed" value={rate} onChange={e=>{const value=Number(e.target.value);setRate(value);if(audio.current)audio.current.playbackRate=value;}}>{speeds.map(v=><option key={v} value={v}>{v}×</option>)}</select></div>
     {run.words?.length?<Narration words={run.words} audio={audio} playing={playing}/>:<p className="caption-notice">{run.captionNotice||'Synchronized text is unavailable for this recording. Read the full transcript below.'}</p>}
     <p className="voice-commands">Tap the bubble and say <q>pause</q>, <q>go back</q>, <q>slower</q> or <q>where am I</q>.</p>
     <div className="lesson-links"><button className="quiet" onClick={()=>setShowScript(!showScript)}>{showScript?'Hide transcript':'Read transcript'} <span>↗</span></button><a ref={download} href={audioSrc} download="lecture.wav">Save audio <span>↓</span></a></div>
     {showScript&&<div className="script">{run.script?.split('\n\n').map((p,i)=><p key={i}>{p}</p>)}</div>}
     {!!run.sources?.length&&<details className="sources"><summary>From your course materials <span>{run.sources.length}</span></summary>{run.sources.map((s,i)=><a key={i} href={s.url} target="_blank" rel="noreferrer"><span>{s.kind}</span><ProductText>{s.label}</ProductText><b>↗</b></a>)}</details>}
    </article>}
   </section>}
   {ready&&!(stageMode&&source==='saved')&&<button className="refresh quiet" onClick={()=>void begin(request,true)}><ProductText>Prepare again</ProductText> <span>↻</span></button>}
   {run&&!busy&&<button className="again quiet" aria-label="Back to request" onClick={backToRequest}>Back to request <span aria-hidden="true">↵</span></button>}
  </div>}
  </div>
  {open&&<button className={`library-toggle ${libraryOpen?'is-open':''}`} aria-label="Past lectures" aria-expanded={libraryOpen} aria-controls="library" aria-keyshortcuts="Meta+B Control+B" onClick={()=>setLibraryOpen(!libraryOpen)}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M9.5 4.5v15M5.8 8.5h1.6M5.8 11.5h1.6"/></svg>{readyCount>0&&<span>{readyCount}</span>}</button>}
  {libraryOpen&&<><div className="library-scrim" onClick={()=>setLibraryOpen(false)}/><aside id="library" className="library" aria-label="Past lectures">
   <header><h2>Past lectures</h2><button className="library-close" aria-label="Close past lectures" onClick={()=>setLibraryOpen(false)}>esc</button></header>
   <button className="library-new" onClick={()=>{setLibraryOpen(false);backToRequest();}}>New lecture <span aria-hidden="true">+</span></button>
   {library.length?<ol>{library.map(item=><li key={item.id}><button aria-current={run?.id===item.id&&source==='saved'?'true':undefined} onClick={()=>openSaved(item,voiceMode.current)}>
    <span className="library-title">{item.title||'Preparing your lecture…'}</span>
    <span className="library-meta">{[spokenCourse(item.course),shortWhen(item.at),item.status==='running'?'In progress':item.duration?minutes(item.duration):''].filter(Boolean).join(' · ')}</span>
    <span className="library-request">“{item.request}”</span>
   </button></li>)}</ol>:<p className="library-empty">Lectures you prepare will appear here. Ask for one to get started.</p>}
  </aside></>}
  {voiceStatus&&<div className={`voice-status is-${listen}`}><span className="voice-level" aria-hidden="true"/><span>{voiceStatus}</span></div>}
  {open&&!run&&<button className="close" aria-label="Close request" onClick={()=>setOpen(false)}>esc</button>}
  <span className="sr-only" role="status" aria-live="polite">{voiceStatus||(busy?currentStage?.title:ready?'Your lecture is ready to play.':'')}</span>
 </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
