import { mkdir, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite } from '../apps/api/store';
import { createProviders, ProviderError } from '../apps/api/providers';
import { inspectAssetBytes } from '../packages/core/node-assets';
import { loadFixture } from './fixtures';

if(!process.argv.includes('--run')) { console.log('No provider calls. Explicit ElevenLabs verification requires --run.'); process.exit(0); }
const root=resolve('verification/live-speech');await mkdir(root,{recursive:true});
const lock=join(root,'.speech-lock');
await mkdir(lock,{mode:0o700});
try {
const ledgerPath=join(root,'budget.json');
type Entry={caseId:string;operation:string;attempt:number;estimatedSeconds:number;state:string;at:string;status?:number;durationMs?:number};
let entries:Entry[]=[];
try{entries=JSON.parse(await readFile(ledgerPath,'utf8')).entries;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
const save=(path:string,value:unknown)=>atomicWrite(path,JSON.stringify(value,null,2)+'\n');
const persist=()=>save(ledgerPath,{maximumEstimatedTtsSeconds:240,maximumSttFiles:1,entries});
const keyFile=process.env.LECTURE_ACCESS_ELEVENLABS_KEY_FILE;
if(!keyFile)throw new Error('Set LECTURE_ACCESS_ELEVENLABS_KEY_FILE to a private key file');
const metadata=await lstat(keyFile);
if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.uid!==process.getuid?.()||(metadata.mode&0o077)||metadata.size<1||metadata.size>4096)throw new Error('ElevenLabs private file is unavailable or not private');
const secret=(await readFile(keyFile,'utf8')).trim();
const preflight=JSON.parse(await readFile(resolve('verification/provider-preflight.json'),'utf8'));
const voice=preflight.elevenlabs?.stockVoice;
if(voice?.category!=='premade'||!voice.id)throw new Error('No verified stock voice configured');
const quota=await fetch('https://api.elevenlabs.io/v1/user/subscription',{headers:{'xi-api-key':secret},redirect:'error',signal:AbortSignal.timeout(20000)});
if(!quota.ok)throw new Error('ElevenLabs read-only quota preflight rejected: '+quota.status);
const subscription=await quota.json() as any;
if(subscription.status!=='active'||subscription.character_limit-subscription.character_count<5000)throw new Error('Insufficient verified speech quota');
let currentCase='',estimate=0;
const providers=createProviders({mode:'live',openaiApiKey:'',elevenLabsApiKey:secret,voiceId:voice.id,voiceIsStock:true,
  onRequest:async event=>{
    if(event.provider!=='elevenlabs')throw new ProviderError('INVALID_INPUT');
    if(event.phase==='before') {
      if(event.operation==='tts'&&entries.filter(e=>e.operation==='tts').reduce((n,e)=>n+e.estimatedSeconds,0)+estimate>240)throw new ProviderError('BUDGET_EXHAUSTED');
      if(event.operation==='stt'&&entries.some(e=>e.operation==='stt'))throw new ProviderError('BUDGET_EXHAUSTED');
      entries.push({caseId:currentCase,operation:event.operation,attempt:event.attempt,estimatedSeconds:estimate,state:'reserved',at:event.at});await persist();
    }else {
      const entry=entries.slice().reverse().find(e=>e.caseId===currentCase&&e.operation===event.operation&&e.attempt===event.attempt)!;
      entry.state=event.outcome??'unknown';entry.status=event.status;entry.durationMs=event.durationMs;await persist();
    }
  }});
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
for(const id of ['F1-reference','F2-change-reference','QA-reference']) {
  if(entries.some(e=>e.caseId===id)){console.log(id+': previous submission retained, no repeat.');continue;}
  currentCase=id; const text=(await readFile(join(root,id+'.txt'),'utf8')).trim();estimate=Math.ceil(text.split(/\s+/).length/100*60);
  try {
    const started=performance.now();const speech=await providers.synthesise(text,{revision:1,segmentId:id});
    const inspection=await inspectAssetBytes(speech.bytes,'audio/wav');
    await writeFile(join(root,id+'.wav'),speech.bytes,{mode:0o600});
    await save(join(root,id+'.json'),{status:'generated_and_decoded',provider:'elevenlabs',mode:'live',textSource:'developer-authored synthetic reference; not model compilation',voiceId:voice.id,model:speech.model,estimatedSeconds:estimate,durationMs:inspection.durationMs,sha256:hash(speech.bytes),alignment:speech.alignment,processingMs:Math.round(performance.now()-started),browserPlayback:'pending',humanAudioListening:'not_performed',liveMultimodalGate:'blocked'});
    console.log(id+': ElevenLabs audio generated, decoded and saved.');
  }catch(e){await save(join(root,id+'.json'),{status:'blocked',error:e instanceof ProviderError?e.toJSON():{code:'LOCAL_VERIFICATION_ERROR'},humanAudioListening:'not_performed'});console.log(id+': blocked; see redacted report.');}
}
currentCase='source-F1-stt';estimate=60;
if(!entries.some(e=>e.operation==='stt')) {
  try {
    const b=await loadFixture('F1'),audio=b.assets.find(a=>a.id===b.audioAssetId)!;
    if(!audio.durationMs||audio.durationMs>60000)throw new Error('STT file exceeds authorized bound');
    const started=performance.now(),result=await providers.transcribe(audio);
    await writeFile(join(root,'source-F1-stt.vtt'),result.vtt,{mode:0o600});
    await save(join(root,'source-F1-stt.json'),{status:'transcribed',provider:result.provider,mode:result.mode,sourceSha256:hash(Buffer.from(audio.base64,'base64')),sourceDurationMs:audio.durationMs,processingMs:Math.round(performance.now()-started),captionText:result.vtt,raw:result.raw,accuracyReview:'not_performed'});
    console.log('F1 source: live timestamped transcription saved.');
  }catch(e){await save(join(root,'source-F1-stt.json'),{status:'blocked',error:e instanceof ProviderError?e.toJSON():{code:'LOCAL_VERIFICATION_ERROR'}});console.log('STT blocked; see redacted report.');}
}
await persist();console.log('No OpenAI API calls. ElevenLabs submission ledger saved.');

} finally { await rm(lock,{recursive:true,force:true}); }
