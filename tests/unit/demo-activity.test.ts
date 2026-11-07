import {EventEmitter} from 'node:events';
import {runInNewContext} from 'node:vm';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {spawn} from 'node:child_process';
import {cleanProductText,describeAction,mergeActions,readAgentActions,type ActionRecord,type Activity} from '../../apps/demo/activity';

vi.mock('node:child_process',()=>({spawn:vi.fn()}));
afterEach(()=>vi.clearAllMocks());
const action=(key:string,status:ActionRecord['status']='running'):ActionRecord=>({key,agentId:'parent',agent:'Lecture agent',name:'repl',hint:'Open transcripts panel',at:'2026-11-07T10:00:00.000Z',status});

describe('lecture activity',()=>{
 it('retains distinct operations with identical labels and updates only the matching result',()=>{
  const events:Activity[]=[];
  expect(mergeActions(events,[action('parent:a'),action('parent:b')])).toBe(true);
  expect(events).toHaveLength(2);
  expect(mergeActions(events,[{...action('parent:a','done'),finishedAt:'2026-11-07T10:00:02.000Z'}])).toBe(true);
  expect(events.map(event=>event.status)).toEqual(['done','running']);
  expect(mergeActions(events,[{...action('parent:a','done'),finishedAt:'2026-11-07T10:00:02.000Z'}])).toBe(false);
  mergeActions(events,[action('parent:b','error')]);
  expect(events.map(event=>event.status)).toEqual(['done','error']);
 });

 it('keeps parallel agents separate and sorts their actions by actual start time',()=>{
  const events:Activity[]=[];
  mergeActions(events,[action('parent:same','done'),{...action('child:same'),agentId:'child',agent:'Source agent 1',at:'2026-11-07T09:59:59.000Z'}]);
  expect(events.map(event=>event.agent)).toEqual(['Source agent 1','Lecture agent']);
  expect(events.map(event=>event.status)).toEqual(['running','done']);
 });

 it('uses source-specific language without exposing commands, paths or vendors',()=>{
  expect(describeAction('bash','Print transcript part 3')).toEqual({title:'Reading the lecture transcript from Moodle',detail:'Transcript, part 3'});
  expect(describeAction('repl','View slides 15,16,18,21').detail).toBe('Slides 15,16,18,21');
  expect(describeAction('repl','Attach Echo360 tab').title).toBe('Opening the lecture recording linked from Moodle');
  expect(describeAction('bash','Render montage of figure pages').title).toContain('diagrams');
  expect(describeAction('bash','secret shell command /private/tmp/key').title).toBe('Working through the lecture material');
  expect(cleanProductText('Claude · Aside CLI uses ElevenLabs and OpenAI')).not.toMatch(/Claude|Aside|ElevenLabs|OpenAI/i);
 });

 it('collects the complete parent and child action history, exposing no reasoning or raw tool results',async()=>{
  const logs:string[]=[];
  const timestamp=Date.parse('2026-11-07T10:00:00Z');
  const messages:Record<string,unknown[]>={
   root:[{role:'assistant',timestamp,content:[{type:'thinking',thinking:'PRIVATE REASONING'},{type:'toolCall',id:'first',name:'repl',arguments:{title:'Download transcript',code:'PRIVATE CODE'}}]},{role:'toolResult',toolCallId:'first',timestamp:timestamp+1000,isError:false,content:'PRIVATE SOURCE TEXT'}],
   child:[{role:'assistant',timestamp:timestamp+500,content:[{type:'toolCall',id:'second',name:'bash',arguments:{title:'Read slides 2-4',command:'PRIVATE COMMAND'}}]}]
  };
  const read=vi.fn(async(id:string,options:unknown)=>{expect(options).toEqual({limit:5000,order:'asc'});return messages[id];});
  vi.mocked(spawn).mockImplementation(((_bin:string,args:string[],options:{env:NodeJS.ProcessEnv})=>{
   expect(options.env.OPENAI_API_KEY).toBeUndefined();
   expect(options.env.ELEVENLABS_API_KEY).toBeUndefined();
   const child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),kill:vi.fn()});
   queueMicrotask(async()=>{
    await runInNewContext('(async()=>{'+args[1]+'})()',{
     aside:{sessions:{messages:read,childSessions:async(id:string)=>id==='root'?[{id:'child'}]:[]}},
     console:{log:(line:string)=>logs.push(line)}
    });
    child.stdout.emit('data',logs.join('\n')+'\n');child.emit('close',0);
   });
   return child;
  }) as unknown as typeof spawn);
  const records=await readAgentActions('root',{OPENAI_API_KEY:'private',ELEVENLABS_API_KEY:'private'});
  expect(read).toHaveBeenCalledTimes(2);
  expect(records.map(record=>[record.agent,record.status])).toEqual([['Lecture agent','done'],['Source agent 1','running']]);
  expect(records[0].finishedAt).toBe('2026-11-07T10:00:01.000Z');
  expect(JSON.stringify(records)).not.toContain('PRIVATE');
 });
});
