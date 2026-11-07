import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {STAGE_DURATION_MS,stageFrame,stageTimeline} from '../../apps/demo/stage';
import {assertPreparedRun,digest,loadPreparedStage} from '../../apps/demo/prepared';
import type {Run} from '../../apps/demo/types';

const at=(seconds:number)=>new Date(Date.UTC(2026,10,7,10,0,seconds)).toISOString();
const recorded:Run={id:'recorded-lesson',request:'Teach me my lecture',status:'ready',audio:true,duration:30,title:'Recorded lesson',script:'A recorded teaching paragraph. '.repeat(15),words:[{text:'A',start:0,end:.5},{text:'recorded',start:.5,end:1}],events:[
 {id:1,stage:'aside',title:'Finding your lecture on Moodle',at:at(0),status:'done'},
 {id:2,stage:'action',title:'Reading notes',at:at(1),finishedAt:at(2),status:'done',agent:'Lecture agent'},
 {id:3,stage:'action',title:'Reading slides',at:at(1),finishedAt:at(3),status:'error',agent:'Source agent 1'},
 {id:4,stage:'rewrite',title:'Adapting the explanation',at:at(10),finishedAt:at(20),status:'done'},
 {id:5,stage:'speech',title:'Creating narration',at:at(20),finishedAt:at(22),status:'done'}
]};
const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(directory=>rm(directory,{recursive:true,force:true})));});

describe('prepared stage demo',()=>{
 it('replays parallel actions and failures on a repeatable timeline under twenty seconds',()=>{
  const original=structuredClone(recorded),timeline=stageTimeline(recorded);
  expect(timeline).toEqual(stageTimeline(recorded));
  expect(timeline[1].start).toBe(timeline[2].start);
  expect(stageFrame(recorded,timeline,0).events).toHaveLength(1);
  const middle=stageFrame(recorded,timeline,9_001);
  expect(middle.status).toBe('running');
  expect(middle.events.find(event=>event.id===3)?.status).toBe('error');
  expect(middle.events.find(event=>event.id===4)?.status).toBe('running');
  expect(middle.events.some(event=>event.id===5)).toBe(false);
  expect(stageFrame(recorded,timeline,12_001).events.at(-1)?.status).toBe('running');
  expect(stageFrame(recorded,timeline,STAGE_DURATION_MS)).toEqual(recorded);
  expect(STAGE_DURATION_MS).toBeLessThan(20_000);
  expect(recorded).toEqual(original);
 });

 it('rejects unfinished lessons instead of silently falling back to a live run',()=>{
  expect(()=>assertPreparedRun({...recorded,status:'running'})).toThrow('completed lesson');
  expect(()=>assertPreparedRun({...recorded,audio:false})).toThrow('completed lesson');
  expect(()=>assertPreparedRun({...recorded,events:[{...recorded.events[0],status:'running'}]})).toThrow('complete results');
 });

 it('loads only the pinned local assets and rejects changed narration',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'lecture-stage-test-'));directories.push(directory);
  const runText=JSON.stringify(recorded),audio=Buffer.from('test recording bytes');
  await Promise.all([
   writeFile(join(directory,'run.json'),runText),writeFile(join(directory,'lesson.wav'),audio),
   writeFile(join(directory,'manifest.json'),JSON.stringify({version:1,preparedAt:at(0),runHash:digest(runText),audioHash:digest(audio)}))
  ]);
  const loaded=await loadPreparedStage(directory);
  expect(loaded.stage.run).toEqual(recorded);
  expect(loaded.stage.durationMs).toBe(14_000);
  expect(loaded.audio).toEqual(audio);
  await writeFile(join(directory,'lesson.wav'),'changed');
  await expect(loadPreparedStage(directory)).rejects.toThrow('have changed');
 });
});
