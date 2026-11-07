export type ProviderName = 'openai' | 'elevenlabs';
export type ProviderOperation = 'compile' | 'audit' | 'tts' | 'stt';
export interface RequestEvent {
  phase: 'before' | 'after';
  provider: ProviderName;
  operation: ProviderOperation;
  attempt: number;
  at: string;
  durationMs?: number;
  status?: number;
  requestId?: string;
  outcome?: 'success' | 'rejected' | 'unknown';
}
export interface ResponseEvent {
  provider: ProviderName;
  operation: ProviderOperation;
  attempt: number;
  at: string;
  durationMs: number;
  status: number;
  requestId?: string;
  response: unknown;
}

const SAFE_MESSAGES: Record<string, string> = {
  NOT_CONFIGURED: 'This live provider is unavailable. Configure the required server-side key and, for speech, a stock voice.',
  AUTHENTICATION: 'Provider rejected authentication. Check the configured replacement key and its permissions.',
  CREDIT: 'Provider credit or quota is unavailable. No automatic retry was made.',
  RATE_LIMIT: 'Provider rate limit rejected the request. The single allowed rejection retry is exhausted.',
  SERVER_REJECTED: 'Provider explicitly rejected the request after the single allowed retry.',
  OUTCOME_UNKNOWN: 'Provider outcome unknown; retry may incur another charge. No automatic retry was made.',
  TIMEOUT: 'Provider request timed out; outcome unknown and retry may incur another charge. No automatic retry was made.',
  CANCELLED: 'Request cancelled locally. A submitted provider request may still have been billed.',
  INVALID_RESPONSE: 'Provider returned an unusable response. No automatic repeat was made.',
  INVALID_COMPILATION: 'Provider output failed source, schema, or revision checks and cannot be narrated.',
  INVALID_AUDIT: 'Provider audit was malformed or did not cover the supplied sources and cannot approve narration.',
  AUDIT_REJECTED: 'Semantic audit found critical source-grounding or omission errors. Narration is blocked.',
  INVALID_INPUT: 'The selected source bundle is invalid or unsupported for this bounded provider adapter.',
  BUDGET_EXHAUSTED: 'The durable live-provider request budget is exhausted. No request was sent.',
  LOCAL_VOICE_UNAVAILABLE: 'Explicit offline mock speech is unavailable because the native local voice could not run.',
};

/** Deliberately contains no provider body, source text, request headers, or keys. */
export class ProviderError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly unknownOutcome: boolean;
  readonly provider?: ProviderName;
  constructor(code: string, options: { status?: number; unknownOutcome?: boolean; provider?: ProviderName } = {}) {
    super(SAFE_MESSAGES[code] ?? 'Provider operation failed safely. Check the redacted verification report.');
    this.name = 'ProviderError';
    this.code = code;
    this.status = options.status;
    this.unknownOutcome = options.unknownOutcome ?? false;
    this.provider = options.provider;
  }
  toJSON() { return { code: this.code, message: this.message, status: this.status, unknownOutcome: this.unknownOutcome, provider: this.provider }; }
}

