import type {Activity} from './activity';
import type {TimedWord} from './captions';

export type Run={
 id:string;request:string;status:'running'|'ready'|'error'|'cancelled';events:Activity[];
 title?:string;course?:string;date?:string;sources?:{label:string;kind:string;url:string}[];
 script?:string;audio?:boolean;duration?:number;error?:string;scope?:string;activityNotice?:string;words?:TimedWord[];captionNotice?:string;
};
