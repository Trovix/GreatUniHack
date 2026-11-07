import {describe,expect,it} from 'vitest';
import {audioRange} from '../../apps/demo/audio';

describe('seekable narration',()=>{
 it('supports explicit, open-ended and suffix byte ranges',()=>{
  expect(audioRange('bytes=0-1',100)).toEqual({start:0,end:1});
  expect(audioRange('bytes=30-',100)).toEqual({start:30,end:99});
  expect(audioRange('bytes=-20',100)).toEqual({start:80,end:99});
  expect(audioRange('bytes=80-150',100)).toEqual({start:80,end:99});
 });
 it('rejects invalid or unsatisfiable ranges',()=>{
  for(const header of ['bytes=100-','bytes=9-2','bytes=-0','bytes=-','bytes=1-2,5-6','not-a-range'])expect(audioRange(header,100)).toBeUndefined();
 });
});
