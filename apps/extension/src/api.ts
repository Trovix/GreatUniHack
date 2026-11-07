import type { Lecture } from '../../api/types';
import type { Bundle, QuestionAnswer } from '../../../packages/core/index';
import type { AudioChunk } from '../../api/types';
import { safeSavedUi, type SavedUi } from './model';

export const API_ORIGIN = 'http://127.0.0.1:4317';
const TOKEN_KEY = 'lectureAccessPairing';
const UI_KEY = 'lectureAccessUi';
export type Capabilities = {multimodal: boolean; tts: boolean; stt: boolean; provider: string; model: string; voiceId?: string; mode: 'live' | 'mock'};
export type Fixture = {id: string; title: string};
export type AnswerResult = {answer: QuestionAnswer; chunk?: AudioChunk; latencyMs: number};

export class ApiError extends Error {
  constructor(message: string, public status = 0, public code?: string) { super(message); }
}
function extensionStorage() {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) throw new Error('Open the installed Lecture Access extension to pair securely. Website storage is not used.');
  return chrome.storage;
}
export async function secureSession(): Promise<void> {
  await extensionStorage().session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
}
export async function restoreToken(): Promise<string> {
  await secureSession();
  const value = (await extensionStorage().session.get(TOKEN_KEY))[TOKEN_KEY];
  return typeof value === 'string' ? value : '';
}
export async function rememberToken(token: string): Promise<void> {
  await secureSession();
  await extensionStorage().session.set({[TOKEN_KEY]: token});
}
export async function forgetToken(): Promise<void> { await extensionStorage().session.remove(TOKEN_KEY); }
export async function restoreUi(): Promise<SavedUi> {
  try { return safeSavedUi((await extensionStorage().local.get(UI_KEY))[UI_KEY]); } catch { return {}; }
}
export async function saveUi(value: SavedUi): Promise<void> {
  try { await extensionStorage().local.set({[UI_KEY]: safeSavedUi(value)}); } catch { /* No sensitive content is persisted in the UI preference store. */ }
}
export async function workerMessage<T>(message: {type: string; sectionId?: string; resourceId?: string}): Promise<T> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) throw new Error('Browser capture requires the installed extension.');
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || 'The browser capture was interrupted. Invoke the extension on the source tab again.');
  return result.data as T;
}
export class LocalApi {
  constructor(private token: string) {}
  private async response(path: string, init: RequestInit = {}): Promise<Response> {
    const timeout = AbortSignal.timeout(path.endsWith('/questions') ? 100_000 : 35_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(`${API_ORIGIN}${path}`, {...init, signal, credentials: 'omit', redirect: 'error', cache: 'no-store', headers: {
        ...(init.body ? {'Content-Type': 'application/json'} : {}), ...init.headers, Authorization: `Bearer ${this.token}`,
      }});
    } catch (error) {
      if (init.signal?.aborted) throw error;
      if ((error as Error)?.name === 'TimeoutError') throw new ApiError('The local service took too long. Check its status before retrying a paid action.');
      throw new ApiError('Cannot reach the local service. Start it on 127.0.0.1:4317 and check that its allowed origin exactly matches this extension ID.');
    }
    if (!response.ok) {
      let body: {error?: string; code?: string} = {};
      try { body = await response.json(); } catch { /* Never expose a raw HTML/error response. */ }
      const message = response.status === 401 ? 'Pairing expired or the token was rejected. Pair this browser session again.' : response.status === 403 ?
        'This extension origin is not authorised. Add the exact extension ID to the local service configuration and restart it.' : body.error || `Local request failed (${response.status}).`;
      throw new ApiError(message, response.status, body.code);
    }
    return response;
  }
  async json<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    return (await this.response(path, {method, ...(body === undefined ? {} : {body: JSON.stringify(body)})})).json();
  }
  capabilities() { return this.json<Capabilities>('/capabilities'); }
  lectures() { return this.json<Lecture[]>('/lectures'); }
  lecture(id: string) { return this.json<Lecture>(`/lectures/${encodeURIComponent(id)}`); }
  create(title: string) { return this.json<Lecture>('/lectures', 'POST', {title}); }
  fixtures() { return this.json<Fixture[]>('/fixtures'); }
  fixture(fixtureId: string) { return this.json<Lecture>('/lectures/fixture', 'POST', {fixtureId}); }
  input(id: string, revision: number, bundle: Bundle) { return this.json<Lecture>(`/lectures/${encodeURIComponent(id)}/input`, 'PUT', {expectedRevision: revision, bundle}); }
  action(id: string, revision: number, action: 'compile' | 'synthesise' | 'transcribe') {
    return this.json<Lecture>(`/lectures/${encodeURIComponent(id)}/${action}`, 'POST', {expectedRevision: revision, consent: true, idempotencyKey: crypto.randomUUID()});
  }
  cancel(id: string) { return this.json<Lecture>(`/lectures/${encodeURIComponent(id)}/cancel`, 'POST'); }
  delete(id: string) { return this.json<{deleted: true; sharedBlobsRetained: number; notice: string}>(`/lectures/${encodeURIComponent(id)}`, 'DELETE'); }
  question(id: string, revision: number, question: string, segmentId: string, offset: number) {
    return this.json<AnswerResult>(`/lectures/${encodeURIComponent(id)}/questions`, 'POST', {expectedRevision: revision, question, segmentId, offset, consent: true});
  }
  playback(id: string, segmentId: string, offset: number, rate: number) {
    return this.json<Lecture>(`/lectures/${encodeURIComponent(id)}/playback`, 'PUT', {segmentId, offset, rate});
  }
  async audio(id: string, chunkId: string, signal?: AbortSignal): Promise<Blob> {
    return (await this.response(`/lectures/${encodeURIComponent(id)}/audio/${encodeURIComponent(chunkId)}`, {signal})).blob();
  }
  async asset(id: string, assetId: string, signal?: AbortSignal): Promise<Blob> {
    return (await this.response(`/lectures/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}`, {signal})).blob();
  }
}
