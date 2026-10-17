// Small HTTP layer shared by the synthesis source clients: per-client rate
// limiting, timeouts, and retries on 429 / 5xx / network errors.
// Dependencies are injectable so tests run offline with no real waiting.

import { SourceFetchError, type SourceName } from "./types";

export interface HttpDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const defaultHttpDeps: HttpDeps = {
  fetch: (input, init) => globalThis.fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export function resolveDeps(deps?: Partial<HttpDeps>): HttpDeps {
  return { ...defaultHttpDeps, ...deps };
}

// Spaces requests at least `minIntervalMs` apart. The slot is reserved
// synchronously, so concurrent callers queue up instead of bursting.
export class RateLimiter {
  private nextAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  async wait(deps: HttpDeps): Promise<void> {
    const now = deps.now();
    const slot = Math.max(now, this.nextAt);
    this.nextAt = slot + this.minIntervalMs;
    if (slot > now) await deps.sleep(slot - now);
  }
}

export interface RequestOptions {
  source: SourceName;
  limiter: RateLimiter;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxRetries?: number;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 30_000;

function backoffMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
}

async function request(url: string, opts: RequestOptions, deps: HttpDeps): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;
  const headers: Record<string, string> = { ...opts.headers };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  for (let attempt = 0; ; attempt++) {
    await opts.limiter.wait(deps);
    let resp: Response;
    try {
      resp = await deps.fetch(url, {
        method: opts.method ?? "GET",
        headers,
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      });
    } catch (err) {
      if (attempt < maxRetries) {
        await deps.sleep(backoffMs(attempt, null));
        continue;
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new SourceFetchError(`${opts.source} request failed: ${reason}`, opts.source, url);
    }
    if (resp.ok) return resp;
    if (RETRYABLE_STATUSES.has(resp.status) && attempt < maxRetries) {
      await deps.sleep(backoffMs(attempt, resp.headers?.get?.("retry-after") ?? null));
      continue;
    }
    throw new SourceFetchError(`${opts.source} returned HTTP ${resp.status}`, opts.source, url, resp.status);
  }
}

export async function requestJson(url: string, opts: RequestOptions, deps: HttpDeps): Promise<unknown> {
  const resp = await request(url, opts, deps);
  try {
    return await resp.json();
  } catch {
    throw new SourceFetchError(`${opts.source} returned invalid JSON`, opts.source, url, resp.status);
  }
}

export async function requestText(url: string, opts: RequestOptions, deps: HttpDeps): Promise<string> {
  const resp = await request(url, opts, deps);
  return resp.text();
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
