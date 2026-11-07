import {mkdir,readFile,readdir,writeFile,rename,rm,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {assertPreparedRun,digest,loadPreparedStage} from '../apps/demo/prepared';
import type {Run} from '../apps/demo/types';

const root=resolve('.data/demo'),destination=resolve('.data/demo-stage');
let id=process.argv[2];
if(!id){
 const ready:Run[]=[];
 for(const entry of await readdir(root)){if(!/^[a-f0-9-]{36}$/.test(entry))continue;try{const run=JSON.parse(await readFile(join(root,entry,'run.json'),'utf8'));if(run.status==='ready')ready.push(run);}catch{}}
 id=ready.sort((a,b)=>Date.parse(b.events[0]?.at||'')-Date.parse(a.events[0]?.at||''))[0]?.id;
}
if(!id||!/^[a-f0-9-]{36}$/.test(id))throw new Error('Pass the ID of a completed real lesson, or prepare one in the live demo first.');
const runText=await readFile(join(root,id,'run.json'),'utf8'),run=JSON.parse(runText)as Run;
assertPreparedRun(run);
const audio=await readFile(join(root,id,'lesson.wav'));
if(audio.length<44||audio.toString('ascii',0,4)!=='RIFF'||audio.toString('ascii',8,12)!=='WAVE')throw new Error('The saved narration is not a WAV file.');
await mkdir(resolve('.data'),{recursive:true,mode:0o700});
const temporary=await mkdtemp(resolve('.data/stage-prepare-'));
try{
 await writeFile(join(temporary,'run.json'),runText,{mode:0o600});
 await writeFile(join(temporary,'lesson.wav'),audio,{mode:0o600});
 await writeFile(join(temporary,'manifest.json'),JSON.stringify({version:1,preparedAt:new Date().toISOString(),runHash:digest(runText),audioHash:digest(audio)},null,2)+'\n',{mode:0o600});
 await loadPreparedStage(temporary);
 const backup=destination+'.previous';await rm(backup,{recursive:true,force:true});
 try{await rename(destination,backup);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 try{await rename(temporary,destination);}catch(error){try{await rename(backup,destination);}catch{}throw error;}
 await rm(backup,{recursive:true,force:true});
 console.log(`Stage demo pinned to completed run ${id}. Restart the demo server, then open http://127.0.0.1:4320/stage. No provider calls were made.`);
}finally{await rm(temporary,{recursive:true,force:true});}
