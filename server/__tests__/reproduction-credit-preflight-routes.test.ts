import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import type { Server } from "http";

const state = vi.hoisted(() => ({
  create: vi.fn(),
  run: vi.fn(),
  source: {
    id: "failed-run",
    projectId: "project",
    journalId: "mirror",
    documentId: "paper",
    paperTitle: "Paper",
    agentId: "P",
    gpu: "A10G",
    userId: "owner",
    status: "failed",
    providerMode: "byoc",
    modelProvider: "openrouter",
    modelName: "openai/gpt-4o",
    prompt1: "reproduce",
    prompt2: "judge",
  } as any,
}));

vi.mock("../db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{
    futureScienceUserId: "owner",
    email: "sacharaoult@gmail.com",
    validated: "true",
    expiresAt: new Date(Date.now() + 60_000),
  }] }) }) }) },
}));
vi.mock("../storage", () => ({
  storage: {
    getReproductionById: async () => state.source,
    getReproducedPapersForJournal: vi.fn(async () => []),
    createReproduction: (...args: any[]) => state.create(...args),
  },
}));
vi.mock("../modal-sandbox", () => ({
  isModalConfigured: () => true,
  resolveGpu: () => "A10G",
  GPU_OPTIONS: [],
  DEFAULT_GPU: "A10G",
}));
vi.mock("../ephemeral-keys", () => ({
  getEphemeralKey: () => "route-test-key",
  storeEphemeralKey: vi.fn(),
}));
vi.mock("../reproduce", () => ({
  runReproduction: (...args: any[]) => state.run(...args),
}));

const routes = new Map<string, any[]>();
beforeAll(async () => {
  const app = new Proxy({}, {
    get: (_target, method) => (path: string, ...handlers: any[]) => {
      routes.set(`${String(method)} ${path}`, handlers);
    },
  });
  const { registerRoutes } = await import("../routes");
  await registerRoutes({} as Server, app as Express);
});

async function post(path: string, body: Record<string, unknown>, id = "failed-run") {
  let status = 200;
  let responseBody: any;
  const req = {
    params: { id },
    body,
    query: {},
    cookies: { session_id: "route-test-session" },
  };
  const res = {
    status(value: number) { status = value; return this; },
    json(value: unknown) { responseBody = value; return this; },
    setHeader() {},
  };
  for (const handler of routes.get(`post ${path}`) ?? []) {
    let next = false;
    await handler(req, res, () => { next = true; });
    if (!next) break;
  }
  return { status, body: responseBody };
}

beforeEach(() => {
  state.create.mockReset();
  state.run.mockReset();
  vi.stubEnv("OPENROUTER_API_KEY", "platform-route-test-key");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
    JSON.stringify({ data: { limit_remaining: 0 } }),
    { status: 200 },
  )));
});

describe("reproduction route OpenRouter preflight", () => {
  it("blocks create before inserting a row or starting the runner", async () => {
    const result = await post("/api/reproductions", {
      documentId: "paper",
      modelProvider: "openrouter",
      modelName: "openai/gpt-4o",
      providerMode: "platform",
    });

    expect(result.status).toBe(402);
    expect(result.body.error).toMatch(/OpenRouter.*spending cap.*Replit subscription/i);
    expect(state.create).not.toHaveBeenCalled();
    expect(state.run).not.toHaveBeenCalled();
  });

  it("blocks retry before inserting a row or starting the runner", async () => {
    const result = await post("/api/reproductions/:id/retry", {});

    expect(result.status).toBe(402);
    expect(result.body.error).toMatch(/OpenRouter.*spending cap.*Replit subscription/i);
    expect(state.create).not.toHaveBeenCalled();
    expect(state.run).not.toHaveBeenCalled();
  });
});