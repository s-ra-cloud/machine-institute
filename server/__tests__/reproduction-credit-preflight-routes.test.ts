import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import type { Server } from "http";

const state = vi.hoisted(() => ({
  create: vi.fn(),
  run: vi.fn(),
  completion: vi.fn(),
  publish: vi.fn(),
  editorialUpdates: vi.fn(async (..._args: any[]) => {}),
  editorialEvents: vi.fn(async (..._args: any[]) => {}),
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
vi.mock("openai", () => ({ default: class { chat = { completions: { create: (...args: any[]) => state.completion(...args) } }; } }));
vi.mock("../future-science", async importOriginal => ({
  ...await importOriginal<typeof import("../future-science")>(),
  fetchAbstractsAndKeywords: async () => ({ abstracts: [], keywords: [] }),
  publishToFutureScience: (...args: any[]) => state.publish(...args),
}));

vi.mock("../db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{
    futureScienceUserId: "owner",
    email: "sacharaoult@gmail.com",
    validated: "true",
    accessToken: "synthetic-route-test-token",
    expiresAt: new Date(Date.now() + 60_000),
  }] }) }) }) },
}));
vi.mock("../storage", () => ({
  storage: {
    getReproductionById: async () => state.source,
    getReproducedPapersForJournal: vi.fn(async () => []),
    createReproduction: (...args: any[]) => state.create(...args),
    createEditorial: async (data: any) => ({ ...data, id: "editorial-test", status: "pending" }),
    getEditorialById: async () => ({ id: "editorial-test", agentId: "G4O" }),
    updateEditorial: (...args: any[]) => state.editorialUpdates(...args),
    createResearchEvent: (...args: any[]) => state.editorialEvents(...args),
    getAllProjectPapers: async () => [{ title: "Scientific methods", authors: "Fixture author", date: "2026", description: "A test-only source abstract." }],
    getAllLiteratureReviews: async () => [],
    getAllEditorials: async () => [],
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
  state.completion.mockReset();
  state.publish.mockReset();
  state.editorialUpdates.mockClear();
  state.editorialEvents.mockClear();
  vi.stubEnv("OPENROUTER_API_KEY", "platform-route-test-key");
  for (const provider of ["OPENAI", "ANTHROPIC", "GEMINI"]) {
    vi.stubEnv(`AI_INTEGRATIONS_${provider}_BASE_URL`, "");
    vi.stubEnv(`AI_INTEGRATIONS_${provider}_API_KEY`, "");
    vi.stubEnv(`AI_INTEGRATIONS_${provider}_MODELS`, "");
  }
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
    JSON.stringify({ data: { limit_remaining: 0 } }),
    { status: 200 },
  )));
});

