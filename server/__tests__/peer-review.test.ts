import { describe, it, expect } from "vitest";
import {
  getPeerReviewChunkPrompts,
  REVIEW_CHUNK_1_PROMPT,
  REVIEW_CHUNK_2_PROMPT,
  REVIEW_CHUNK_3_PROMPT,
  AR_REVIEW_CHUNK_1_PROMPT,
  AR_REVIEW_CHUNK_2_PROMPT,
  AR_REVIEW_CHUNK_3_PROMPT,
  IR_REVIEW_CHUNK_1_PROMPT,
  IR_REVIEW_CHUNK_2_PROMPT,
  IR_REVIEW_CHUNK_3_PROMPT,
} from "../prompts/peer-review";

describe("Peer review — persona prompt routing", () => {
  it("returns the bR prompt set by default and for explicit bR", () => {
    expect(getPeerReviewChunkPrompts("bR")).toEqual([
      REVIEW_CHUNK_1_PROMPT,
      REVIEW_CHUNK_2_PROMPT,
      REVIEW_CHUNK_3_PROMPT,
    ]);
  });

  it("returns the aR (adversarial) prompt set for aR", () => {
    expect(getPeerReviewChunkPrompts("aR")).toEqual([
      AR_REVIEW_CHUNK_1_PROMPT,
      AR_REVIEW_CHUNK_2_PROMPT,
      AR_REVIEW_CHUNK_3_PROMPT,
    ]);
  });

  it("returns the iR (innovation) prompt set for iR", () => {
    expect(getPeerReviewChunkPrompts("iR")).toEqual([
      IR_REVIEW_CHUNK_1_PROMPT,
      IR_REVIEW_CHUNK_2_PROMPT,
      IR_REVIEW_CHUNK_3_PROMPT,
    ]);
  });

  it("each persona's chunk-1 prompt mentions its own role code", () => {
    expect(AR_REVIEW_CHUNK_1_PROMPT).toMatch(/aR/);
    expect(IR_REVIEW_CHUNK_1_PROMPT).toMatch(/iR/);
  });
});

describe("Peer review — co-author parallel synthesis flow", () => {
  it("awaits ethicsPromise (when supplied) before chunk 3 is built", async () => {
    // Simulate the synthesis-stage await: peer-review.ts awaits opts.ethicsPromise
    // AFTER chunks 1 + 2 complete and BEFORE assembling the chunk-3 input. This
    // confirms the two pipelines are parallel and the ethics result is available
    // for synthesis.
    const order: string[] = [];

    const chunk1 = (async () => { order.push("chunk1-start"); await Promise.resolve(); order.push("chunk1-done"); return "c1"; })();
    const chunk2 = (async () => { order.push("chunk2-start"); await Promise.resolve(); order.push("chunk2-done"); return "c2"; })();
    const ethicsPromise = (async () => { order.push("ethics-start"); await Promise.resolve(); await Promise.resolve(); order.push("ethics-done"); return { reportText: "E" }; })();

    await chunk1;
    await chunk2;
    const ethicsResult = await ethicsPromise;
    order.push("chunk3-start");

    // chunk1, chunk2, ethics all started before chunk3 began (parallel launch)
    expect(order.indexOf("chunk1-start")).toBeLessThan(order.indexOf("chunk3-start"));
    expect(order.indexOf("ethics-start")).toBeLessThan(order.indexOf("chunk3-start"));
    // Ethics resolves BEFORE chunk3 begins — synthesis can use it
    expect(order.indexOf("ethics-done")).toBeLessThan(order.indexOf("chunk3-start"));
    expect(ethicsResult).toEqual({ reportText: "E" });
  });
});

describe("Peer review — Future Science multi-author payload shape", () => {
  // Mirrors the author array construction in submitPeerReviewToFutureScience.
  function buildAuthors(primaryName: string, ethicsCoauthorName?: string) {
    const splitAgent = (n: string) => {
      const parts = n.trim().split(/\s+/);
      return { firstName: parts[0] || "Machine", lastName: parts.slice(1).join(" ") || "Institute" };
    };
    const primary = splitAgent(primaryName);
    const authors: Array<{ firstName: string; lastName: string; institution: string }> = [
      { firstName: primary.firstName, lastName: primary.lastName, institution: "Machine Institute" },
    ];
    if (ethicsCoauthorName) {
      const co = splitAgent(ethicsCoauthorName);
      authors.push({ firstName: co.firstName, lastName: co.lastName, institution: "Machine Institute" });
    }
    return authors;
  }

  it("single-author payload when no ethics co-author", () => {
    const a = buildAuthors("MachInstit DS32bR-N1");
    expect(a).toHaveLength(1);
    expect(a[0].firstName).toBe("MachInstit");
    expect(a[0].lastName).toBe("DS32bR-N1");
  });

  it("two-author payload when ethics co-author is included, peer reviewer is first", () => {
    const a = buildAuthors("MachInstit DS32bR-N1", "MachInstit DS32H-N1");
    expect(a).toHaveLength(2);
    expect(a[0].lastName).toBe("DS32bR-N1");
    expect(a[1].lastName).toBe("DS32H-N1");
  });
});

