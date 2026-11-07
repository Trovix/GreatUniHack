import {useEffect,useRef,useState} from 'react';
import type {Run} from './types';
import {tracePhases} from './trace';
import {ProductText} from './ProductText';

function Mark({status}:{status:string}){
 return <span className={`activity-mark mark-${status}`} aria-hidden="true">{status==='done'?<svg viewBox="0 0 16 16"><path d="m3 8 3 3 7-7"/></svg>:status==='error'?'!':<span/>}</span>;
}

export function Trace({run,open,onToggle}:{run:Run;open:boolean;onToggle:(open:boolean)=>void}){
 const groups=tracePhases(run),done=groups.filter(group=>group.status==='done').length;
 const errors=run.events.filter(event=>event.status==='error').length;
 const[expanded,setExpanded]=useState(false),list=useRef<HTMLOListElement>(null),follow=useRef(true);
 useEffect(()=>{setExpanded(false);follow.current=true;},[run.id,run.status]);
 useEffect(()=>{if(expanded&&follow.current&&list.current)list.current.scrollTop=list.current.scrollHeight;},[run.events.length,expanded]);
 return <details className="completed-work" open={open} onToggle={event=>onToggle(event.currentTarget.open)}>
  <summary className="trace-summary"><span>{run.status==='ready'?'Your lecture is prepared':'Lecture preparation'}</span><span className="trace-count">{done} / {groups.length}<span className="trace-chevron" aria-hidden="true"/></span></summary>
  <div className="trace-body">
   <ol className="trace-overview" aria-label="Lecture preparation steps">
    {groups.map(group=><li className={`phase-step ${group.status}`} key={group.id}>
     <Mark status={group.status}/><div><p><ProductText>{group.title}</ProductText><span className="sr-only"> — {group.status==='done'?'Completed':group.status==='running'?'In progress':group.status==='error'?'Attempt failed':'Waiting'}</span></p>
     </div>
    </li>)}
   </ol>
   {run.activityNotice&&<p className="activity-notice" role="status">{run.activityNotice}</p>}
   <details className="trace-details" open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}>
    <summary>View detailed activity</summary>
    <p className="trace-log-note">{run.events.length} actions{errors>0?` · ${errors} failed attempts`:""}</p>
    <ol className="activity" ref={list} role="log" aria-label="Lecture activity" onScroll={event=>{const element=event.currentTarget;follow.current=element.scrollHeight-element.scrollTop-element.clientHeight<48;}}>
     {run.events.map((event,index)=><li key={event.key||event.id} className={event.status}>
      <Mark status={event.status}/><div className="activity-copy">
       <div className="activity-line"><p className="activity-title"><ProductText>{event.title}</ProductText></p><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}</time></div>
       {event.detail&&<p className="activity-detail"><ProductText>{event.detail}</ProductText></p>}
       <p className="activity-context">{event.agent&&event.agent!==run.events[index-1]?.agent&&<span>{event.agent}</span>}{event.status==='error'&&<span>Attempt failed</span>}{event.finishedAt&&<span>{Math.max(0,(Date.parse(event.finishedAt)-Date.parse(event.at))/1000).toFixed(1)}s</span>}</p>
      </div>
     </li>)}
    </ol>
   </details>
  </div>
 </details>;
}
