import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Express } from "express";
import type { Server } from "http";
import {
  attachReproductionFailureDiagnostics,
  ReproductionDiagnostics,
} from "../reproduction-diagnostics";

const state = vi.hoisted(() => ({
  runs: new Map<string, any>(),
  diagnostics: new Map<string, string>(),
  operations: [] as string[],
  events: [] as any[],
  session: undefined as any,
  saveFails: false,
  completeFails: false,
  run: vi.fn(),
}));
vi.mock("../db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => state.session ? [state.session] : [] }) }) }) },
}));
vi.mock("../storage", () => ({
  storage: {
    getReproductionById: async (id: string) => state.runs.get(id),
    getAllReproductions: async () => [...state.runs.values()],
    getReproductionsByProject: async () => [...state.runs.values()],
    createReproduction: async (data: any) => {
      if ([...state.runs.values()].some(r => ["pending", "generating"].includes(r.status))) return null;
      const row = { ...data, id: "retry", status: "pending" };
      state.runs.set(row.id, row);
      return row;
    },
    updateReproduction: async (id: string, updates: any) => {
      state.operations.push(`status:${updates.status}`);
      if (updates.status === "completed" && state.completeFails) throw new Error("PRIVATE_COMPLETION_STORAGE_ERROR");
      Object.assign(state.runs.get(id), updates);
      return state.runs.get(id);
    },
    saveReproductionFailureDiagnostics: async (id: string, value: string) => {
      state.operations.push("save-diagnostics");
      if (state.saveFails) throw new Error("private storage error");
      state.diagnostics.set(id, value);
    },
    getReproductionFailureDiagnostics: async (id: string) => {
      const diagnosticsJson = state.diagnostics.get(id);
      return diagnosticsJson ? { reproductionId: id, diagnosticsJson } : undefined;
    },
    createResearchEvent: async (event: any) => { state.events.push(event); },
  },
}));
vi.mock("../reproduce", () => ({ runReproduction: (...args: any[]) => state.run(...args) }));
vi.mock("../modal-sandbox", () => ({
  isModalConfigured: () => true, resolveGpu: () => "A10G", GPU_OPTIONS: [], DEFAULT_GPU: "A10G",
}));
vi.mock("../ephemeral-keys", () => ({ getEphemeralKey: () => "test-only-key", storeEphemeralKey: vi.fn() }));

// Exercise real route handlers AND real adminAuth, without starting an app,
// contacting a provider, or provisioning a sandbox.
const routes = new Map<string, any[]>();
beforeAll(async () => {
  const app = new Proxy({}, {
    get: (_target, method) => (route: string, ...handlers: any[]) => routes.set(`${String(method)} ${route}`, handlers),
  });
  const { registerRoutes } = await import("../routes");
  await registerRoutes({} as Server, app as Express);
});