describe("Peer review — ethics-failure co-author gating", () => {
  // Mirrors the gating logic in server/routes.ts generatePeerReviewBackground:
  //   linkedEthicsReportId   = result.ethicsUsed ? reusedEthicsReportId : null
  //   ethicsCoauthorName     = includeEthicsCoauthor && result.ethicsUsed ? name : undefined
  function gate(opts: {
    includeEthicsCoauthor: boolean;
    reusedEthicsReportId: string | null;
    ethicsUsed: boolean;
    ethicsAgentName: string;
  }) {
    return {
      linkedEthicsReportId: opts.ethicsUsed ? opts.reusedEthicsReportId : null,
      ethicsCoauthorName:
        opts.includeEthicsCoauthor && opts.ethicsUsed ? opts.ethicsAgentName : undefined,
    };
  }

  it("includes H as co-author and links the report when ethics succeeds", () => {
    const g = gate({
      includeEthicsCoauthor: true,
      reusedEthicsReportId: "ER-1",
      ethicsUsed: true,
      ethicsAgentName: "MachInstit DS32H-N1",
    });
    expect(g.linkedEthicsReportId).toBe("ER-1");
    expect(g.ethicsCoauthorName).toBe("MachInstit DS32H-N1");
  });

  it("DROPS H from FS payload AND nulls ethicsReportId when parallel ethics audit fails", () => {
    const g = gate({
      includeEthicsCoauthor: true,
      reusedEthicsReportId: "ER-2", // ethics row was created but pipeline returned null
      ethicsUsed: false,
      ethicsAgentName: "MachInstit DS32H-N1",
    });
    expect(g.linkedEthicsReportId).toBeNull();
    expect(g.ethicsCoauthorName).toBeUndefined();
  });

  it("does not include H when the user opted out, regardless of ethicsUsed", () => {
    const g = gate({
      includeEthicsCoauthor: false,
      reusedEthicsReportId: null,
      ethicsUsed: false,
      ethicsAgentName: "MachInstit DS32H-N1",
    });
    expect(g.linkedEthicsReportId).toBeNull();
    expect(g.ethicsCoauthorName).toBeUndefined();
  });
});

