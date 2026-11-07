import {Fragment} from 'react';

/** Keep Moodle identifiable inline without adding a second label or external image request. */
export function ProductText({children}:{children:string}){
 return <>{children.split(/(\bMoodle\b)/gi).map((part,index)=>/^moodle$/i.test(part)
  ?<span className="moodle-word" key={index}><img src="/moodle-logo.svg" alt="Moodle" draggable={false}/></span>
  :<Fragment key={index}>{part}</Fragment>)}</>;
}
