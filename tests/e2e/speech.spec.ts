import { test, expect, chromium } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from '../../apps/api/server';
import { createProviders } from '../../apps/api/providers';

// Playback of already-generated artifacts makes no provider requests.
test('saved live ElevenLabs references are fetched through the paired API and played in Chromium',async()=>{
  const root=resolve('verification/live-speech');
  try{await readFile(join(root,'F1-reference.wav'));}catch{test.skip(true,'No saved live speech artifacts; no provider calls are made by tests.');return;}
  await mkdir(resolve('.tmp'),{recursive:true});const temp=await mkdtemp(resolve('.tmp/speech-playback-'));
  const extension=resolve('dist/extension');
  const context=await chromium.launchPersistentContext(join(temp,'profile'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const origin='chrome-extension://'+new URL(worker.url()).host;
  const app=await createServer({dataDir:join(temp,'data'),allowedOrigins:[origin],providers:createProviders({mode:'mock',openaiApiKey:'',elevenLabsApiKey:''})});
  await new Promise<void>(done=>app.server.listen(4317,'127.0.0.1',done));
  try{
    const page=await context.newPage();await page.goto(origin+'/workspace.html');
    const lecture=await app.store.create('Developer reference speech playback');
    for(const id of ['F1-reference','F2-change-reference','QA-reference']){
      const bytes=await readFile(join(root,id+'.wav')),report=JSON.parse(await readFile(join(root,id+'.json'),'utf8'));
      const hash=await app.store.putBlob(bytes);
      await app.store.update(lecture.id,value=>{value.chunks=[{id,segmentId:id,inputRevision:0,durationMs:report.durationMs,mime:'audio/wav',mode:'live',provider:'elevenlabs',scriptHash:hash,blobHash:hash}];});
      const observed=await page.evaluate(async({url,token})=>{
        const response=await fetch(url,{headers:{Authorization:'Bearer '+token}});if(!response.ok)throw new Error('Paired audio fetch failed: '+response.status);
        const blob=await response.blob(),audio=new Audio(URL.createObjectURL(blob));
        document.body.append(audio);audio.controls=true;
        await audio.play();await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Audio time did not advance')),5000);audio.ontimeupdate=()=>{if(audio.currentTime>.2){clearTimeout(timer);audio.pause();resolve();}};});
        const result={fetchedBytes:blob.size,duration:audio.duration,advancedTo:audio.currentTime,paused:audio.paused};URL.revokeObjectURL(audio.src);audio.remove();return result;
      },{url:`http://127.0.0.1:4317/lectures/${lecture.id}/audio/${id}`,token:app.token});
      expect(observed.advancedTo).toBeGreaterThan(.2);expect(observed.paused).toBe(true);expect(observed.duration).toBeCloseTo(report.durationMs/1000,1);
      report.browserPlayback={status:'fetched_decoded_and_time_advanced',...observed,at:new Date().toISOString(),humanListening:'not_performed'};
      await writeFile(join(root,id+'.json'),JSON.stringify(report,null,2)+'\n');
    }
  }finally{await context.close();await app.close();await rm(temp,{recursive:true,force:true});}
});
