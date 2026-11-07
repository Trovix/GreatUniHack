/** Browser side of voice input: microphone capture, end-of-speech detection and spoken prompts. */
import type {CueName} from './voice-commands';

export type Recording={stop():void;cancel():void;done:Promise<{blob:Blob;heard:boolean}|undefined>};

const SPEECH_LEVEL=.018,GRACE_MS=300,TRAILING_SILENCE_MS=1300,NO_SPEECH_MS=7000,MAX_MS=20000;

/**
 * Record one utterance. With `autoStop`, recording ends after a pause in speech (tap to talk);
 * without it, the caller ends it (hold to talk). `onLevel` receives 0–1 for the bubble animation.
 */
export async function record({onLevel,autoStop}:{onLevel:(level:number)=>void;autoStop:boolean}):Promise<Recording>{
 const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
 const type=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus'].find(value=>MediaRecorder.isTypeSupported(value));
 const recorder=new MediaRecorder(stream,type?{mimeType:type}:undefined);
 const chunks:Blob[]=[];recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
 const context=new AudioContext(),analyser=context.createAnalyser();analyser.fftSize=1024;
 context.createMediaStreamSource(stream).connect(analyser);
 const samples=new Float32Array(analyser.fftSize),began=performance.now();
 let frame=0,heard=false,cancelled=false,quietSince=0;
 const finish=()=>{if(recorder.state!=='inactive')recorder.stop();};
 const done=new Promise<{blob:Blob;heard:boolean}|undefined>(resolve=>{
  recorder.onstop=()=>{
   cancelAnimationFrame(frame);stream.getTracks().forEach(track=>track.stop());void context.close();onLevel(0);
   const elapsed=performance.now()-began;
   resolve(cancelled?undefined:{blob:new Blob(chunks,{type:(recorder.mimeType||type||'audio/webm').split(';')[0]}),heard:heard||!autoStop&&elapsed>600});
  };
 });
 const tick=()=>{
  analyser.getFloatTimeDomainData(samples);
  let sum=0;for(const sample of samples)sum+=sample*sample;
  const level=Math.sqrt(sum/samples.length),elapsed=performance.now()-began;
  onLevel(Math.min(1,level*9));
  // Ignore the first moment so the "listening" tone is not mistaken for speech.
  if(elapsed<GRACE_MS){frame=requestAnimationFrame(tick);return;}
  if(level>SPEECH_LEVEL){heard=true;quietSince=0;}else if(heard&&!quietSince)quietSince=elapsed;
  if(autoStop&&(heard&&quietSince&&elapsed-quietSince>TRAILING_SILENCE_MS||!heard&&elapsed>NO_SPEECH_MS)||elapsed>MAX_MS){finish();return;}
  frame=requestAnimationFrame(tick);
 };
 recorder.start(250);frame=requestAnimationFrame(tick);
 return{stop:finish,cancel:()=>{cancelled=true;finish();},done};
}

export class VoiceInputError extends Error{constructor(message:string,readonly code?:string){super(message);}}
/** Send a recording to the local server, which forwards it to ElevenLabs speech-to-text. */
export async function transcribe(blob:Blob):Promise<string>{
 const response=await fetch('/demo-api/voice/transcribe',{method:'POST',headers:{'Content-Type':blob.type||'audio/webm'},body:blob});
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw new VoiceInputError(data.error||'Voice input is unavailable right now. Type your request instead.',data.code);
 return String(data.text||'').trim();
}

type BrowserRecognition={lang:string;interimResults:boolean;continuous:boolean;maxAlternatives:number;start():void;stop():void;abort():void;
 onresult:((event:{resultIndex:number;results:ArrayLike<{isFinal:boolean;0:{transcript:string}}>})=>void)|null;onerror:((event:{error:string})=>void)|null;onend:(()=>void)|null};
const Recognition=(globalThis as unknown as {SpeechRecognition?:new()=>BrowserRecognition;webkitSpeechRecognition?:new()=>BrowserRecognition}).SpeechRecognition
 ??(globalThis as unknown as {webkitSpeechRecognition?:new()=>BrowserRecognition}).webkitSpeechRecognition;
export const browserRecognition=!!Recognition;
/**
 * Fallback when the ElevenLabs key cannot transcribe: the browser's own speech recognition.
 * Words appear as they are recognised. Resolves undefined when cancelled.
 */
