import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProviderError } from './http.js';
import { base64ByteLength } from '../../../packages/core/schemas.js';

export function pcm16Wav(bytes: Uint8Array, sampleRate = 22050): Uint8Array {
  if (!bytes.length || bytes.length % 2 || bytes.length > 25 * 1024 * 1024) throw new ProviderError('INVALID_RESPONSE');
  const out = Buffer.alloc(44 + bytes.length);
  out.write('RIFF', 0); out.writeUInt32LE(36 + bytes.length, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36);
  out.writeUInt32LE(bytes.length, 40); out.set(bytes, 44);
  return out;
}

export function wavDurationMs(bytes: Uint8Array): number {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') throw new ProviderError('INVALID_RESPONSE');
  let byteRate = 0;
  let sampleBytes = 0;
  for (let offset = 12; offset + 8 <= data.length;) {
    const size = data.readUInt32LE(offset + 4);
    if (size > data.length - offset - 8) throw new ProviderError('INVALID_RESPONSE');
    const kind = data.toString('ascii', offset, offset + 4);
    if (kind === 'fmt ' && size >= 16) byteRate = data.readUInt32LE(offset + 16);
    if (kind === 'data') sampleBytes += size;
    offset += 8 + size + (size % 2);
  }
  if (!byteRate || !sampleBytes) throw new ProviderError('INVALID_RESPONSE');
  return Math.round(sampleBytes / byteRate * 1000);
}

function run(command: string, args: string[], input?: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ProviderError('CANCELLED')); return; }
    let child;
    try { child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], signal }); }
    catch { reject(new ProviderError('LOCAL_VOICE_UNAVAILABLE')); return; }
    const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 30_000);
    child.once('error', () => { clearTimeout(timeout); reject(new ProviderError(signal?.aborted ? 'CANCELLED' : 'LOCAL_VOICE_UNAVAILABLE')); });
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new ProviderError(signal?.aborted ? 'CANCELLED' : 'LOCAL_VOICE_UNAVAILABLE')); });
    child.stdin.on('error', () => { /* An unavailable say process can close stdin before its exit event. */ });
    child.stdin.end(input ?? '');
  });
}

export async function nativeMockSpeech(text: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; durationMs: number }> {
  if (process.platform !== 'darwin') throw new ProviderError('LOCAL_VOICE_UNAVAILABLE');
  const dir = await mkdtemp(join(tmpdir(), 'lecture-access-mock-voice-'));
  try {
    const aiff = join(dir, 'speech.aiff');
    const wav = join(dir, 'speech.wav');
    // Text goes to stdin, never shell/CLI arguments, so source strings cannot be executable options.
    await run('/usr/bin/say', ['-o', aiff, '-r', '170'], text, signal);
    await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@22050', aiff, wav], undefined, signal);
    const bytes = await readFile(wav);
    return { bytes, durationMs: wavDurationMs(bytes) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export function strictBase64(value: unknown, maxBytes: number): Uint8Array {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maxBytes / 3) * 4 || base64ByteLength(value) < 1)
    throw new ProviderError('INVALID_RESPONSE');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64') !== value) throw new ProviderError('INVALID_RESPONSE');
  return bytes;
}