async function request(method: string, path: string, authenticated = false, query = {}) {
  let status = 200;
  let body: any;
  const headers: Record<string, string> = {};
  const req = {
    params: { id: "failed" }, query, body: {},
    cookies: authenticated ? { session_id: "test-session" } : {},
  };
  const res = {
    status(value: number) { status = value; return this; },
    json(value: any) { body = value; return this; },
    setHeader(key: string, value: string) { headers[key] = value; },
  };
  for (const handler of routes.get(`${method} ${path}`) ?? []) {
    let next = false;
    await handler(req, res, () => { next = true; });
    if (!next) break;
  }
  return { status, body, headers };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(
    JSON.stringify({ data: { limit_remaining: 1 } }),
    { status: 200 },
  )));
  state.runs.clear();
  state.diagnostics.clear();
  state.operations.length = 0;
  state.events.length = 0;
  state.saveFails = false;
  state.completeFails = false;
  state.run.mockReset().mockRejectedValue(new Error("RAW_PROVIDER_SECRET"));
  state.session = {
    futureScienceUserId: "owner", email: "sacharaoult@gmail.com",
    validated: "true", expiresAt: new Date(Date.now() + 60_000),
  };
  state.runs.set("failed", {
    id: "failed", projectId: "project", documentId: "paper", journalId: "mirror",
    status: "failed", agentId: "P", gpu: "A10G", userId: "owner",
    providerMode: "byoc", modelProvider: "openrouter", modelName: "test-model",
    prompt1: "PRIVATE_PROMPT", prompt2: "PRIVATE_JUDGE",
    promptTrace: "PRIVATE_TRACE", sourceTrace: "PRIVATE_SOURCE",
    sandboxId: "PRIVATE_SANDBOX", contentHtml: "RAW_PROVIDER_SECRET",
    contentMarkdown: "STALE_REPORT", reportTitle: "STALE_TITLE", reportAbstract: "STALE_ABSTRACT",
    logbookMarkdown: "PRIVATE_LOGBOOK", verdictsJson: "STALE_VERDICTS",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("reproduction diagnostic privacy and persistence", () => {
  it("suppresses only diagnostic response bodies in the general HTTP log", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const guard = source.match(/if \(!((?:\/\^).*?)\.test\(path\)\) capturedJsonResponse = bodyJson;/);
    expect(guard).not.toBeNull();
    const literal = guard![1];
    const excluded = new RegExp(literal.slice(1, -1));
    for (const path of ["/api/reproductions/run/diagnostics", "/api/reproductions/run/diagnostics/"]) {
      expect(excluded.test(path)).toBe(true);
    }
    for (const path of ["/api/reproductions", "/api/reproductions/run", "/api/peer-reviews/run", "/api/reproductions/run/diagnostics/other"]) {
      expect(excluded.test(path)).toBe(false);
    }
    expect(source).toContain("return originalResJson.apply(res, [bodyJson, ...args]);");
  });

  it("strips private prompts, traces and legacy raw failures from list and detail for every viewer", async () => {
    for (const authenticated of [false, true]) {
      for (const [path, query] of [
        ["/api/reproductions", {}], ["/api/reproductions", { projectId: "project" }],
        ["/api/reproductions/:id", {}],
      ] as const) {
        const result = await request("get", path, authenticated, query);
        const json = JSON.stringify(result.body);
        expect(result.status).toBe(200);
        expect(json).not.toMatch(/PRIVATE_|RAW_PROVIDER|STALE_/);
        expect(json).not.toMatch(/promptTrace|sourceTrace|prompt1|prompt2|diagnosticsJson/);
        expect(result.headers["Cache-Control"]).toBe("no-store");
      }
    }
  });

  it("also strips traces from completed public reports without hiding the scientific report", async () => {
    Object.assign(state.runs.get("failed"), { status: "completed", contentHtml: "<p>Scientific report</p>" });
    const { body } = await request("get", "/api/reproductions/:id");
    expect(body.contentHtml).toContain("Scientific report");
    for (const field of ["prompt1", "prompt2", "promptTrace", "sourceTrace", "sandboxId"]) {
      expect(body).not.toHaveProperty(field);
    }
  });

  it("requires admin authorization, not just run ownership, to retrieve snapshots", async () => {
    state.diagnostics.set("failed", JSON.stringify({ stage: "tool-loop", stopReason: "no-progress" }));
    expect((await request("get", "/api/reproductions/:id/diagnostics")).status).toBe(401);
    state.session.email = "jevans@uchicago.edu";
    expect((await request("get", "/api/reproductions/:id/diagnostics", true)).status).toBe(403);
    state.session.email = "sacharaoult@gmail.com";
    const admin = await request("get", "/api/reproductions/:id/diagnostics", true);
    expect(admin.status).toBe(200);
    expect(admin.body.diagnostics.stopReason).toBe("no-progress");
    expect(admin.headers["Cache-Control"]).toBe("no-store");
    state.diagnostics.clear();
    expect((await request("get", "/api/reproductions/:id/diagnostics", true)).body).toEqual({ diagnostics: null });
    state.runs.clear();
    expect((await request("get", "/api/reproductions/:id/diagnostics", true)).status).toBe(404);
  });

  it("refuses failed republishing even when stale report content is present", async () => {
    const result = await request("post", "/api/reproductions/:id/republish", true);
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/not completed/);
  });

  it("persists an attached snapshot only after marking failed and never publishes raw exceptions", async () => {
    const error = new Error("RAW_PROVIDER_SECRET");
    const diagnostic = new ReproductionDiagnostics();
    diagnostic.stage("tool-loop");
    diagnostic.stop("no-progress");
    attachReproductionFailureDiagnostics(error, diagnostic);
    state.run.mockRejectedValue(error);
    const retry = await request("post", "/api/reproductions/:id/retry", true);
    expect(retry.status).toBe(201);
    expect(JSON.stringify(retry.body)).not.toContain("PRIVATE_");
    await vi.waitFor(() => expect(state.diagnostics.has("retry")).toBe(true));
    expect(state.operations).toEqual(["status:generating", "status:failed", "save-diagnostics"]);
    expect(JSON.parse(state.diagnostics.get("retry")!).stopReason).toBe("no-progress");
    expect(JSON.stringify(state.events)).not.toMatch(/RAW_PROVIDER_SECRET|PRIVATE_/);
    expect(state.runs.get("retry").completedAt).toBeInstanceOf(Date);
    expect(state.runs.get("failed").prompt1).toBe("PRIVATE_PROMPT");
  });

  it("keeps a run failed and retryable if diagnostic persistence fails", async () => {
    state.saveFails = true;
    expect((await request("post", "/api/reproductions/:id/retry", true)).status).toBe(201);
    await vi.waitFor(() => expect(state.operations).toContain("save-diagnostics"));
    expect(state.runs.get("retry").status).toBe("failed");
    expect(state.diagnostics.size).toBe(0);
    expect((await request("post", "/api/reproductions/:id/retry", true)).status).toBe(201);
    await vi.waitFor(() => expect(state.operations.filter(x => x === "save-diagnostics")).toHaveLength(2));
  });

  it("saves a bounded fallback when an early failure has no attached diagnostic", async () => {
    await request("post", "/api/reproductions/:id/retry", true);
    await vi.waitFor(() => expect(state.diagnostics.has("retry")).toBe(true));
    const saved = state.diagnostics.get("retry")!;
    expect(JSON.parse(saved).stage).toBe("background");
    expect(saved).not.toContain("RAW_PROVIDER_SECRET");
    expect(Buffer.byteLength(saved)).toBeLessThan(24_000);
  });

  it("retains the successful run snapshot when subsequent background completion storage fails", async () => {
    vi.stubEnv("FUTURE_SCIENCE_API_KEY", "");
    state.completeFails = true;
    const diagnostic = new ReproductionDiagnostics();
    diagnostic.stage("report");
    diagnostic.stop("model");
    diagnostic.observe({ kind: "response", round: 7, callCount: 12, responseExcerpt: "Completed work." });
    diagnostic.claims([{ id: "R1", claim: "Measured result", status: "verified" }]);
    const snapshot = diagnostic.snapshot();
    state.run.mockImplementation(async (options: any) => {
      options.onDiagnostics(snapshot);
      return {
        markdown: "## Report\nMeasured result.", logbook: "Completed logbook.",
        title: "Reproduction Report", abstract: "Result summary", overall: "verified",
        results: [{ id: "R1", claim: "Measured result", verdict: "verified" }],
        counts: { total: 1, verified: 1, falsified: 0, toy: 0, inconclusive: 0 },
        keywords: ["reproduction", "science", "measurement"],
        toolCallCount: 12, sandboxId: "private-sandbox", stoppedBy: "model",
        paperUsed: { title: "Paper", authors: "Author", date: "2026", documentId: "paper" },
        materials: { text: 1, binary: 0 },
      };
    });
    expect((await request("post", "/api/reproductions/:id/retry", true)).status).toBe(201);
    await vi.waitFor(() => expect(state.diagnostics.has("retry")).toBe(true));
    const saved = JSON.parse(state.diagnostics.get("retry")!);
    expect(saved).toMatchObject({ stage: "background", rounds: 7, callCount: 12, claims: snapshot.claims, events: snapshot.events });
    expect(snapshot.stage).toBe("report");
    expect(state.operations).toEqual(["status:generating", "status:completed", "status:failed", "save-diagnostics"]);
    expect(state.runs.get("retry").status).toBe("failed");
    expect(JSON.stringify(state.events)).not.toContain("PRIVATE_COMPLETION_STORAGE_ERROR");
  });
});