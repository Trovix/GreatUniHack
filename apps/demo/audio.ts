import type {IncomingMessage,ServerResponse} from 'node:http';

export function audioRange(header:string,length:number):{start:number;end:number}|undefined{
 const match=/^bytes=(\d*)-(\d*)$/.exec(header);if(!match||!match[1]&&!match[2])return;
 const start=match[1]?Number(match[1]):Math.max(0,length-Number(match[2]));
 const end=match[1]&&match[2]?Math.min(length-1,Number(match[2])):length-1;
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=length||end<start||(!match[1]&&Number(match[2])<=0))return;
 return{start,end};
}

/** Native players need byte ranges to seek beyond the currently buffered audio. */
export function sendAudio(req:IncomingMessage,res:ServerResponse,bytes:Uint8Array,cache='no-store'){
 const headers={'Content-Type':'audio/wav','Accept-Ranges':'bytes','Cache-Control':cache};
 if(!req.headers.range){res.writeHead(200,{...headers,'Content-Length':bytes.length});res.end(bytes);return;}
 const range=audioRange(req.headers.range,bytes.length);
 if(!range){res.writeHead(416,{...headers,'Content-Range':`bytes */${bytes.length}`});res.end();return;}
 res.writeHead(206,{...headers,'Content-Length':range.end-range.start+1,'Content-Range':`bytes ${range.start}-${range.end}/${bytes.length}`});
 res.end(bytes.subarray(range.start,range.end+1));
}
