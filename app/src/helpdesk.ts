// HTTP client for the helpdesk API (docs/api.md).
//
// - Bearer auth, JSON. The token is never logged.
// - Calls are serialized (one request in flight per client) so we never flood the API.
// - 429 -> sleep Retry-After (+ small jitter), retry the same call.
// - 5xx / network error / timeout -> exponential backoff (1 s doubling, capped), retried forever.
// - 410 -> GoneError (the change-feed cursor expired; the caller restarts the feed).
// - Other 4xx -> HttpError with `status`.
// - close() aborts the in-flight request and any pending retry wait; queued and future calls
//   reject with ClosedError. Used on shutdown so retry loops never outlive the app/tests.
import type { Logger } from './types.ts';
import { log as defaultLog } from './log.ts';

export class HttpError extends Error {
  status: number;
  path: string;
  body: string;
  constructor(status: number, path: string, body: string) {
    super(`helpdesk ${path} -> HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

/** 410 Gone: a change-feed cursor has expired. Start the feed again without a cursor. */
export class GoneError extends HttpError {
  constructor(path: string, body: string) {
    super(410, path, body);
    this.name = 'GoneError';
  }
}

export class ClosedError extends Error {
  constructor() {
    super('helpdesk client closed');
    this.name = 'ClosedError';
  }
}

export interface HelpdeskClientOptions {
  baseUrl: string;
  token: string;
  log?: Logger;
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout. Default 30 000 ms. */
  timeoutMs?: number;
  /** Injectable for tests. Default: an abortable setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Cap for 5xx/network backoff. Default 30 000 ms. */
  maxBackoffMs?: number;
  /** First 5xx/network backoff. Default 1000 ms. */
  baseBackoffMs?: number;
  /** Max random jitter added to a Retry-After wait. Default 250 ms. */
  jitterMs?: number;
}

export interface HelpdeskStats {
  calls: number; // HTTP attempts made (including retries)
  http429: number;
  retries: number; // attempts that were retried (429 + 5xx + network)
  errors5xx: number;
  networkErrors: number;
}

/** Parse Retry-After: delta seconds (fractions accepted) or an HTTP date. Returns ms. */
export function parseRetryAfter(value: string | null, nowMs = Date.now()): number {
  if (value == null || value.trim() === '') return 1000;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  return 1000;
}

export class HelpdeskClient {
  stats: HelpdeskStats;
  private baseUrl: string;
  private token: string;
  private log: Logger;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private customSleep: ((ms: number) => Promise<void>) | undefined;
  private maxBackoffMs: number;
  private baseBackoffMs: number;
  private jitterMs: number;
  private chain: Promise<unknown>;
  private closer: AbortController;

  constructor(opts: HelpdeskClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.log = opts.log ?? defaultLog;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.customSleep = opts.sleep;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.baseBackoffMs = opts.baseBackoffMs ?? 1000;
    this.jitterMs = opts.jitterMs ?? 250;
    this.chain = Promise.resolve();
    this.closer = new AbortController();
    this.stats = { calls: 0, http429: 0, retries: 0, errors5xx: 0, networkErrors: 0 };
  }

  get closed(): boolean {
    return this.closer.signal.aborted;
  }

  /** Abort in-flight work; all pending and future calls reject with ClosedError. */
  close(): void {
    if (!this.closer.signal.aborted) this.closer.abort();
  }

  /** GET `path` (e.g. '/v1/changes') with query params; resolves to the parsed JSON body. */
  get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const run = () => this.request<T>(path, params);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private buildUrl(path: string, params?: Record<string, string | number>): string {
    const qs = new URLSearchParams();
    if (params) for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
    const q = qs.toString();
    return `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}${q ? `?${q}` : ''}`;
  }

  private async wait(ms: number): Promise<void> {
    if (this.closed) throw new ClosedError();
    if (this.customSleep) {
      await this.customSleep(ms);
    } else {
      await new Promise<void>((resolve) => {
        const signal = this.closer.signal;
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', done, { once: true });
      });
    }
    if (this.closed) throw new ClosedError();
  }

  private async request<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const url = this.buildUrl(path, params);
    const shown = url.slice(this.baseUrl.length); // path + query, never the token
    let backoff = this.baseBackoffMs;
    for (;;) {
      if (this.closed) throw new ClosedError();
      this.stats.calls++;
      const started = Date.now();
      let res: Response;
      let text: string;
      try {
        const signal = AbortSignal.any([this.closer.signal, AbortSignal.timeout(this.timeoutMs)]);
        res = await this.fetchImpl(url, {
          method: 'GET',
          headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
          signal,
        });
        text = await res.text();
      } catch (err) {
        if (this.closed) throw new ClosedError();
        this.stats.networkErrors++;
        this.stats.retries++;
        this.log.warn('helpdesk network error, backing off', {
          path: shown,
          error: String((err as Error)?.message ?? err),
          backoff_ms: backoff,
        });
        await this.wait(backoff);
        backoff = Math.min(backoff * 2, this.maxBackoffMs);
        continue;
      }
      const ms = Date.now() - started;
      this.log.debug('helpdesk call', { path: shown, status: res.status, ms });

      if (res.status === 429) {
        this.stats.http429++;
        this.stats.retries++;
        const waitMs = parseRetryAfter(res.headers.get('retry-after')) + Math.floor(Math.random() * this.jitterMs);
        this.log.warn('helpdesk 429, honouring Retry-After', { path: shown, wait_ms: waitMs });
        await this.wait(waitMs);
        continue;
      }
      if (res.status >= 500) {
        this.stats.errors5xx++;
        this.stats.retries++;
        this.log.warn('helpdesk 5xx, backing off', { path: shown, status: res.status, backoff_ms: backoff });
        await this.wait(backoff);
        backoff = Math.min(backoff * 2, this.maxBackoffMs);
        continue;
      }
      if (res.status === 410) throw new GoneError(shown, text);
      if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, shown, text);
      try {
        return JSON.parse(text) as T;
      } catch {
        // A 2xx with a broken body is most likely a truncated response: treat as transient.
        this.stats.retries++;
        this.log.warn('helpdesk invalid JSON, backing off', { path: shown, backoff_ms: backoff });
        await this.wait(backoff);
        backoff = Math.min(backoff * 2, this.maxBackoffMs);
      }
    }
  }
}
