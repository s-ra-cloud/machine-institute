import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  submitPeerReviewToFutureScience,
  submitEthicsReportToFutureScience,
} from "../future-science";

// ---------------------------------------------------------------------------
// End-to-end confirmation that a Future Science api-bots submission ACCEPTS the
// majorRevisions / minorRevisions payload shape.
//
// Two layers:
//  1. Deterministic (always runs in CI): we stub global.fetch, capture the exact
//     multipart payload our submit functions send to FS, and assert it matches
//     the FS contract (item key `description`, ≤10 entries, ≤1500 chars), then
//     simulate FS returning a documentId and assert the function surfaces it.
//  2. Live (opt-in): when FS_LIVE=1 and FUTURE_SCIENCE_API_KEY +
//     FS_LIVE_LINK_ORIGINAL are set, actually POST to FS and assert a real
//     documentId comes back. Skipped otherwise so CI stays hermetic and we
//     don't pollute FS with throwaway contributions.
// ---------------------------------------------------------------------------

const FS_API_BOTS = "https://future-science.org/api/v1/contributions/api-bots";

// FS-documented limits (mirror future-science.ts constants).
const MAX_REVISIONS = 10;
const MAX_REVISION_DESC = 1500;

interface CapturedAttempt {
  metadata: Record<string, any>;
}

// Extract the JSON metadata our code packs into the multipart "data" field.
async function readAttempt(body: unknown): Promise<CapturedAttempt> {
  const form = body as FormData;
  const dataField = form.get("data");
  const parsed = JSON.parse(String(dataField));
  return { metadata: parsed.data as Record<string, any> };
}

function assertRevisionShape(arr: unknown) {
  expect(Array.isArray(arr)).toBe(true);
  const items = arr as Array<Record<string, unknown>>;
  // FS rejects arrays longer than 10.
  expect(items.length).toBeGreaterThan(0);
  expect(items.length).toBeLessThanOrEqual(MAX_REVISIONS);
  for (const item of items) {
    // The ONLY accepted key per item is `description`.
    expect(Object.keys(item)).toEqual(["description"]);
    expect(typeof item.description).toBe("string");
    // FS rejects descriptions longer than 1500 chars.
    expect((item.description as string).length).toBeLessThanOrEqual(MAX_REVISION_DESC);
    expect((item.description as string).length).toBeGreaterThan(0);
  }
}

// 12 major + 12 minor revisions, several with >1500-char descriptions, to prove
// our normalization keeps the payload inside FS's caps before it ever leaves us.
function overflowingRevisions() {
  const major = Array.from({ length: 12 }, (_, i) =>
    i === 0
      ? { description: "x".repeat(2000) } // over the char cap
      : { description: `Major issue ${i + 1}: tighten the argument and add evidence.` },
  );
  const minor = Array.from({ length: 12 }, (_, i) => ({
    description: `Minor nit ${i + 1}: fix wording/formatting.`,
  }));
  return { major, minor };
}

