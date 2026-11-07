/** CLI output may contain an artifact directory ID rather than the agent's ID. */
export function agentSessionId(value:unknown):string|undefined{
 if(typeof value!=='string')return;
 const id=value.trim().replace(/^\d{4}-\d{2}-\d{2}_/,'');
 return /^[A-Za-z0-9_-]{12,80}$/.test(id)?id:undefined;
}
