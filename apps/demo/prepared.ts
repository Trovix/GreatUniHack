import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {STAGE_DURATION_MS,type PreparedStage} from './stage';
import type {Run} from './types';
import {validateWords} from './captions';

export const digest=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export function assertPreparedRun(run:Run){
 if(run.status!=='ready'||!run.audio||!run.script||run.script.length<300||!run.title||!run.events.length||!Number.isFinite(run.duration)||(run.duration??0)<=0)throw new Error('Choose a completed lesson with a transcript and playable audio.');
 if(run.events.some(event=>event.status==='running'||!Number.isFinite(Date.parse(event.at))||(event.finishedAt&&!Number.isFinite(Date.parse(event.finishedAt)))))throw new Error('The recorded activity must have complete results and valid timestamps.');
 if(!run.events.some(event=>event.stage==='rewrite')||!run.events.some(event=>event.stage==='speech'))throw new Error('The prepared lesson must include adaptation and narration stages.');
 if(!run.words?.length)throw new Error('Prepare synchronized word timings before pinning this lesson.');
 validateWords(run.words,run.duration!);
}
export async function loadPreparedStage(directory:string):Promise<{stage:PreparedStage;audio:Buffer}>{
 const [manifestText,runText,audio]=await Promise.all([readFile(join(directory,'manifest.json'),'utf8'),readFile(join(directory,'run.json'),'utf8'),readFile(join(directory,'lesson.wav'))]);
 const manifest=JSON.parse(manifestText);
 if(manifest.version!==1||manifest.runHash!==digest(runText)||manifest.audioHash!==digest(audio))throw new Error('The prepared assets are missing or have changed. Prepare the stage demo again.');
 const run=JSON.parse(runText)as Run;assertPreparedRun(run);
 return {stage:{preparedAt:String(manifest.preparedAt),durationMs:STAGE_DURATION_MS,run,audioUrl:'/demo-api/stage/audio?v='+manifest.audioHash+'&range=1'},audio};
}
