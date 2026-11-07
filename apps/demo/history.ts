import type {Run} from './types';
export type ChatEntry={id:string;title:string;request:string;status:Run['status'];href:string;updatedAt?:string;course?:string};
export function chatHistory(runs:Iterable<Run>,prepared:Run|undefined,stageMode:boolean):ChatEntry[]{
 if(stageMode)return prepared?[{id:prepared.id,title:prepared.title||'Decision-making with risk',request:prepared.request,status:'ready',href:'/stage?lesson=1',course:prepared.course}]:[];
 return [...runs].sort((a,b)=>Date.parse(b.events.at(-1)?.at||'')-Date.parse(a.events.at(-1)?.at||'')).slice(0,50).map(run=>({id:run.id,title:run.title||run.request,request:run.request,status:run.status,href:'/?run='+encodeURIComponent(run.id),updatedAt:run.events.at(-1)?.at,course:run.course}));
}