export function recognise({hold,onWords}:{hold:boolean;onWords:(text:string)=>void}){
 const recognition=new Recognition!();
 recognition.lang=navigator.language||'en-GB';recognition.interimResults=true;recognition.continuous=hold;recognition.maxAlternatives=1;
 let final='',interim='',cancelled=false,failure='';
 const done=new Promise<string|undefined>((resolve,reject)=>{
  recognition.onresult=event=>{interim='';for(let i=event.resultIndex;i<event.results.length;i++){const result=event.results[i];if(result.isFinal)final+=result[0].transcript;else interim+=result[0].transcript;}onWords((final+interim).trim());};
  recognition.onerror=event=>{if(!['no-speech','aborted'].includes(event.error))failure=event.error;};
  recognition.onend=()=>{
   if(cancelled)resolve(undefined);
   else if(failure)reject(new VoiceInputError(failure==='not-allowed'||failure==='service-not-allowed'?'Microphone access is unavailable. Allow it in your browser, or type your request.':`Speech recognition failed (${failure}). Type your request instead.`));
   else resolve((final||interim).trim());
  };
 });
 recognition.start();
 return{stop:()=>recognition.stop(),cancel:()=>{cancelled=true;recognition.abort();},done};
}

/**
 * Spoken feedback in the ElevenLabs narration voice. Fixed prompts are pre-voiced and cached by the
 * server; other lines (a read-back, the ready summary) are voiced on request and cached too.
 * One line plays at a time. A newer line replaces any backlog, so feedback never falls behind events.
 */
export function createVoice(){
 let urls:Partial<Record<CueName,string>>={},enabled=false,stt=true,current:HTMLAudioElement|undefined,generation=0,tones:AudioContext|undefined;
 let queue:Promise<string|undefined>[]=[],draining=false;
 const loaded=fetch('/demo-api/voice').then(response=>response.ok?response.json():{}).then((value:{cues?:Partial<Record<CueName,string>>;enabled?:boolean;stt?:boolean})=>{urls=value.cues||{};enabled=!!value.enabled;stt=value.stt!==false;}).catch(()=>{});
 const clip=async(text:string)=>{
  const response=await fetch('/demo-api/voice/say',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
  if(!response.ok)return undefined;return String((await response.json()).url||'')||undefined;
 };
 const drain=async()=>{
  if(draining)return;draining=true;const mine=generation;
  try{
   while(queue.length&&mine===generation){
    const url=await queue.shift()!.catch(()=>undefined);if(!url||mine!==generation)continue;
    await new Promise<void>(resolve=>{const player=new Audio(url);current=player;player.onended=()=>resolve();player.onerror=()=>resolve();player.onpause=()=>resolve();void player.play().catch(()=>resolve());});
    current=undefined;
   }
  }finally{draining=false;if(queue.length&&mine!==generation)void drain();}
 };
 const enqueue=(url:Promise<string|undefined>)=>{if(queue.length>1)queue=queue.slice(-1);queue.push(url);void drain();};
 return{
  loaded,
  get enabled(){return enabled;},
  /** Whether ElevenLabs can transcribe with this key; otherwise the browser recognises speech. */
  get stt(){return stt;},
  disableStt(){stt=false;},
  get speaking(){return !!current||queue.length>0;},
  /** A fixed prompt, from the cache when available. */
  cue(name:CueName,fallback:string){enqueue(urls[name]?Promise.resolve(urls[name]):clip(fallback));},
  /** Any short line, voiced on demand. */
  say(text:string){enqueue(clip(text.slice(0,380)));},
  /** Stop talking immediately, for example when the listener starts speaking. */
  silence(){generation++;queue=[];current?.pause();current=undefined;},
  /** Short local tones that confirm the microphone opened, closed or failed. No network. */
  tone(kind:'listen'|'done'|'error'){
   try{
    tones??=new AudioContext();void tones.resume();
    const notes=kind==='listen'?[660,880]:kind==='done'?[880,660]:[330,262];
    notes.forEach((frequency,i)=>{
     const start=tones!.currentTime+i*.09,oscillator=tones!.createOscillator(),gain=tones!.createGain();
     oscillator.type='sine';oscillator.frequency.value=frequency;
     gain.gain.setValueAtTime(0,start);gain.gain.linearRampToValueAtTime(.12,start+.015);gain.gain.exponentialRampToValueAtTime(.0001,start+.16);
     oscillator.connect(gain).connect(tones!.destination);oscillator.start(start);oscillator.stop(start+.18);
    });
   }catch{}
  },
 };
}
export type Voice=ReturnType<typeof createVoice>;
