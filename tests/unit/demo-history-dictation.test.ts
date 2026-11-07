import {describe,expect,it,vi} from 'vitest';
import {chatHistory} from '../../apps/demo/history';
import {transcribeRequest,MAX_DICTATION_BYTES} from '../../apps/demo/dictation-api';
import type {Run} from '../../apps/demo/types';
const run=(id:string,title:string,at:string):Run=>({id,title,request:'Teach me '+title,status:'ready',events:[{id:1,stage:'speech',title:'Narration ready',status:'done',at}]});
const econ=run('econ','Decision-making with risk: lotteries and expected utility','2026-11-07T16:00:00Z');
const politics=run('politics','Machiavelli’s The Prince','2026-11-07T18:00:00Z');
describe('separate chat histories',()=>{
 it('preloads the economics lesson in the deterministic history without exposing live chats or mode labels',()=>{
  const chats=chatHistory([politics],econ,true);expect(chats).toHaveLength(1);expect(chats[0]).toMatchObject({title:econ.title,href:'/stage?lesson=1',status:'ready'});expect(chats[0].title).not.toMatch(/stage|demo/i);
 });
 it('keeps every live chat link on the live site and orders recent requests first',()=>{
  const chats=chatHistory([econ,politics],econ,false);expect(chats.map(chat=>chat.id)).toEqual(['politics','econ']);expect(chats.every(chat=>chat.href.startsWith('/?run='))).toBe(true);expect(chats[0]).not.toHaveProperty('events');expect(chats[0]).not.toHaveProperty('script');
 });
});
describe('ElevenLabs request dictation',()=>{
 it('uploads browser audio to Scribe and returns editable text using a server-side key',async()=>{
  const fetcher=vi.fn(async(url,options)=>{expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');expect(options.headers).toEqual({'xi-api-key':'server-only-test-key'});const form=options.body as FormData;expect(form.get('model_id')).toBe('scribe_v2');expect(form.get('timestamps_granularity')).toBe('none');expect((form.get('file') as File).type).toBe('audio/webm');return new Response(JSON.stringify({text:' Teach me my latest lecture. '}));}) as unknown as typeof fetch;
  expect(await transcribeRequest(Buffer.alloc(512),'audio/webm;codecs=opus','server-only-test-key',fetcher)).toBe('Teach me my latest lecture.');
 });
 it('rejects missing credentials, unsupported formats and oversized recordings before making a paid request',async()=>{
  const fetcher=vi.fn() as unknown as typeof fetch;
  await expect(transcribeRequest(Buffer.alloc(512),'audio/webm',undefined,fetcher)).rejects.toMatchObject({status:503});
  await expect(transcribeRequest(Buffer.alloc(512),'text/plain','key',fetcher)).rejects.toMatchObject({status:415});
  await expect(transcribeRequest(Buffer.alloc(MAX_DICTATION_BYTES+1),'audio/webm','key',fetcher)).rejects.toMatchObject({status:413});expect(fetcher).not.toHaveBeenCalled();
 });
 it('reports no speech and provider errors without returning provider payloads or credentials',async()=>{
  const empty=vi.fn(async()=>new Response(JSON.stringify({text:''}))) as unknown as typeof fetch;
  await expect(transcribeRequest(Buffer.alloc(512),'audio/webm','key',empty)).rejects.toThrow('No speech was detected');
  const limited=vi.fn(async()=>new Response('private provider diagnostic',{status:429})) as unknown as typeof fetch;
  await expect(transcribeRequest(Buffer.alloc(512),'audio/mp4','key',limited)).rejects.toMatchObject({status:429,message:'Voice input is busy. Please try again in a moment.'});
 });
});
