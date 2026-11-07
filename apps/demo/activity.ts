import {spawn} from 'node:child_process';

export type Activity = {
 id:number; key?:string; stage:string; title:string; detail?:string; at:string;
 status:'running'|'done'|'error'; finishedAt?:string; agent?:string; agentId?:string;
};
export type ActionRecord = {
 key:string; agentId:string; agent:string; name:string; hint:string; at:string;
 status:'running'|'done'|'error'; finishedAt?:string;
};
const timestamp=(value:unknown)=>{
 const date=new Date(typeof value==='number'||typeof value==='string'?value:Date.now());
 return Number.isFinite(date.getTime())?date.toISOString():new Date().toISOString();
};
/** Product descriptions of observed operations; no prompts, reasoning, shell commands or raw outputs. */
export function describeAction(name:string,hint:string):{title:string;detail?:string}{
 const text=hint.toLowerCase();
 if(/subagent|delegate|spawn_agent|task_agent/.test(name))return{title:'Assigning work to a source agent',detail:'Finding the materials for this lecture.'};
 if(/transcript|caption|\bvtt\b/.test(text)){
  const part=hint.match(/part\s+(\d+)/i)?.[1];
  return{title:/download|fetch|export/.test(text)?'Fetching the lecture transcript from Moodle':'Reading the lecture transcript from Moodle',...(part?{detail:'Transcript, part '+part}:{})};
 }
 if(/compare.*notes|notes.*slides/.test(text))return{title:'Checking the notes against the lecture slides from Moodle'};
 if(/slide|presentation|powerpoint/.test(text)){
  const pages=hint.match(/(?:slides?|pages?)\s+([\d,\s–—-]+)/i)?.[1]?.trim();
  return{title:'Reading the lecture slides from Moodle',...(pages?{detail:'Slides '+pages}:{})};
 }
 if(/pdf|notes|handout/.test(text))return{title:/download|fetch/.test(text)?'Fetching the lecture notes from Moodle':'Reading the lecture notes from Moodle'};
 if(/figure|diagram|graph/.test(text))return{title:'Reading the diagrams in your lecture slides from Moodle'};
 if(/recording|echo360|panopto|video/.test(text))return{title:'Opening the lecture recording linked from Moodle'};
 if(/memory|context|skill|\.md\b/.test(text))return{title:'Finding the right course on Moodle'};
 if(/tabs|dashboard/.test(text))return{title:'Checking your Moodle courses'};
 if(/course index|sections|index entries|section links/.test(text))return{title:'Looking through the lecture materials on Moodle'};
 if(/open.*course/.test(text))return{title:'Opening your course on Moodle'};
 if(/latest|date|week|order/.test(text))return{title:'Finding your most recent lecture on Moodle'};
 if(/download|fetch/.test(text)||/fetch|download/.test(name))return{title:'Fetching the lecture material from Moodle'};
 if(/write|save/.test(name+' '+text))return{title:'Saving the retrieved lecture material'};
 if(/read_file/.test(name))return{title:'Reading the retrieved lecture material'};
 if(/repl|browser|navigate|click/.test(name))return{title:'Reading the course page on Moodle'};
 return{title:'Working through the lecture material'};
}
export function cleanProductText(text:string):string{
 return text.replace(/Claude\s*[·→-]?\s*Aside\s*CLI/gi,'Your lecture agent')
  .replace(/Aside(?:\s+CLI|\s+browser)?/gi,'your course browser')
  .replace(/Claude|OpenAI|ChatGPT|Codex/gi,'the lecture agent')
  .replace(/ElevenLabs(?:\s+voice)?/gi,'narration')
  .replace(/Echo360|Panopto/gi,'lecture recordings');
}
export function mergeActions(events:Activity[],records:ActionRecord[]):boolean{
 let changed=false;
 for(const record of records){
  const key='tool:'+record.key;const current=events.find(event=>event.key===key);
  const description=describeAction(record.name,record.hint);
  const value={key,stage:'action',...description,at:timestamp(record.at),status:record.status,finishedAt:record.finishedAt,agent:record.agent,agentId:record.agentId};
  if(current){if(Object.entries(value).some(([key,next])=>current[key as keyof Activity]!==next)){Object.assign(current,value);changed=true;}}
  else{events.push({id:Math.max(0,...events.map(event=>event.id))+1,...value});changed=true;}
 }
 if(changed)events.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.id-b.id);
 return changed;
}
const activityCode=(rootId:string)=>`var activityQueue=[{id:${JSON.stringify(rootId)},label:'Lecture agent'}], activityVisited=new Set(), activityRecords=[]; while(activityQueue.length&&activityVisited.size<24){var activityTask=activityQueue.shift();if(activityVisited.has(activityTask.id))continue;activityVisited.add(activityTask.id);var activityMessages=await aside.sessions.messages(activityTask.id,{limit:5000,order:'asc'});var activityResults=new Map(activityMessages.filter(m=>m.role==='toolResult').map(m=>[m.toolCallId,m]));for(var activityMessage of activityMessages){if(activityMessage.role!=='assistant'||!Array.isArray(activityMessage.content))continue;for(var activityCall of activityMessage.content){if(activityCall.type!=='toolCall')continue;var activityResult=activityResults.get(activityCall.id);activityRecords.push({key:activityTask.id+':'+activityCall.id,agentId:activityTask.id,agent:activityTask.label,name:activityCall.name,hint:String(activityCall.arguments?.title||activityCall.arguments?.description||activityCall.arguments?.path||'').slice(0,300),at:activityMessage.timestamp,status:activityResult?(activityResult.isError?'error':'done'):'running',finishedAt:activityResult?.timestamp});}}var activityChildren=await aside.sessions.childSessions(activityTask.id);for(var activityChild of activityChildren){activityQueue.push({id:activityChild.id,label:'Source agent '+(activityVisited.size+activityQueue.length)});}}console.log('LECTURE_ACTIVITY='+JSON.stringify(activityRecords));`;
export async function readAgentActions(sessionId:string,env:NodeJS.ProcessEnv=process.env):Promise<ActionRecord[]>{
 const cleanEnv={...env};for(const key of Object.keys(cleanEnv))if(/API_KEY|KEY_FILE|AUTH_TOKEN/.test(key))delete cleanEnv[key];
 return new Promise((resolve,reject)=>{
  const child=spawn(process.env.ASIDE_BIN||'aside',['repl',activityCode(sessionId)],{env:cleanEnv,stdio:['ignore','pipe','ignore']});let output='';
  const timer=setTimeout(()=>{child.kill();reject(new Error('Activity observer timed out.'));},25000);
  child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>2000000){child.kill();reject(new Error('Activity data exceeded its limit.'));}});
  child.on('error',()=>{clearTimeout(timer);reject(new Error('Activity observer unavailable.'));});
  child.on('close',code=>{clearTimeout(timer);try{if(code!==0)throw new Error();const line=output.split('\n').find(line=>line.startsWith('LECTURE_ACTIVITY='));if(!line)throw new Error();const records=JSON.parse(line.slice('LECTURE_ACTIVITY='.length));resolve(records.map((record:ActionRecord)=>({...record,at:timestamp(record.at),...(record.finishedAt?{finishedAt:timestamp(record.finishedAt)}:{})})));}catch{reject(new Error('Activity observer returned no actions.'));}});
 });
}
export function observeAgentActions(getSession:()=>string|undefined,onRecords:(records:ActionRecord[])=>void,onAvailability?:(available:boolean)=>void){
 let pending:Promise<void>|undefined,stopped=false;
 const poll=()=>{const id=getSession();if(!id||pending)return pending;pending=readAgentActions(id).then(records=>{onRecords(records);onAvailability?.(true);}).catch(()=>{onAvailability?.(false);}).finally(()=>{pending=undefined;});return pending;};
 const interval=setInterval(()=>{if(!stopped)void poll();},1500);void poll();
 return{async finish(){stopped=true;clearInterval(interval);await pending;await poll();}};
}
