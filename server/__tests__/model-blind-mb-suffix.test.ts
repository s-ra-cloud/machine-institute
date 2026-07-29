/**
 * Model-blind MB suffix guard: proves the evaluator convention code carries the
 * "MB" suffix on every code-build path — single review, batch reviews, and
 * republish — and NOT when modelBlind is off.
 *
 * Boots the real routes with mocked storage / model service / Future Science,
 * following the harness in peer-review-batch.test.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// In-memory fake of the peer_reviews table.
// ---------------------------------------------------------------------------
interface FakeReview {
  id: string;
  journalId: string;
  documentId: string;
  persona: string;
  modelName: string | null;
  status: string;
  orchestratorName: string | null;
  [k: string]: any;
}

const fakeDb = {
  rows: new Map<string, FakeReview>(),
  reset() {
    this.rows.clear();
  },
};

const storageMock = {
  async createPeerReview(review: any): Promise<FakeReview | null> {
    const row: FakeReview = {
      id: randomUUID(),
      status: "pending",
      orchestratorName: review.orchestratorName ?? null,
      ...review,
      modelName: review.modelName ?? null,
    };
    fakeDb.rows.set(row.id, row);
    return row;
  },
  async deletePeerReview(id: string): Promise<void> {
    fakeDb.rows.delete(id);
  },
  async getPeerReviewById(id: string): Promise<FakeReview | undefined> {
    return fakeDb.rows.get(id);
  },
  async updatePeerReview(id: string, updates: any): Promise<FakeReview | undefined> {
    const row = fakeDb.rows.get(id);
    if (row) Object.assign(row, updates);
    return row;
  },
  async getPeerReviewsByBatchId(batchId: string): Promise<FakeReview[]> {
    return Array.from(fakeDb.rows.values()).filter((r) => r.batchId === batchId);
  },
  async getReviewedPaperPersonasForJournal(_journalId: string) {
    return [] as Array<{ documentId: string; persona: string; modelName: string | null }>;
  },
  async getProjectPapers(_journalId: string) {
    return [] as any[];
  },
  async getEthicsReportsByProject(_projectId: string) {
    return [] as any[];
  },
  async checkAndIncrementRateLimit(_userId: string, _kind: string, _max: number, _windowMs: number) {
    return { allowed: true };
  },
  async createResearchEvent(_e: any) {
    return { id: randomUUID() };
  },
};

vi.mock("../storage", () => ({
  storage: new Proxy(storageMock as any, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop];
      return async () => undefined;
    },
  }),
}));

vi.mock("../auth", () => ({
  setupAuth: () => {},
  requireAuth: (req: any, res: any, next: any) => {
    const id = req.headers["x-test-user-id"];
    if (!id) return res.status(401).json({ error: "Unauthorized" });
    req.user = { id, email: req.headers["x-test-user-email"] || "" };
    next();
  },
  optionalAuth: (_req: any, _res: any, next: any) => next(),
  adminAuth: (_req: any, _res: any, next: any) => next(),
  requireSession: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../model-service", () => ({
  createLLMClient: () => ({}),
  resolveModelName: (cfg: any) => cfg?.modelName || "test-model",
  generateWithConfig: vi.fn(async () => {
    throw new Error("LLM disabled in tests");
  }),
  validateApiKey: vi.fn(async () => ({ valid: true })),
  PLATFORM_MODELS: [] as any[],
  BYOC_PROVIDERS: [] as any[],
  PER_USER_PLATFORM_LIMITS: { "peer-review": { max: 100, windowMs: 86_400_000 } },
  getReadingBudget: () => 100_000,
  READING_BUDGET: 100_000,
}));

let fsAbstracts: Array<{ documentId: string; title: string; authors: string; date: string }> = [];
const submitPeerReviewMock = vi.fn(async () => ({ documentId: "fs-doc-1", url: "https://fs/doc-1" }));
vi.mock("../future-science", () => ({
  fetchAbstractsAndKeywords: vi.fn(async () => ({ abstracts: fsAbstracts })),
  fetchAbstractsAndKeywordsCached: vi.fn(async () => ({ abstracts: fsAbstracts })),
  publishToFutureScience: vi.fn(),
  submitLiteratureReviewToFutureScience: vi.fn(),
  submitEthicsReportToFutureScience: vi.fn(),
  submitPeerReviewToFutureScience: (...args: any[]) => submitPeerReviewMock(...(args as [any])),
  extractTrendsAndGaps: vi.fn(() => ""),
  scoreRelevance: vi.fn(() => 0),
  FutureScienceFetchError: class FutureScienceFetchError extends Error {},
}));

vi.mock("../peer-review", () => ({
  // Never resolves: reserved rows stay pending, like a real in-flight generation.
  runPeerReview: vi.fn(() => new Promise(() => {})),
}));

vi.mock("../ephemeral-keys", () => ({
  storeEphemeralKey: vi.fn(async () => {}),
  getEphemeralKey: () => null,
}));

// ---------------------------------------------------------------------------
// Boot the real routes on an ephemeral port.
// ---------------------------------------------------------------------------
let baseUrl: string;
let httpServer: import("http").Server;

// Unique client IP per request to sidestep the per-IP 30s rate limits.
let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.1.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

const USER_A = { "x-test-user-id": "user-a", "x-test-user-email": "jevans@uchicago.edu" };

function post(path: string, body: any) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": nextIp(),
      ...USER_A,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-key";
  process.env.FUTURE_SCIENCE_API_KEY = process.env.FUTURE_SCIENCE_API_KEY || "test-fs-key";
  const express = (await import("express")).default;
  const { createServer } = await import("http");
  const { registerRoutes } = await import("../routes");

  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "10mb" }));
  httpServer = createServer(app);
  await registerRoutes(httpServer, app);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const addr = httpServer.address() as import("net").AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(() => {
  fakeDb.reset();
  fsAbstracts = [];
  submitPeerReviewMock.mockClear();
});

const paper = (n: number) => ({
  documentId: `doc-${n}`,
  title: `Emergent Behaviour Study ${n}`,
  authors: "Alice Smith, Bob Jones",
  date: `2026-07-0${n}`,
});

// ---------------------------------------------------------------------------
// Single review path — POST /api/peer-reviews
// ---------------------------------------------------------------------------
describe("MB suffix — single review path", () => {
  it("appends MB to the evaluator code when modelBlind=true", async () => {
    const res = await post("/api/peer-reviews", {
      persona: "bR",
      modelName: "claude-sonnet-4-5",
      documentId: "doc-1",
      modelBlind: true,
    });
    expect(res.status).toBe(201);
    const review = await res.json();
    expect(review.orchestratorName).toBe("MachInstit CS45bR-N1MB");
    expect(review.modelBlind).toBe(true);
  });

  it("does NOT append MB when modelBlind is off", async () => {
    const res = await post("/api/peer-reviews", {
      persona: "bR",
      modelName: "claude-sonnet-4-5",
      documentId: "doc-2",
    });
    expect(res.status).toBe(201);
    const review = await res.json();
    expect(review.orchestratorName).toBe("MachInstit CS45bR-N1");
    expect(review.orchestratorName.endsWith("MB")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Batch path — POST /api/peer-reviews/batch
// ---------------------------------------------------------------------------
describe("MB suffix — batch path", () => {
  it("appends MB to every reserved review's evaluator code when modelBlind=true", async () => {
    fsAbstracts = [paper(1), paper(2), paper(3)];
    const res = await post("/api/peer-reviews/batch", {
      persona: "aR",
      modelName: "gpt-5",
      count: 3,
      modelBlind: true,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.reviewIds).toHaveLength(3);

    const rows = Array.from(fakeDb.rows.values());
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.orchestratorName).toBe("MachInstit G5aR-N1MB");
      expect(row.modelBlind).toBe(true);
    }
  });

  it("does NOT append MB when modelBlind is off", async () => {
    fsAbstracts = [paper(1), paper(2)];
    const res = await post("/api/peer-reviews/batch", {
      persona: "aR",
      modelName: "gpt-5",
      count: 2,
    });
    expect(res.status).toBe(201);
    for (const row of fakeDb.rows.values()) {
      expect(row.orchestratorName).toBe("MachInstit G5aR-N1");
    }
  });
});

// ---------------------------------------------------------------------------
// Republish path — POST /api/peer-reviews/:id/republish
// ---------------------------------------------------------------------------
describe("MB suffix — republish path", () => {
  function completedReview(overrides: Partial<FakeReview> = {}): FakeReview {
    const row: FakeReview = {
      id: randomUUID(),
      journalId: "mirror",
      documentId: "doc-9",
      persona: "rR",
      modelName: "deepseek-r1",
      status: "completed",
      orchestratorName: null,
      paperTitle: "Emergent Behaviour Study 9",
      reviewTitle: 'Rigorous Peer Review: "Emergent Behaviour Study 9"',
      reviewAbstract: "Existing abstract.",
      contentMarkdown: "## Review Summary\nSolid work overall.\n\nRecommendation: Accept\n",
      recommendation: "Accept",
      includeEthicsCoauthor: false,
      ethicsReportId: null,
      sourceTrace: null,
      agentDescription: null,
      modelBlind: false,
      ...overrides,
    };
    fakeDb.rows.set(row.id, row);
    return row;
  }

  it("rebuilds the evaluator code WITH the MB suffix for a model-blind review", async () => {
    const row = completedReview({ modelBlind: true });
    const res = await post(`/api/peer-reviews/${row.id}/republish`, {});
    expect(res.status).toBe(200);

    expect(submitPeerReviewMock).toHaveBeenCalledTimes(1);
    const args = submitPeerReviewMock.mock.calls[0][0] as any;
    expect(args.agentName).toBe("MachInstit DSR1rR-N1MB");
  });

  it("rebuilds the evaluator code WITHOUT the MB suffix for a non-blind review", async () => {
    const row = completedReview({ modelBlind: false });
    const res = await post(`/api/peer-reviews/${row.id}/republish`, {});
    expect(res.status).toBe(200);

    expect(submitPeerReviewMock).toHaveBeenCalledTimes(1);
    const args = submitPeerReviewMock.mock.calls[0][0] as any;
    expect(args.agentName).toBe("MachInstit DSR1rR-N1");
  });
});
