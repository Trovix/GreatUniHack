import {describe,expect,it} from 'vitest';
import {captionLines,lineForWord,validateWords,wordAtTime,wordsFromAlignment,type TimedWord} from '../../apps/demo/captions';

const words:TimedWord[]=[{text:'A',start:.1,end:.3},{text:'lottery',start:.4,end:1},{text:'is',start:1.2,end:1.4},{text:'uncertain.',start:1.5,end:2}];
describe('synchronized narration',()=>{
 it('preserves character timing, punctuation and pauses when grouping words',()=>{
  const alignment={characters:['H','i',',',' ','t','h','e','r','e','!'],character_start_times_seconds:[0,.1,.2,.4,.8,.9,1,1.1,1.2,1.3],character_end_times_seconds:[.1,.2,.3,.5,.9,1,1.1,1.2,1.3,1.4]};
  expect(wordsFromAlignment({alignment},2)).toEqual([{text:'Hi,',start:0,end:.3},{text:'there!',start:.8,end:1.4}]);
  expect(wordsFromAlignment({normalized_alignment:alignment},2)).toHaveLength(2);
 });
 it('rejects invalid timing instead of estimating progress from word count',()=>{
  expect(()=>wordsFromAlignment({characters:['x'],character_start_times_seconds:[2],character_end_times_seconds:[1]},3)).toThrow();
  expect(()=>validateWords([{text:'wrong',start:8,end:9}],2)).toThrow();
  expect(()=>validateWords([...words,{text:'backwards',start:.5,end:1}],3)).toThrow();
  expect(()=>wordsFromAlignment(undefined,2)).toThrow();
 });
 it('follows the media clock across pauses, forward/backward seeks and the end',()=>{
  expect(wordAtTime(words,0)).toBe(-1);
  expect(wordAtTime(words,.1)).toBe(0);
  expect(wordAtTime(words,1.1)).toBe(1);
  expect(wordAtTime(words,1.5)).toBe(3);
  expect(wordAtTime(words,.2)).toBe(0);
  expect(wordAtTime(words,99)).toBe(3);
 });
 it('fits measured line widths and keeps each word exactly once across responsive layouts',()=>{
  for(const width of [10,20]){
   const lines=captionLines(words,width,text=>text.length);
   expect(lines.flatMap(line=>words.slice(line.from,line.to))).toEqual(words);
   expect(lines.every(line=>line.text.length<=width)).toBe(true);
   for(let index=0;index<words.length;index++){
    const line=lines[lineForWord(lines,index)];expect(index).toBeGreaterThanOrEqual(line.from);expect(index).toBeLessThan(line.to);
   }
  }
 });
});
