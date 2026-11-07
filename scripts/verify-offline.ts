import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { createProviders } from '../apps/api/providers';
import { validateCompilation } from '../packages/core';
import { loadFixture } from './fixtures';
const root=resolve('verification/offline');
await mkdir(root,{recursive:true});
const providers=createProviders({mode:'mock',openaiApiKey:'',elevenLabsApiKey:'',fetch:async()=>{throw new Error('Network forbidden in offline verification');}});
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const reports=[];
for(const fixtureId of ['F1','F2','F3','F4a','F4b']) {
  const started=performance.now(), bundle=await loadFixture(fixtureId);
  const result=await providers.compile(bundle,1);
  const errors=validateCompilation(result.compilation,bundle,1);
  const directory=join(root,fixtureId);await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'compilation.json'),JSON.stringify(result.compilation,null,2)+'\n');
  await writeFile(join(directory,'script.txt'),result.compilation.segments.map(s=>s.text).join('\n\n')+'\n');
  const report={fixtureId,inputRevision:1,mode:'mock',providerRequests:0,sourceDurationMs:bundle.assets.find(a=>a.id===bundle.audioAssetId)?.durationMs,sourceHashes:bundle.assets.map(a=>({id:a.id,mime:a.mime,sha256:hash(Buffer.from(a.base64,'base64'))})),deterministicErrors:errors,softwareGate:errors.length?'failed':'passed',liveSemanticGate:'blocked: no further paid provider calls authorized; OpenAI run ended with token_invalidated',criticalMeaningReview:'not performed on a live transformed output',reviewerRole:'automated offline software check',targetUserEvaluation:'not performed',processingMs:Math.round(performance.now()-started),audio:undefined as unknown};
  if(fixtureId==='F1'&&!errors.length) {
    const text='Offline mock demonstration. Visual meaning has not been analysed. '+result.compilation.segments.map(s=>s.text).join(' ');
    const speech=await providers.synthesise(text,{revision:1,segmentId:'offline-demo'});
    await writeFile(join(root,'F1','mock-narration.wav'),speech.bytes);
    report.audio={file:'mock-narration.wav',provider:speech.provider,mode:speech.mode,sha256:hash(speech.bytes),durationMs:speech.durationMs,meaningListening:'not performed',notElevenLabs:true};
  }
  await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');reports.push(report);
  console.log(fixtureId+': '+report.softwareGate+' deterministic mock checks; live semantics blocked.');
}
await writeFile(join(root,'summary.json'),JSON.stringify({at:new Date().toISOString(),networkCalls:0,reports},null,2)+'\n');
if(reports.some(r=>r.deterministicErrors.length))process.exitCode=1;