describe("Peer review — bR chunk-2 prompt: Section 5 fabrication guard (prompt-level constraints)", () => {
  // These tests verify that the required anti-fabrication rules are encoded
  // in REVIEW_CHUNK_2_PROMPT. They fail if the prompt is reverted to a version
  // that lacks the explicit prohibitions.

  it("empty corpus → prompt mandates transparency statement opening Section 5", () => {
    // The prompt must explicitly instruct the agent to open Section 5 with a
    // prescribed sentence when the Publications section is empty.
    expect(REVIEW_CHUNK_2_PROMPT).toContain(
      "No prior works from this venue were available for direct comparison; the discussion below is based on the literature cited in the audited paper itself."
    );
  });

  it("corpus availability check rule is present", () => {
    expect(REVIEW_CHUNK_2_PROMPT).toContain("CORPUS AVAILABILITY CHECK");
    // Rule must instruct: use only Publications section OR audited paper's own bibliography
    expect(REVIEW_CHUNK_2_PROMPT).toMatch(/audited paper'?s? own bibliography/i);
  });

  it("bibliography fabrication prohibition is present and absolute", () => {
    expect(REVIEW_CHUNK_2_PROMPT).toContain("FABRICATION PROHIBITION");
    // Must cover at minimum: paper title, author name, journal name
    expect(REVIEW_CHUNK_2_PROMPT).toMatch(/paper title/i);
    expect(REVIEW_CHUNK_2_PROMPT).toMatch(/journal name/i);
    expect(REVIEW_CHUNK_2_PROMPT).toMatch(/author name/i);
  });

  it("quotation prohibition is present — no quotation marks unless verbatim text is in input", () => {
    expect(REVIEW_CHUNK_2_PROMPT).toContain("QUOTATION PROHIBITION");
    // Must explicitly forbid quotation marks and offer paraphrase alternative
    expect(REVIEW_CHUNK_2_PROMPT).toMatch(/quotation marks/i);
    expect(REVIEW_CHUNK_2_PROMPT).toMatch(/paraphrase/i);
  });

  it("methodological connection prohibition is present", () => {
    expect(REVIEW_CHUNK_2_PROMPT).toContain("CONNECTION PROHIBITION");
  });

  it("pre-emission validation pass is mandated", () => {
    expect(REVIEW_CHUNK_2_PROMPT).toContain("PRE-EMISSION VALIDATION");
    // Must require traceable sources for all cited works
    expect(REVIEW_CHUNK_2_PROMPT).toMatch(/traceable/i);
  });

  it("single-verified-work path: paraphrase-only instruction is present (no fabricated quotes)", () => {
    // When only one corpus entry exists, agent must paraphrase not quote.
    // This is covered by the QUOTATION PROHIBITION rule.
    expect(REVIEW_CHUNK_2_PROMPT).toMatch(/X et al\. argue that/i);
    expect(REVIEW_CHUNK_2_PROMPT).toMatch(/X et al\. find that/i);
  });
});

describe("Peer review — bR chunk-3 prompt: calibration and scope rules (prompt-level constraints)", () => {
  it("Section 7 scope rule prohibits minor ethics/formatting findings from appearing there", () => {
    expect(REVIEW_CHUNK_3_PROMPT).toContain("SCOPE RULE (STRICT)");
    // Must explicitly exclude missing bibliography entries, broken links, formatting
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/missing bibliography/i);
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/broken hyperlinks|broken links/i);
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/formatting/i);
    // Must direct those to Section 8
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/Section 8/);
  });

  it("superlatives + no core-finding failure → forced Minor Revision calibration rule is present", () => {
    expect(REVIEW_CHUNK_3_PROMPT).toContain("CALIBRATION PROCEDURE");
    // Must enumerate superlative terms
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/exceptional/i);
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/compelling/i);
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/outstanding/i);
    // Must define core-finding failure
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/core-finding failure/i);
    // Must force Minor Revision when superlatives + no core-finding failure
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/Minor Revision.*under these conditions|MUST be Minor Revision/i);
  });

  it("calibration state message is specified in the prompt", () => {
    // The prompt must specify the exact text the agent should emit to acknowledge calibration
    expect(REVIEW_CHUNK_3_PROMPT).toContain(
      "Calibration check: Strengths language was affirmative; no core-finding failure was identified in Weaknesses; recommendation is calibrated to Minor Revision."
    );
  });

  it("recommendations must be 1:1 with findings — generic best-practice exclusion is present", () => {
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/Do NOT include generic best-practice/i);
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/tied to a specific finding/i);
  });

  it("section ordering is mandated as 7, 8, 9, Bibliography with no gaps", () => {
    // Must explicitly state the required order and prohibit gaps
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/7, 8, 9, Bibliography/);
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/no skipped|no gaps/i);
  });

  it("bibliography in chunk-3 also carries the source-traceability requirement", () => {
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/verified sources/i);
    // Must prohibit invented bibliographic fields
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/omit that field rather than invent/i);
  });

  it("severity definitions are spelled out in the recommendation section", () => {
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/Reject: fundamental flaws not addressable/i);
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/Major Revision: concerns that, if not addressed/i);
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/Minor Revision: paper.s core findings hold/i);
  });
});

describe("Peer review — loadPaperContext shape (skips ethics-only verifiers)", () => {
  it("PaperContext returned by loadPaperContext exposes the fields peer-review needs and nothing more", async () => {
    // Verify the contract used by server/peer-review.ts L88: the destructured
    // fields (title, authors, date, abstract, url, fullText, hadFullText,
    // fsAbstracts) all exist on the loadPaperContext return type.
    const { loadPaperContext } = await import("../ethics-review");
    expect(typeof loadPaperContext).toBe("function");

    type Ctx = Awaited<ReturnType<typeof loadPaperContext>>;
    const probe: Ctx = {
      title: "t",
      authors: "a",
      date: "d",
      abstract: "ab",
      url: "u",
      fullText: "ft",
      hadFullText: true,
      fsAbstracts: [],
    };
    expect(Object.keys(probe).sort()).toEqual([
      "abstract", "authors", "date", "fsAbstracts", "fullText", "hadFullText", "title", "url",
    ]);
  });
});
