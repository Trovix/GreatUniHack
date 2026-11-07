import {describe,expect,it} from 'vitest';
import {nextSpeed,parseCommand,speak,spokenCourse,spokenDuration} from '../../apps/demo/voice-commands';

describe('demo voice commands',()=>{
 it('recognises player commands in natural phrasing',()=>{
  expect(parseCommand('Play.')).toEqual({kind:'play'});
  expect(parseCommand('Okay, pause it please')).toEqual({kind:'pause'});
  expect(parseCommand('go back')).toEqual({kind:'back',seconds:10});
  expect(parseCommand('Go back thirty seconds')).toEqual({kind:'back',seconds:30});
  expect(parseCommand('skip ahead 1 minute')).toEqual({kind:'forward',seconds:60});
  expect(parseCommand('Can you slow down?')).toEqual({kind:'slower'});
  expect(parseCommand('speed up')).toEqual({kind:'faster'});
  expect(parseCommand('Start over')).toEqual({kind:'restart'});
  expect(parseCommand('Where am I?')).toEqual({kind:'where'});
  expect(parseCommand('How much is left')).toEqual({kind:'where'});
  expect(parseCommand('What can I say?')).toEqual({kind:'help'});
 });
 it('treats lecture requests and library questions separately',()=>{
  expect(parseCommand('Teach me the content from my latest microeconomics lecture')).toEqual({kind:'request'});
  expect(parseCommand('What lectures do I have?')).toEqual({kind:'library'});
  expect(parseCommand('Open the latest one')).toEqual({kind:'open',index:0});
  expect(parseCommand('open number two')).toEqual({kind:'open',index:1});
  expect(parseCommand('Back to the request')).toEqual({kind:'new'});
  expect(parseCommand('explain that again')).toEqual({kind:'back',seconds:10});
  expect(parseCommand('mumble')).toEqual({kind:'unknown'});
 });
 it('steps through the player speeds',()=>{
  expect(nextSpeed(1,1)).toBe(1.25);expect(nextSpeed(1,-1)).toBe(.75);expect(nextSpeed(2,1)).toBe(2);expect(nextSpeed(.75,-1)).toBe(.75);
 });
 it('writes feedback the way a listener would hear it',()=>{
  expect(spokenDuration(65.8)).toBe('1 minute 6 seconds');
  expect(spokenDuration(45)).toBe('45 seconds');
  expect(spokenCourse('EC2A3 - Microeconomics II 2026/27 (Moodle)')).toBe('Microeconomics II');
  expect(speak.ready({title:'Decision-making with risk',course:'EC2A3 - Microeconomics II 2026/27',duration:65.8}))
   .toBe("Your lecture is ready: Decision-making with risk, from Microeconomics II. It's 1 minute 6 seconds long. Say play to start. You can ask me to pause, go back, or slow down at any time.");
  expect(speak.where(30,95)).toBe("You're 30 seconds in, with 1 minute 5 seconds left.");
  expect(speak.speed(1.5)).toBe('Playing at 1.5 times speed.');
 });
});