export interface HttpOptions {
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
  onRequest?: (event: RequestEvent) => Promise<void> | void;
  onResponse?: (event: ResponseEvent) => Promise<void> | void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new ProviderError('INVALID_RESPONSE');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new ProviderError('INVALID_RESPONSE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(joined);
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function rejection(status: number, body: unknown): { code: string; retry: boolean; unknown: boolean } {
  const root = isObject(body) ? body : {};
  const detail = isObject(root.error) ? root.error : isObject(root.detail) ? root.detail : root;
  const tag = [detail.code, detail.type, detail.status].filter(v => typeof v === 'string').join(' ').toLowerCase();
  if (/insufficient_quota|quota_exceeded|insufficient_credits?|credit_balance|payment_required|subscription_required|paid_plan_required/.test(tag) || status === 402)
    return { code: 'CREDIT', retry: false, unknown: false };
  if (status === 401 || status === 403) return { code: 'AUTHENTICATION', retry: false, unknown: false };
  if (status === 429) return { code: 'RATE_LIMIT', retry: true, unknown: false };
  if (status >= 500) {
    // A gateway timeout/HTML/empty response is NOT evidence that submission failed.
    // Only an explicit, structured provider rejection without a result identifier is retried.
    const explicit = /server_error|server_overloaded|overloaded|service_unavailable/.test(tag)
      && !root.id && !root.output && status !== 504;
    return { code: explicit ? 'SERVER_REJECTED' : 'OUTCOME_UNKNOWN', retry: explicit, unknown: !explicit };
  }
  return { code: 'SERVER_REJECTED', retry: false, unknown: false };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ProviderError('CANCELLED')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new ProviderError('CANCELLED')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class ProviderHttp {
  constructor(private readonly options: HttpOptions) {}

  async json(provider: ProviderName, operation: ProviderOperation, url: string, init: Omit<RequestInit, 'signal'>, signal?: AbortSignal, maxBytes = 4 * 1024 * 1024): Promise<{ body: unknown; durationMs: number; requestId?: string; attempts: number }> {
    // Destination is fixed in production. Redirects must never carry either provider key elsewhere.
    const parsed = new URL(url);
    const allowed = provider === 'openai' ? 'api.openai.com' : 'api.elevenlabs.io';
    if (parsed.protocol !== 'https:' || parsed.hostname !== allowed || parsed.port || parsed.username || parsed.password)
      throw new ProviderError('INVALID_INPUT', { provider });
    let totalDuration = 0;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (signal?.aborted) throw new ProviderError('CANCELLED', { provider });
      // A durable budget hook MUST finish before submission; failures send no request.
      await this.options.onRequest?.({ phase: 'before', provider, operation, attempt, at: new Date().toISOString() });
      if (signal?.aborted) {
        await this.options.onRequest?.({ phase: 'after', provider, operation, attempt, at: new Date().toISOString(), durationMs: 0, outcome: 'rejected' });
        throw new ProviderError('CANCELLED', { provider });
      }
      const start = performance.now();
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.options.timeoutMs);
      let response: Response;
      let body: unknown;
      let requestId: string | undefined;
      try {
        response = await this.options.fetch(url, { ...init, redirect: 'error', signal: controller.signal });
        requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined;
        const text = await boundedText(response, response.ok ? maxBytes : 64 * 1024);
        try { body = JSON.parse(text); } catch { body = undefined; }
        const durationMs = Math.round(performance.now() - start);
        totalDuration += durationMs;
        if (response.ok && body === undefined) throw new ProviderError('INVALID_RESPONSE', { provider, status: response.status });
        await this.options.onResponse?.({ provider, operation, attempt, at: new Date().toISOString(), durationMs, status: response.status, requestId, response: body ?? { nonJsonBodyWithheld: true } });
      } catch (error) {
        const durationMs = Math.round(performance.now() - start);
        const knownResponse = error instanceof ProviderError && error.code === 'INVALID_RESPONSE';
        await this.options.onRequest?.({ phase: 'after', provider, operation, attempt, at: new Date().toISOString(), durationMs, requestId, outcome: knownResponse ? 'rejected' : 'unknown' });
        if (knownResponse) throw error;
        throw new ProviderError(timedOut ? 'TIMEOUT' : signal?.aborted ? 'CANCELLED' : 'OUTCOME_UNKNOWN', { provider, unknownOutcome: true });
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      }
      const verdict = response.ok ? undefined : rejection(response.status, body);
      await this.options.onRequest?.({ phase: 'after', provider, operation, attempt, at: new Date().toISOString(), durationMs: Math.round(performance.now() - start), status: response.status, requestId, outcome: response.ok ? 'success' : verdict!.unknown ? 'unknown' : 'rejected' });
      if (response.ok) return { body, durationMs: totalDuration, requestId, attempts: attempt };
      if (verdict!.retry && attempt === 1) {
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : 0.5;
        // A very long rate-limit delay is actionable, not a reason to hold a local job indefinitely.
        if (seconds > 10) throw new ProviderError(verdict!.code, { provider, status: response.status });
        await (this.options.sleep ?? abortableSleep)(Math.max(0, seconds * 1000), signal);
        continue;
      }
      throw new ProviderError(verdict!.code, { provider, status: response.status, unknownOutcome: verdict!.unknown });
    }
    throw new ProviderError('SERVER_REJECTED', { provider });
  }
}
