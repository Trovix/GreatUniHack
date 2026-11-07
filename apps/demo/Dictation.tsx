import {useEffect,useRef,useState} from 'react';
type Props={disabled:boolean;onText:(text:string)=>void;onBusy:(busy:boolean)=>void};
export function Dictation({disabled,onText,onBusy}:Props){
 const[status,setStatus]=useState<'idle'|'starting'|'recording'|'transcribing'>('idle'),[seconds,setSeconds]=useState(0),[error,setError]=useState('');
 const recorder=useRef<MediaRecorder|null>(null),stream=useRef<MediaStream|null>(null),timer=useRef<ReturnType<typeof setInterval>|undefined>(undefined),request=useRef<AbortController|null>(null),mounted=useRef(true),callbacks=useRef({onText,onBusy});callbacks.current={onText,onBusy};
 const release=()=>{clearInterval(timer.current);stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;};
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;callbacks.current.onBusy(false);request.current?.abort();if(recorder.current?.state==='recording')recorder.current.stop();release();};},[]);
 async function begin(){
  setError('');
  if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined'){setError('Microphone recording is unavailable in this browser. You can type your request.');return;}
  setStatus('starting');callbacks.current.onBusy(true);
  try{
   const media=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
   if(!mounted.current){media.getTracks().forEach(track=>track.stop());return;}
   stream.current=media;const type=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(value=>MediaRecorder.isTypeSupported(value));
   const recording=new MediaRecorder(media,type?{mimeType:type,audioBitsPerSecond:64000}:undefined),chunks:BlobPart[]=[];recorder.current=recording;
   recording.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
   recording.onstop=async()=>{
    release();if(!mounted.current)return;setStatus('transcribing');const controller=new AbortController();request.current=controller;const timeout=setTimeout(()=>controller.abort(),60000);
    try{
     const body=new Blob(chunks,{type:recording.mimeType||'audio/webm'});if(!body.size)throw new Error('No speech was recorded. Please try again.');
     const response=await fetch('/demo-api/dictate',{method:'POST',headers:{'Content-Type':body.type},body,signal:controller.signal}),data=await response.json();
     if(!response.ok)throw new Error(data.error||'Could not transcribe your request.');
     if(mounted.current)callbacks.current.onText(data.text);
    }catch(e){if(mounted.current)setError(e instanceof Error&&e.name!=='AbortError'?e.message:'Transcription timed out. Please try again.');}
    finally{clearTimeout(timeout);if(mounted.current){setStatus('idle');callbacks.current.onBusy(false);}}
   };
   recording.onerror=()=>{release();if(recording.state==='recording')recording.stop();if(mounted.current)setError('The microphone recording stopped unexpectedly. Please try again.');};
   recording.start();setSeconds(0);setStatus('recording');const started=Date.now();timer.current=setInterval(()=>{const elapsed=Math.floor((Date.now()-started)/1000);setSeconds(elapsed);if(elapsed>=60&&recording.state==='recording')recording.stop();},250);
  }catch(e){release();if(!mounted.current)return;setStatus('idle');callbacks.current.onBusy(false);setError(e instanceof DOMException&&e.name==='NotAllowedError'?'Microphone access was denied. Allow it in your browser, or type your request.':'Could not start the microphone. Please try again.');}
 }
 return <><button className={`dictate ${status==='recording'?'is-recording':''}`} type="button" disabled={disabled||status==='starting'||status==='transcribing'} aria-label={status==='recording'?'Stop dictation':'Dictate lecture request'} aria-pressed={status==='recording'} title={status==='recording'?'Stop and transcribe':'Dictate your request'} onClick={()=>status==='recording'?recorder.current?.stop():void begin()}>{status==='transcribing'||status==='starting'?<span className="dictate-spinner"/>:status==='recording'?<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/></svg>:<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 10v2a6 6 0 0 0 12 0v-2M12 18v3M9 21h6"/></svg>}</button><span className="dictation-status" role="status" aria-live="polite">{status==='recording'?<>Listening · <span aria-hidden="true">{seconds}s · </span>tap stop when you’re done</>:status==='transcribing'?'Transcribing your request…':status==='starting'?'Opening microphone…':error?'':null}</span>{error&&<span className="dictation-error" role="alert">{error}</span>}</>;
}
