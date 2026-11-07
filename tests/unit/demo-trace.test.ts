import {describe,expect,it} from 'vitest';
import {tracePhases,preparationTitle} from '../../apps/demo/trace';
import type {Run} from '../../apps/demo/types';
const run:Run={id:'test',request:'Teach me my lecture',status:'running',events:[
 {id:1,stage:'aside',title:'Finding your lecture on Moodle',at:'2026-11-07T10:00:00Z',status:'running'},
 {id:2,stage:'action',title:'Reading the course page on Moodle',at:'2026-11-07T10:00:01Z',status:'error'},
 {id:3,stage:'action',title:'Opening your course on Moodle',at:'2026-11-07T10:00:02Z',status:'done'},
 {id:4,stage:'action',title:'Reading the lecture transcript from Moodle',at:'2026-11-07T10:00:03Z',status:'running',agent:'Lecture agent'},
 {id:5,stage:'action',title:'Reading the lecture slides from Moodle',at:'2026-11-07T10:00:03Z',status:'running',agent:'Source agent 1'}
]};
describe('readable lecture trace',()=>{
 it('summarizes parallel work without losing or duplicating any observed action',()=>{
  const groups=tracePhases(run);
  expect(groups).toHaveLength(5);
  expect(groups.map(group=>group.status)).toEqual(['done','running','running','pending','pending']);
  expect(groups.flatMap(group=>group.events).map(event=>event.id).sort()).toEqual(run.events.map(event=>event.id));
 });
 it('keeps failed attempts in the complete history after the lecture succeeds',()=>{
  const groups=tracePhases({...run,status:'ready'});
  expect(groups.every(group=>group.status==='done')).toBe(true);
  expect(groups.flatMap(group=>group.events).filter(event=>event.status==='error')).toHaveLength(1);
  expect(run.events[1].status).toBe('error');
 });
 it('does not mark pending work complete when a request fails',()=>{
  const groups=tracePhases({...run,status:'error',events:run.events.slice(0,2).map(event=>({...event,status:'error'}))});
  expect(groups.map(group=>group.status)).toEqual(['error','pending','pending','pending','pending']);
 });
 it('keeps milestone states and the heading stable between rapid source operations',()=>{
  const earlier={...run,events:run.events.map(event=>({...event,status:'done' as const}))};
  const later={...earlier,events:[...earlier.events,{...run.events[3],id:6,title:'Reading transcript part 3',status:'running' as const}]};
  expect(tracePhases(later).map(group=>group.status)).toEqual(tracePhases(earlier).map(group=>group.status));
  expect(preparationTitle(later)).toBe(preparationTitle(earlier));
  expect(tracePhases(later).slice(1,3).map(group=>group.status)).toEqual(['running','running']);
 });
});
