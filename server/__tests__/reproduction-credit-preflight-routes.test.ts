import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import type { Server } from "http";

const state = vi.hoisted(() => ({
  create: vi.fn(),
  run: vi.fn(),
  completion: vi.fn(),
  getSource: vi.fn(async () => state.source),
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
    getReproductionById: (...args: any[]) => state.getSource(...args),
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
vi.mock("../paper-catalogue", () => ({
  fetchJournalPaperCatalogue: async () => ({
    papers: [{ documentId: "paper", title: "Source paper" }],
  }),
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
  state.getSource.mockClear();
  state.publish.mockReset();
  state.editorialUpdates.mockClear();
  state.editorialEvents.mockClear();
  vi.stubEnv("OPENROUTER_API_KEY", "platform-route-test-key");
  for (const provider of ["OPENROUTER"]) {
    vi.stubEnv(`AI_INTEGRATIONS_${provider}_BASE_URL`, "");
    vi.stubEnv(`AI_INTEGRATIONS_${provider}_API_KEY`, "");
  }
  vi.stubEnv("LAB_ALLOWED_MODELS", undefined);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
    JSON.stringify({ data: { limit_remaining: 0 } }),
    { status: 200 },
  )));
});

describe("managed generation route guards (no provider calls)", () => {
  it.each([undefined, "qP"])("returns catalogue locks scoped to %s", async agentId => {
    const { storage } = await import("../storage");
    vi.mocked(storage.getReproducedPapersForJournal).mockResolvedValueOnce([
      { documentId: "paper", modelName: "gpt-5-mini", status: "completed" },
    ]);
    let response: any;
    await routes.get("get /api/reproductions/available-papers")![0](
      { query: { agentId } },
      { json(value: unknown) { response = value; } },
    );
    expect(storage.getReproducedPapersForJournal).toHaveBeenLastCalledWith("mirror", agentId ?? "P");
    expect(response.papers[0]).toMatchObject({
      lockedModels: ["gpt-5-mini"], reproducedModels: ["gpt-5-mini"],
    });
  });

  it.each([undefined, "qP"])("returns persona-specific default prompts for %s", async agentId => {
    const { getReproducerPrompt, getJudgePrompt } = await import("../prompts/reproduce");
    let response: any;
    await routes.get("get /api/reproductions/default-prompts")![0](
      { query: { agentId } }, { json(value: unknown) { response = value; } },
    );
    const persona = agentId === "qP" ? "qP" : "P";
    expect(response).toEqual({ reproducerPrompt: getReproducerPrompt(persona), judgePrompt: getJudgePrompt(persona) });
  });

  it.each([undefined, "P", "qP"])("selects persisted defaults for persona %s", async agentId => {
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_BASE_URL", "https://managed.example.test");
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_API_KEY", "test-only");
    state.create.mockResolvedValue(null);
    const result = await post("/api/reproductions", {
      documentId: "paper", agentId, modelProvider: "openai", modelName: "openai/gpt-5-mini",
      judgeModelName: "openai/gpt-5-mini",
    });
    expect(result.status).toBe(409);
    const { getReproducerPrompt, getJudgePrompt } = await import("../prompts/reproduce");
    const persona = agentId === "qP" ? "qP" : "P";
    expect(state.create).toHaveBeenCalledWith(expect.objectContaining({
      agentId: persona, prompt1: getReproducerPrompt(persona), prompt2: getJudgePrompt(persona),
      orchestratorName: expect.stringContaining(`${persona}-N1`),
    }));
    const { storage } = await import("../storage");
    expect(storage.getReproducedPapersForJournal).toHaveBeenCalledWith("mirror", persona);
  });

  it.each([null, "", "qp", "invalid", 1, ["P"]])("rejects invalid persona %j before insert", async agentId => {
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_BASE_URL", "https://managed.example.test");
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_API_KEY", "test-only");
    const result = await post("/api/reproductions", {
      documentId: "paper", agentId, modelProvider: "openai", modelName: "openai/gpt-5-mini",
      judgeModelName: "openai/gpt-5-mini",
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain("agentId");
    expect(state.create).not.toHaveBeenCalled();
  });

  it("retries qP with its saved persona and prompts despite request overrides", async () => {
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_BASE_URL", "https://managed.example.test");
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_API_KEY", "test-only");
    state.create.mockResolvedValue(null);
    state.source.agentId = "qP";
    try {
      const result = await post("/api/reproductions/:id/retry", {
        agentId: "P", reproducerPrompt: "replacement", judgePrompt: "replacement",
        modelProvider: "openai", modelName: "openai/gpt-5-mini", judgeModelName: "openai/gpt-5-mini",
      });
      expect(result.status).toBe(409);
      expect(state.create).toHaveBeenCalledWith(expect.objectContaining({
        agentId: "qP", prompt1: state.source.prompt1, prompt2: state.source.prompt2,
      }));
    } finally {
      state.source.agentId = "P";
    }
  });

  it.each(["/api/reproductions/default-prompts", "/api/reproductions/available-papers"])(
    "rejects invalid catalogue/prompt persona on %s", async path => {
      let status = 200;
      const res = { status(value: number) { status = value; return this; }, json: vi.fn() };
      await routes.get(`get ${path}`)![0]({ query: { agentId: "bad" } }, res);
      expect(status).toBe(400);
    },
  );

  it.each(["length", "content_filter", "refusal"])(
    "does not complete or publish a background editorial after incomplete OpenAI output (%s)", async reason => {
      vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_BASE_URL", "https://managed.example.test");
      vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_API_KEY", "synthetic");
      state.completion.mockResolvedValue({ choices: [{
        finish_reason: reason === "refusal" ? "stop" : reason,
        message: { content: "UNACCEPTED_PARTIAL_EDITORIAL", ...(reason === "refusal" ? { refusal: "refused" } : {}) },
      }] });
      const result = await post("/api/editorials/generate", { modelProvider: "openai", modelName: "openai/gpt-4o", providerMode: "platform" });
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
      [{ modelProvider: "openai", modelName: "openai/gpt-5-mini", judgeModelName: "openai/gpt-5-mini" }, 503],
    ])(`blocks ${path} before work: %j`, async (body, status) => {
      const result = await post(path, body as Record<string, unknown>);
      expect(result.status).toBe(status);
      expect(state.create).not.toHaveBeenCalled();
      expect(state.run).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });
  }

  it("requires an explicit supported judge replacement for a legacy retry", async () => {
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_BASE_URL", "https://managed.example.test");
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_API_KEY", "test-only");
    const original = { ...state.source };
    const result = await post("/api/reproductions/:id/retry", {
      providerMode: "platform", modelProvider: "openai", modelName: "openai/gpt-5-mini",
    });
    expect(result.status).toBe(400);
    expect(state.source).toEqual(original);
    expect(state.create).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validates key syntax without making a paid call", async () => {
    const result = await post("/api/generation/validate-key", {
      provider: "openrouter", apiKey: "sk-or-v1-test-key-123456789",
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ valid: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("copies prompts and derives the replacement judge provider without changing history", async () => {
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_BASE_URL", "https://managed.example.test");
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_API_KEY", "test-only");
    const original = { ...state.source };
    // Simulate a reservation conflict, capturing the attempted insert without
    // launching a background runner or requiring network access.
    state.create.mockResolvedValue(null);
    const result = await post("/api/reproductions/:id/retry", {
      providerMode: "platform", modelProvider: "openai", modelName: "openai/gpt-5-mini",
      judgeModelProvider: "openrouter", judgeModelName: "google/gemini-2.5-flash",
    });
    expect(result.status).toBe(409);
    expect(state.create).toHaveBeenCalledWith(expect.objectContaining({
      modelProvider: "openai", modelName: "openai/gpt-5-mini", providerMode: "platform",
      judgeModelProvider: "google", judgeModelName: "google/gemini-2.5-flash",
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
      expect((await post("/api/reproductions/:id/retry", {
        providerMode: "byok", modelProvider: "openai", modelName: "gpt-4o",
        byocApiKey: "sk-project-ephemeral-key-123456",
        judgeProviderMode: "byok", judgeModelName: "gpt-4o",
      })).status).toBe(403);
      expect(state.create).not.toHaveBeenCalled();
    } finally {
      state.source.userId = owner;
    }
  });

  it("advertises managed models and supported BYOC providers", async () => {
    let config: any;
    await routes.get("get /api/generation/config")![0]({}, { json: (value: unknown) => { config = value; } });
    expect(config.byocProviders.map((provider: any) => provider.id)).toEqual(["openai", "anthropic", "openrouter"]);
    expect(config.defaultModel).toBeNull();
    expect(config.platformModels.length).toBeGreaterThan(0);
    expect(config.platformModels.every((model: any) => !model.enabled && model.unavailableReason)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses a supplied BYOK key for reproduction without persisting it or consulting Replit billing", async () => {
    const key = "sk-project-ephemeral-key-123456";
    state.create.mockResolvedValue(null);
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_BASE_URL", "");
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_API_KEY", "");
    const result = await post("/api/reproductions", {
      documentId: "paper",
      providerMode: "byok",
      modelProvider: "openai",
      modelName: "gpt-4o",
      byocApiKey: key,
      judgeProviderMode: "byok",
      judgeModelName: "gpt-4o",
    });
    expect(result.status).toBe(409);
    expect(state.create).toHaveBeenCalledWith(expect.objectContaining({
      modelProvider: "openai", modelName: "gpt-4o", providerMode: "byoc",
    }));
    expect(JSON.stringify(state.create.mock.calls)).not.toContain(key);
    expect(state.run).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires a separate ephemeral judge key when its BYOK provider differs", async () => {
    const result = await post("/api/reproductions", {
      documentId: "paper",
      providerMode: "byoc",
      modelProvider: "openai",
      modelName: "gpt-4o",
      byocApiKey: "sk-project-ephemeral-key-123456",
      judgeProviderMode: "byok",
      judgeModelProvider: "anthropic",
      judgeModelName: "claude-sonnet-4-20250514",
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/API key/i);
    expect(state.create).not.toHaveBeenCalled();
    expect(state.run).not.toHaveBeenCalled();
  });

  it("rejects invalid BYOK credentials before reading the saved reproduction", async () => {
    const result = await post("/api/reproductions/:id/retry", {
      providerMode: "byok",
      modelProvider: "openai",
      modelName: "gpt-4o",
      byocApiKey: "not-a-valid-key",
      judgeProviderMode: "byok",
      judgeModelName: "gpt-4o",
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/API key/i);
    expect(state.getSource).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });
});