// Offline HTTP double for the synthesis source clients: routes requests to a
// handler, records every call, and replaces waiting with a virtual clock.

import type { HttpDeps } from "../../../synthesis/sources/http";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type FakeReply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> } | Error;

export function createFakeHttp(handler: (call: RecordedCall, index: number) => FakeReply) {
  const calls: RecordedCall[] = [];
  const sleeps: number[] = [];
  let clock = 0;

  const deps: HttpDeps = {
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: (init?.method ?? "GET").toUpperCase(),
        headers: { ...(init?.headers as Record<string, string> | undefined) },
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const reply = handler(call, calls.length - 1);
      if (reply instanceof Error) throw reply;
      const body = reply.text ?? JSON.stringify(reply.json ?? {});
      return new Response(body, { status: reply.status ?? 200, headers: reply.headers });
    }) as typeof fetch,
  };

  return { deps, calls, sleeps, params: (i: number) => new URL(calls[i].url).searchParams };
}
