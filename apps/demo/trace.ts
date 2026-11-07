import type {Activity} from './activity';
import type {Run} from './types';

export const phases=[
 {id:'find',title:'Find your lecture on Moodle'},
 {id:'transcript',title:'Retrieve the lecture transcript'},
 {id:'materials',title:'Read the matching notes and slides'},
 {id:'rewrite',title:'Explain the lecture without visuals'},
 {id:'speech',title:'Create your narrated lesson'}
]as const;
type PhaseId=typeof phases[number]['id'];
export function eventPhase(event:Activity):PhaseId{
 if(event.stage==='rewrite'||event.stage==='speech')return event.stage;
 if(event.stage==='transcript')return'transcript';
 if(event.stage==='notes')return'materials';
 if(/transcript|caption/i.test(event.title))return'transcript';
 if(/notes|slides|diagrams/i.test(event.title))return'materials';
 return'find';
}

/** Milestones follow verified pipeline boundaries, not individual tool attempts. */
export function tracePhases(run:Run){
 const ready=run.status==='ready';
 const hasStage=(stage:string)=>run.events.some(event=>event.stage===stage);
 const stageDone=(stage:string)=>run.events.some(event=>event.stage===stage&&event.status==='done');
 const adapted=hasStage('rewrite')||hasStage('speech');
 const foundSource=run.events.some(event=>['transcript','materials'].includes(eventPhase(event)));
 const completed:Record<PhaseId,boolean>={find:foundSource||adapted,transcript:stageDone('transcript')||adapted,materials:stageDone('notes')||adapted,rewrite:stageDone('rewrite')||hasStage('speech'),speech:stageDone('speech')};
 return phases.map(phase=>{
  const events=run.events.filter(event=>eventPhase(event)===phase.id);
  const started=events.length>0;
  const status=ready||completed[phase.id]?'done':!started?'pending':run.status==='error'?'error':run.status==='cancelled'?'pending':'running';
  return{...phase,status,events};
 });
}

export function preparationTitle(run:Run):string{
 if(run.events.some(event=>event.stage==='speech'))return'Creating your narrated lesson';
 if(run.events.some(event=>event.stage==='rewrite'))return'Explaining the lecture without visuals';
 if(run.events.some(event=>['transcript','materials'].includes(eventPhase(event))))return'Gathering your lecture materials from Moodle';
 return'Finding your lecture on Moodle';
}
