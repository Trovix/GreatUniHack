import type {Run} from './types';

export const STAGE_DURATION_MS=14_000;
export type PreparedStage={preparedAt:string;durationMs:number;run:Run;audioUrl:string};
type ReplayEvent={start:number;end:number};

/** Compress the recorded timeline; keep parallel actions and their actual outcomes. */
export function stageTimeline(run:Run):ReplayEvent[]{
 const starts=run.events.map(event=>Date.parse(event.at));
 const last=Math.max(...starts)+1;
 const ends=run.events.map((event,index)=>{
  if(event.finishedAt)return Math.max(starts[index]+1,Date.parse(event.finishedAt));
  const next=run.events.slice(index+1).find(candidate=>event.stage==='action'||candidate.stage!=='action');
  return Math.max(starts[index]+1,next?Date.parse(next.at):last);
 });
 const rewrite=run.events.find(event=>event.stage==='rewrite');
 const speech=run.events.find(event=>event.stage==='speech');
 const rewriteAt=rewrite?Date.parse(rewrite.at):last;
 const speechAt=speech?Date.parse(speech.at):last;
 const sourceTimes=[...new Set([...starts,...ends].filter(time=>time<rewriteAt))].sort((a,b)=>a-b);
 const finish=Math.max(last,...ends);
 const offset=(time:number)=>{
  if(time<rewriteAt)return sourceTimes.indexOf(time)/Math.max(1,sourceTimes.length)*9_000;
  if(time<speechAt)return 9_000+(time-rewriteAt)/Math.max(1,speechAt-rewriteAt)*3_000;
  return 12_000+(time-speechAt)/Math.max(1,finish-speechAt)*2_000;
 };
 return starts.map((start,index)=>({start:offset(start),end:offset(ends[index])}));
}

export function stageFrame(prepared:Run,timeline:ReplayEvent[],elapsedMs:number):Run{
 if(elapsedMs>=STAGE_DURATION_MS)return {...prepared,status:'ready'};
 return {...prepared,status:'running',events:prepared.events.flatMap((event,index)=>{
  const timing=timeline[index];
  return elapsedMs<timing.start?[]:[{...event,status:elapsedMs>=timing.end?event.status:'running'}];
 })};
}
