/** Reading the lecture agent's answer out of Aside CLI output. */

/** Every complete top-level JSON object in the text, in order. String-aware, so braces inside values do not count. */
export function jsonObjects(text:string):any[]{
 const found:any[]=[];
 for(let start=text.indexOf('{');start>=0;start=text.indexOf('{',start+1)){
  let depth=0,inString=false,escaped=false;
  for(let i=start;i<text.length;i++){
   const c=text[i];
   if(inString){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')inString=false;continue;}
   if(c==='"')inString=true;else if(c==='{')depth++;
   else if(c==='}'&&--depth===0){try{found.push(JSON.parse(text.slice(start,i+1)));start=i;}catch{}break;}
  }
 }
 return found;
}
/**
 * Aside prints the agent's answer with colour codes and sometimes other lines around it. Strip those and
 * return the last JSON object that looks like the expected answer (or the last object, if none does).
 */
export function parseJson(text:string,want:(value:any)=>boolean=()=>true):any{
 const clean=text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'').trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
 try{const value=JSON.parse(clean);if(want(value))return value;}catch{}
 const objects=jsonObjects(clean),match=[...objects].reverse().find(value=>{try{return want(value);}catch{return false;}})??objects.at(-1);
 if(match!==undefined)return match;
 throw new Error('The lecture agent did not return a readable answer. Its output is saved with this request.');
}
export const isSourceAnswer=(value:any)=>!!value&&typeof value==='object'&&(typeof value.transcript==='string'||value.blocked===true||'answer' in value||'result' in value);
export const isLessonAnswer=(value:any)=>!!value&&typeof value==='object'&&(typeof value.script==='string'||typeof value.answer==='string');
