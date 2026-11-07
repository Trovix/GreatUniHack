export const MAX_DICTATION_BYTES=8*1024*1024;
const formats:Record<string,string>={'audio/webm':'webm','video/webm':'webm','audio/ogg':'ogg','audio/mp4':'m4a','audio/wav':'wav','audio/x-wav':'wav','audio/mpeg':'mp3'};
export class DictationError extends Error{constructor(message:string,public status=400){super(message);}}
export async function transcribeRequest(bytes:Uint8Array,contentType:string,key:string|undefined,fetcher:typeof fetch=fetch,signal?:AbortSignal):Promise<string>{
 const mime=contentType.split(';')[0].trim().toLowerCase(),extension=formats[mime];
 if(!extension)throw new DictationError('This recording format is not supported.',415);
 if(bytes.byteLength<100)throw new DictationError('No speech was recorded. Please try again.');
 if(bytes.byteLength>MAX_DICTATION_BYTES)throw new DictationError('Please keep your dictated request under one minute.',413);
 if(!key)throw new DictationError('Voice input is not configured on this machine.',503);
 const form=new FormData();form.set('model_id','scribe_v2');form.set('language_code','en');form.set('timestamps_granularity','none');form.set('tag_audio_events','false');form.set('diarize','false');form.set('file',new Blob([Buffer.from(bytes)],{type:mime}),'request.'+extension);
 const response=await fetcher('https://api.elevenlabs.io/v1/speech-to-text',{method:'POST',headers:{'xi-api-key':key},body:form,signal});
 if(!response.ok)throw new DictationError(response.status===429?'Voice input is busy. Please try again in a moment.':response.status===401||response.status===403?'Voice input could not connect. You can still type your request.':'Could not transcribe the recording. Please try again.',response.status===429?429:502);
 const result=await response.json() as {text?:unknown};const text=typeof result.text==='string'?result.text.trim():'';
 if(!text)throw new DictationError('No speech was detected. Please try again.');
 if(text.length>1200)throw new DictationError('That request is too long. Please dictate a shorter request.');
 return text;
}
