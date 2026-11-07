import {describe,expect,it} from 'vitest';
import {isLessonAnswer,isSourceAnswer,jsonObjects,parseJson} from '../../apps/demo/agent-output';

const blocked={blocked:true,message:"Moodle showed 'You are not logged in', so no {lecture} was found."};

describe('reading the lecture agent output',()=>{
 it('strips terminal colour codes around a single answer',()=>{
  expect(parseJson(`${JSON.stringify(blocked)}\u001b[0m\n`,isSourceAnswer)).toEqual(blocked);
 });
 it('picks the answer when other JSON and lines surround it',()=>{
  const output=`\u001b[2m{"event":"tool","name":"browser"}\u001b[0m\nOpening Moodle {course}\n\n${JSON.stringify(blocked)}\n\u001b[2m[ok | 15ms]\u001b[0m`;
  expect(parseJson(output,isSourceAnswer)).toEqual(blocked);
 });
 it('keeps braces and quotes inside strings intact',()=>{
  const lesson={title:'Risk',scope:'Opening lesson',script:'Say "expected value {E}" aloud, then pause.'};
  expect(jsonObjects(`note {\n${JSON.stringify(lesson)}`)).toEqual([lesson]);
  expect(parseJson(`Here you go:\n${JSON.stringify(lesson)}\n{"usage":1}`,isLessonAnswer)).toEqual(lesson);
 });
 it('fails clearly when there is no JSON at all',()=>{
  expect(()=>parseJson('no answer here',isSourceAnswer)).toThrow('did not return a readable answer');
 });
});