describe("Future Science — revision arrays accepted end-to-end (deterministic)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    process.env.FUTURE_SCIENCE_API_KEY = "test-key";
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("peer review: sends a contract-valid revision payload and returns FS documentId", async () => {
    const attempts: CapturedAttempt[] = [];
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      attempts.push(await readAttempt(init.body));
      return new Response(
        JSON.stringify({ data: { documentId: "fs-peer-doc-123", slug: "peer-slug" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const { major, minor } = overflowingRevisions();
    const result = await submitPeerReviewToFutureScience({
      title: "Peer review of A Test Paper",
      markdownContent: "# Review\n\nBody.",
      abstract: "Abstract of the review.",
      keywords: ["interpretability", "review", "mirror"],
      agentName: "MachInstit DS32bR-N1",
      initiativeDocId: "init-doc",
      initiativeSlug: "mirror",
      linkOriginalContribution: "https://future-science.org/mirror/doc-1",
      majorRevisions: major,
      minorRevisions: minor,
    });

    // FS accepted on the first (response-style) type → exactly one POST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(FS_API_BOTS);

    const md = attempts[0].metadata;
    expect(md.type).toBe("Peer-review");
    expect(md.linkOriginalContribution).toBe("https://future-science.org/mirror/doc-1");
    assertRevisionShape(md.majorRevisions);
    assertRevisionShape(md.minorRevisions);
    // Overflow trimmed to the cap, long description truncated with an ellipsis.
    expect(md.majorRevisions).toHaveLength(MAX_REVISIONS);
    expect(md.minorRevisions).toHaveLength(MAX_REVISIONS);
    expect(md.majorRevisions[0].description.length).toBe(MAX_REVISION_DESC);
    expect(md.majorRevisions[0].description.endsWith("…")).toBe(true);

    expect(result).not.toBeNull();
    expect(result!.documentId).toBe("fs-peer-doc-123");
  });

  it("publication audit: sends a contract-valid revision payload and returns FS documentId", async () => {
    const attempts: CapturedAttempt[] = [];
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      attempts.push(await readAttempt(init.body));
      return new Response(
        JSON.stringify({ data: { documentId: "fs-audit-doc-456", slug: "audit-slug" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const { major, minor } = overflowingRevisions();
    const result = await submitEthicsReportToFutureScience({
      title: "Publication audit of A Test Paper",
      markdownContent: "# Audit\n\nBody.",
      abstract: "Abstract of the audit.",
      keywords: ["ethics", "audit", "mirror"],
      agentName: "MachInstit DS32H-N1",
      initiativeDocId: "init-doc",
      initiativeSlug: "mirror",
      linkOriginalContribution: "https://future-science.org/mirror/doc-1",
      majorRevisions: major,
      minorRevisions: minor,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const md = attempts[0].metadata;
    expect(md.type).toBe("Audit");
    expect(md.linkOriginalContribution).toBe("https://future-science.org/mirror/doc-1");
    assertRevisionShape(md.majorRevisions);
    assertRevisionShape(md.minorRevisions);
    expect(md.majorRevisions).toHaveLength(MAX_REVISIONS);
    expect(md.minorRevisions).toHaveLength(MAX_REVISIONS);

    expect(result).not.toBeNull();
    expect(result!.documentId).toBe("fs-audit-doc-456");
  });

  it("peer review: if FS rejects the array shape on the response type, fallback strips revisions and still publishes", async () => {
    // Simulate FS rejecting "Peer-review" (e.g. schema drift on the revision
    // arrays), then accepting a later non-response fallback type. The fallback
    // MUST NOT carry revisions / linkOriginalContribution.
    const attempts: CapturedAttempt[] = [];
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const attempt = await readAttempt(init.body);
      attempts.push(attempt);
      if (attempt.metadata.type === "Peer-review" || attempt.metadata.type === "Response to a contribution") {
        return new Response("revisions rejected", { status: 400 });
      }
      return new Response(
        JSON.stringify({ data: { documentId: "fs-fallback-789" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const { major, minor } = overflowingRevisions();
    const result = await submitPeerReviewToFutureScience({
      title: "Peer review of A Test Paper",
      markdownContent: "# Review\n\nBody.",
      abstract: "Abstract.",
      keywords: ["a", "b", "c"],
      agentName: "MachInstit DS32bR-N1",
      initiativeDocId: "init-doc",
      initiativeSlug: "mirror",
      linkOriginalContribution: "https://future-science.org/mirror/doc-1",
      majorRevisions: major,
      minorRevisions: minor,
    });

    expect(result).not.toBeNull();
    expect(result!.documentId).toBe("fs-fallback-789");

    const accepted = attempts.find(
      (a) => a.metadata.type !== "Peer-review" && a.metadata.type !== "Response to a contribution",
    )!;
    expect(accepted.metadata.majorRevisions).toBeUndefined();
    expect(accepted.metadata.minorRevisions).toBeUndefined();
    expect(accepted.metadata.linkOriginalContribution).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Opt-in LIVE check. Run with:
//   FS_LIVE=1 FUTURE_SCIENCE_API_KEY=... FS_LIVE_LINK_ORIGINAL=https://future-science.org/mirror/<slug> \
//     npx vitest run server/__tests__/fs-revision-integration.test.ts
// This actually creates contributions on Future Science, so it is skipped by
// default to keep CI hermetic and avoid throwaway records.
// ---------------------------------------------------------------------------
const LIVE = process.env.FS_LIVE === "1"
  && Boolean(process.env.FUTURE_SCIENCE_API_KEY)
  && Boolean(process.env.FS_LIVE_LINK_ORIGINAL);

describe.skipIf(!LIVE)("Future Science — revision arrays accepted end-to-end (LIVE)", () => {
  const link = process.env.FS_LIVE_LINK_ORIGINAL as string;
  const stamp = new Date().toISOString();

  it("peer review: FS accepts populated revision arrays and returns a documentId", async () => {
    const result = await submitPeerReviewToFutureScience({
      title: `[CI verify] Peer review revision shape ${stamp}`,
      markdownContent: `# CI verification\n\nConfirms FS accepts revision arrays. ${stamp}`,
      abstract: "Automated CI check of the majorRevisions/minorRevisions payload shape.",
      keywords: ["ci", "verification", "revisions"],
      agentName: "MachInstit DS32bR-N1",
      initiativeDocId: "efyjiy34s5lgbx2gr50k5h9l",
      initiativeSlug: "mirror",
      linkOriginalContribution: link,
      majorRevisions: [
        { description: "Add a power calculation to the statistical analysis." },
        { description: "Support the Section 3 claim with the underlying data." },
      ],
      minorRevisions: [{ description: "Fix the typo in Table 1." }],
    });
    expect(result).not.toBeNull();
    expect(result!.documentId).toBeTruthy();
    expect(result!.documentId).not.toBe("unknown");
  }, 60_000);

  it("publication audit: FS accepts populated revision arrays and returns a documentId", async () => {
    const result = await submitEthicsReportToFutureScience({
      title: `[CI verify] Audit revision shape ${stamp}`,
      markdownContent: `# CI verification\n\nConfirms FS accepts revision arrays. ${stamp}`,
      abstract: "Automated CI check of the majorRevisions/minorRevisions payload shape.",
      keywords: ["ci", "verification", "revisions"],
      agentName: "MachInstit DS32H-N1",
      initiativeDocId: "efyjiy34s5lgbx2gr50k5h9l",
      initiativeSlug: "mirror",
      linkOriginalContribution: link,
      majorRevisions: [{ description: "Citation in §2 could not be verified; provide a resolvable source." }],
      minorRevisions: [{ description: "Disclose the dataset license." }],
    });
    expect(result).not.toBeNull();
    expect(result!.documentId).toBeTruthy();
    expect(result!.documentId).not.toBe("unknown");
  }, 60_000);
});
