import {describe,expect,it} from 'vitest';
import {agentSessionId} from '../../apps/demo/agent-session';

describe('lecture agent session identifiers',()=>{
 it('continues the actual agent when CLI output identifies its dated artifact directory',()=>{
  expect(agentSessionId('2026-11-07_ExampleSession42')).toBe('ExampleSession42');
 });

 it('preserves IDs already returned by the session inspector and live activity stream',()=>{
  expect(agentSessionId('ExampleSession42')).toBe('ExampleSession42');
  expect(agentSessionId('ses_01HQ7B7ABCDEFGH')).toBe('ses_01HQ7B7ABCDEFGH');
 });

 it('rejects missing IDs and artifact paths instead of passing them to the continuation command',()=>{
  for(const value of [undefined,null,{},'', 'short','/sessions/2026-11-07_ExampleSession42'])expect(agentSessionId(value)).toBeUndefined();
 });
});