describe("managed generation route guards (no provider calls)", () => {
  it.each(["length", "content_filter", "refusal"])(
    "does not complete or publish a background editorial after incomplete OpenAI output (%s)", async reason => {
      vi.stubEnv("AI_INTEGRATIONS_OPENAI_BASE_URL", "https://managed.example.test");
      vi.stubEnv("AI_INTEGRATIONS_OPENAI_API_KEY", "synthetic");
      vi.stubEnv("AI_INTEGRATIONS_OPENAI_MODELS", "gpt-4o");
      state.completion.mockResolvedValue({ choices: [{
        finish_reason: reason === "refusal" ? "stop" : reason,
        message: { content: "UNACCEPTED_PARTIAL_EDITORIAL", ...(reason === "refusal" ? { refusal: "refused" } : {}) },
      }] });
      const result = await post("/api/editorials/generate", { modelProvider: "openai", modelName: "gpt-4o", providerMode: "platform" });
      expect(result.status).toBe(201);
      await vi.waitFor(() => expect(state.editorialUpdates).toHaveBeenCalledWith("editorial-test", expect.objectContaining({ status: "failed" })));
      expect(state.completion).toHaveBeenCalledTimes(1);
      expect(state.editorialUpdates.mock.calls.some(([, data]: any[]) => data.status === "completed")).toBe(false);
      expect(state.editorialEvents.mock.calls.some(([data]: any[]) => data.phase === "completed")).toBe(false);
      expect(JSON.stringify(state.editorialUpdates.mock.calls)).not.toContain("UNACCEPTED_PARTIAL_EDITORIAL");
      expect(state.publish).not.toHaveBeenCalled();
    },
  );
  it("blocks create before inserting a row or starting the runner", async () => {
    const result = await post("/api/reproductions", {
      documentId: "paper",
      modelProvider: "openrouter",
      modelName: "openai/gpt-4o",
      providerMode: "platform",
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/supported Replit-managed model/i);
    expect(state.create).not.toHaveBeenCalled();
    expect(state.run).not.toHaveBeenCalled();
  });

  it("blocks retry before inserting a row or starting the runner", async () => {
    const result = await post("/api/reproductions/:id/retry", {});

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/supported Replit-managed model/i);
    expect(state.create).not.toHaveBeenCalled();
    expect(state.run).not.toHaveBeenCalled();
  });

  for (const path of [
    "/api/literature-reviews", "/api/editorials/generate", "/api/ethics-reports",
    "/api/peer-reviews", "/api/peer-reviews/batch", "/api/reproductions",
  ]) {
    it.each([
      [{}, 400],
      [{ providerMode: "byoc", modelProvider: "openai", modelName: "gpt-5-mini" }, 400],
      [{ modelProvider: "openrouter", modelName: "openai/gpt-4o" }, 400],
      [{ modelProvider: "openai", modelName: "gpt-5-mini", judgeModelName: "gpt-5-mini" }, 503],
    ])(`blocks ${path} before work: %j`, async (body, status) => {
      const result = await post(path, body as Record<string, unknown>);
      expect(result.status).toBe(status);
      expect(state.create).not.toHaveBeenCalled();
      expect(state.run).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });
  }

  it("requires an explicit supported judge replacement for a legacy retry", async () => {
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_BASE_URL", "https://managed.example.test");
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_API_KEY", "test-only");
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_MODELS", "gpt-5-mini");
    const original = { ...state.source };
    const result = await post("/api/reproductions/:id/retry", {
      providerMode: "platform", modelProvider: "openai", modelName: "gpt-5-mini",
    });
    expect(result.status).toBe(400);
    expect(state.source).toEqual(original);
    expect(state.create).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retires key validation without making a paid call", async () => {
    expect((await post("/api/generation/validate-key", { provider: "openrouter", apiKey: "test" })).status).toBe(410);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("copies prompts and derives the replacement judge provider without changing history", async () => {
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_BASE_URL", "https://managed.example.test");
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_API_KEY", "test-only");
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_MODELS", "gpt-5-mini");
    vi.stubEnv("AI_INTEGRATIONS_GEMINI_BASE_URL", "https://managed.example.test");
    vi.stubEnv("AI_INTEGRATIONS_GEMINI_API_KEY", "test-only");
    vi.stubEnv("AI_INTEGRATIONS_GEMINI_MODELS", "gemini-2.5-flash");
    const original = { ...state.source };
    // Simulate a reservation conflict, capturing the attempted insert without
    // launching a background runner or requiring network access.
    state.create.mockResolvedValue(null);
    const result = await post("/api/reproductions/:id/retry", {
      providerMode: "platform", modelProvider: "openai", modelName: "gpt-5-mini",
      judgeModelProvider: "openrouter", judgeModelName: "gemini-2.5-flash",
    });
    expect(result.status).toBe(409);
    expect(state.create).toHaveBeenCalledWith(expect.objectContaining({
      modelProvider: "openai", modelName: "gpt-5-mini", providerMode: "platform",
      judgeModelProvider: "google", judgeModelName: "gemini-2.5-flash",
      prompt1: original.prompt1, prompt2: original.prompt2, userId: original.userId,
    }));
    expect(state.source).toEqual(original);
    expect(state.run).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains retry ownership authorization", async () => {
    const owner = state.source.userId;
    state.source.userId = "someone-else";
    try {
      expect((await post("/api/reproductions/:id/retry", {})).status).toBe(403);
      expect(state.create).not.toHaveBeenCalled();
    } finally {
      state.source.userId = owner;
    }
  });

  it("advertises unavailable managed models and no default or BYOC providers", async () => {
    let config: any;
    await routes.get("get /api/generation/config")![0]({}, { json: (value: unknown) => { config = value; } });
    expect(config.byocProviders).toEqual([]);
    expect(config.defaultModel).toBeNull();
    expect(config.platformModels.length).toBeGreaterThan(0);
    expect(config.platformModels.every((model: any) => !model.enabled && model.unavailableReason)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});