/**
 * Tests for the semi-autonomous peer-review batch endpoints in server/routes.ts:
 *  - GET  /api/peer-reviews/eligible-count  (persona+model filtering)
 *  - POST /api/peer-reviews/batch           (shortfall 409, reservation conflict rollback,
 *                                            concurrent runs never double-claim a paper)
 *  - GET  /api/peer-reviews/batch/:id       (ownership: 404 for other users)
 *
 * The storage layer is replaced with an in-memory fake that enforces the same
 * partial unique constraint as peer_reviews_journal_doc_persona_model_uniq:
 * only one non-failed review per (journalId, documentId, persona, modelName).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// In-memory fake of the peer_reviews table with the partial unique index.
// ---------------------------------------------------------------------------
interface FakeReview {
  id: string;
  journalId: string;
  documentId: string;
  persona: string;
  modelName: string | null;
  status: string;
  userId: string | null;
  paperTitle: string | null;
  recommendation: string | null;
  [k: string]: any;
}

const fakeDb = {
  rows: new Map<string, FakeReview>(),
  // documentIds that behave as if another run just claimed them (insert conflict)
  conflictDocs: new Set<string>(),
  reset() {
    this.rows.clear();
    this.conflictDocs.clear();
  },
  comboKey(r: { journalId: string; documentId: string; persona: string; modelName: string | null }) {
    return `${r.journalId}|${r.documentId}|${r.persona}|${r.modelName || ""}`;
  },
  hasActiveCombo(r: { journalId: string; documentId: string; persona: string; modelName: string | null }) {
    const key = this.comboKey(r);
    for (const row of this.rows.values()) {
      if (row.status !== "failed" && this.comboKey(row) === key) return true;
    }
    return false;
  },
};

const storageMock = {
  async createPeerReview(review: any): Promise<FakeReview | null> {
    // Simulate the DB unique-violation -> null behaviour of the real storage.
    if (fakeDb.conflictDocs.has(review.documentId)) return null;
    if (fakeDb.hasActiveCombo(review)) return null;
    const row: FakeReview = {
      id: randomUUID(),
      status: "pending",
      recommendation: null,
      paperTitle: review.paperTitle ?? null,
      userId: review.userId ?? null,
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
  async getReviewedPaperPersonasForJournal(journalId: string) {
    return Array.from(fakeDb.rows.values())
      .filter((r) => r.journalId === journalId && r.status !== "failed")
      .map((r) => ({ documentId: r.documentId, persona: r.persona, modelName: r.modelName }));
  },
  async getProjectPapers(_journalId: string) {
    return [] as any[];
  },
  async getEthicsReportsByProject(_projectId: string) {
    return [] as any[];
  },
  async createResearchEvent(_e: any) {
    return { id: randomUUID() };
  },
};

vi.mock("../storage", () => ({
  // Any method not explicitly faked above resolves to undefined harmlessly.
  storage: new Proxy(storageMock as any, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop];
      return async () => undefined;
    },
  }),
}));

// Auth: identify the user from test headers instead of OAuth sessions/DB.
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
  PER_USER_PLATFORM_LIMITS: {},
  getReadingBudget: () => 100_000,
  READING_BUDGET: 100_000,
}));

// The Future Science catalogue backing getPeerAvailablePapers.
let fsAbstracts: Array<{ documentId: string; title: string; authors: string; date: string }> = [];
vi.mock("../future-science", () => ({
  fetchAbstractsAndKeywords: vi.fn(async () => ({ abstracts: fsAbstracts })),
  fetchAbstractsAndKeywordsCached: vi.fn(async () => ({ abstracts: fsAbstracts })),
  publishToFutureScience: vi.fn(),
  submitLiteratureReviewToFutureScience: vi.fn(),
  submitEthicsReportToFutureScience: vi.fn(),
  submitPeerReviewToFutureScience: vi.fn(),
  fetchAbstractsAndKeywordsRaw: vi.fn(),
  extractTrendsAndGaps: vi.fn(() => ""),
  scoreRelevance: vi.fn(() => 0),
  FutureScienceFetchError: class FutureScienceFetchError extends Error {},
}));

vi.mock("../peer-review", () => ({
  // Never resolves: reserved rows stay pending (locked) for the whole test,
  // like a real in-flight generation. Failing instead would mark rows
  // "failed", releasing their locks and letting a second batch re-claim them.
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

// Unique client IP per request to sidestep the per-IP 30s batch rate limit.
let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

const USER_A = { "x-test-user-id": "user-a", "x-test-user-email": "jevans@uchicago.edu" };
const USER_B = { "x-test-user-id": "user-b", "x-test-user-email": "akozlo@uchicago.edu" };

function postBatch(body: any, user = USER_A) {
  return fetch(`${baseUrl}/api/peer-reviews/batch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": nextIp(),
      ...user,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test-key";
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
});

const paper = (n: number) => ({
  documentId: `doc-${n}`,
  title: `Emergent Behaviour Study ${n}`,
  authors: "Alice Smith, Bob Jones",
  date: `2026-07-0${n}`,
});

// ---------------------------------------------------------------------------
// GET /api/peer-reviews/eligible-count
// ---------------------------------------------------------------------------
describe("GET /api/peer-reviews/eligible-count", () => {
  it("filters by persona+model combo, not persona alone", async () => {
    fsAbstracts = [paper(1), paper(2), paper(3)];
    // doc-1 already reviewed by bR with model m-x
    await storageMock.createPeerReview({
      journalId: "mirror", documentId: "doc-1", persona: "bR", modelName: "m-x",
      projectId: "mirror", agentId: "bR", prompt1: "p",
    });

    const same = await fetch(`${baseUrl}/api/peer-reviews/eligible-count?persona=bR&modelName=m-x`);
    expect(same.status).toBe(200);
    expect(await same.json()).toEqual({ eligibleCount: 2, total: 3 });

    // Different model with the same persona is still eligible.
    const otherModel = await fetch(`${baseUrl}/api/peer-reviews/eligible-count?persona=bR&modelName=m-y`);
    expect(await otherModel.json()).toEqual({ eligibleCount: 3, total: 3 });

    // Different persona with the same model is still eligible.
    const otherPersona = await fetch(`${baseUrl}/api/peer-reviews/eligible-count?persona=aR&modelName=m-x`);
    expect(await otherPersona.json()).toEqual({ eligibleCount: 3, total: 3 });
  });

  it("does not count failed reviews as locks", async () => {
    fsAbstracts = [paper(1), paper(2)];
    const row = await storageMock.createPeerReview({
      journalId: "mirror", documentId: "doc-1", persona: "bR", modelName: "m-x",
      projectId: "mirror", agentId: "bR", prompt1: "p",
    });
    await storageMock.updatePeerReview(row!.id, { status: "failed" });

    const res = await fetch(`${baseUrl}/api/peer-reviews/eligible-count?persona=bR&modelName=m-x`);
    expect(await res.json()).toEqual({ eligibleCount: 2, total: 2 });
  });
});

// ---------------------------------------------------------------------------
// POST /api/peer-reviews/batch — shortfall
// ---------------------------------------------------------------------------
describe("POST /api/peer-reviews/batch shortfall", () => {
  it("returns 409 with maxAvailable when fewer papers are eligible than requested", async () => {
    fsAbstracts = [paper(1), paper(2), paper(3)];
    await storageMock.createPeerReview({
      journalId: "mirror", documentId: "doc-1", persona: "bR", modelName: "m-x",
      projectId: "mirror", agentId: "bR", prompt1: "p",
    });
    const before = fakeDb.rows.size;

    const res = await postBatch({ persona: "bR", modelName: "m-x", count: 5 });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.maxAvailable).toBe(2);
    // Nothing was reserved.
    expect(fakeDb.rows.size).toBe(before);
  });

  it("rejects invalid counts", async () => {
    fsAbstracts = [paper(1)];
    expect((await postBatch({ persona: "bR", modelName: "m-x", count: 0 })).status).toBe(400);
    expect((await postBatch({ persona: "bR", modelName: "m-x", count: 26 })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/peer-reviews/batch — reservation conflict rollback
// ---------------------------------------------------------------------------
describe("POST /api/peer-reviews/batch reservation conflict", () => {
  it("rolls back all reserved rows and returns 409 when a paper is claimed mid-flight", async () => {
    fsAbstracts = [paper(1), paper(2)];
    // doc-2 passes the eligibility check but its insert conflicts, as if a
    // concurrent run claimed it between the check and the reservation.
    fakeDb.conflictDocs.add("doc-2");

    const res = await postBatch({ persona: "bR", modelName: "m-x", count: 2 });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.maxAvailable).toBe(1);
    expect(body.error).toMatch(/just claimed by another run/i);
    // The partially reserved row (doc-1) was rolled back — no orphaned pending rows.
    expect(fakeDb.rows.size).toBe(0);
  });

  it("never double-claims papers across genuinely concurrent batch runs", async () => {
    fsAbstracts = [paper(1), paper(2), paper(3), paper(4)];

    const [resA, resB] = await Promise.all([
      postBatch({ persona: "bR", modelName: "m-x", count: 3 }, USER_A),
      postBatch({ persona: "bR", modelName: "m-x", count: 3 }, USER_B),
    ]);

    const statuses = [resA.status, resB.status].sort();
    // Only 4 papers exist for 6 requested reviews: at most one run can win.
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    expect(statuses.filter((s) => s === 201).length).toBeLessThanOrEqual(1);

    const winnerReviewIds: string[] = [];
    for (const res of [resA, resB]) {
      const body = await res.json();
      if (res.status === 201) {
        expect(body.total).toBe(3);
        expect(body.reviewIds).toHaveLength(3);
        winnerReviewIds.push(...body.reviewIds);
      } else {
        expect(res.status).toBe(409);
        expect(typeof body.maxAvailable).toBe("number");
      }
    }

    // Every surviving row belongs to a winning batch (losers rolled back fully) …
    const remainingIds = Array.from(fakeDb.rows.keys()).sort();
    expect(remainingIds).toEqual([...winnerReviewIds].sort());

    // … and no paper ever holds two reviews for the same persona+model combo.
    const combos = Array.from(fakeDb.rows.values()).map((r) => fakeDb.comboKey(r));
    expect(new Set(combos).size).toBe(combos.length);
  });
});

// ---------------------------------------------------------------------------
// GET /api/peer-reviews/batch/:id — ownership
// ---------------------------------------------------------------------------
describe("GET /api/peer-reviews/batch/:id ownership", () => {
  it("returns the batch to its owner and 404 to other users", async () => {
    fsAbstracts = [paper(1), paper(2)];
    const createRes = await postBatch({ persona: "bR", modelName: "m-x", count: 2 }, USER_A);
    expect(createRes.status).toBe(201);
    const { batchId } = await createRes.json();

    const asOwner = await fetch(`${baseUrl}/api/peer-reviews/batch/${batchId}`, { headers: USER_A });
    expect(asOwner.status).toBe(200);
    const status = await asOwner.json();
    expect(status.batchId).toBe(batchId);
    expect(status.total).toBe(2);
    expect(status.items).toHaveLength(2);

    const asOther = await fetch(`${baseUrl}/api/peer-reviews/batch/${batchId}`, { headers: USER_B });
    expect(asOther.status).toBe(404);

    const missing = await fetch(`${baseUrl}/api/peer-reviews/batch/${randomUUID()}`, { headers: USER_A });
    expect(missing.status).toBe(404);

    const unauthenticated = await fetch(`${baseUrl}/api/peer-reviews/batch/${batchId}`);
    expect(unauthenticated.status).toBe(401);
  });
});
