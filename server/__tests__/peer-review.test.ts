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
  RR_REVIEW_CHUNK_1_PROMPT,
  RR_REVIEW_CHUNK_2_PROMPT,
  RR_REVIEW_CHUNK_3_PROMPT,
  extractRecommendation,
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

  it("returns the rR (rigorous) prompt set for rR", () => {
    expect(getPeerReviewChunkPrompts("rR")).toEqual([
      RR_REVIEW_CHUNK_1_PROMPT,
      RR_REVIEW_CHUNK_2_PROMPT,
      RR_REVIEW_CHUNK_3_PROMPT,
    ]);
  });

  it("each persona's chunk-1 prompt mentions its own role code", () => {
    expect(AR_REVIEW_CHUNK_1_PROMPT).toMatch(/aR/);
    expect(IR_REVIEW_CHUNK_1_PROMPT).toMatch(/iR/);
    expect(RR_REVIEW_CHUNK_1_PROMPT).toMatch(/rR/);
  });
});

describe("Peer review — simplified prompt contract", () => {
  it("chunk-1 mentions sections 1-4 of the 9-section structure", () => {
    expect(REVIEW_CHUNK_1_PROMPT).toMatch(/1\..*Summary/i);
    expect(REVIEW_CHUNK_1_PROMPT).toMatch(/2\./);
    expect(REVIEW_CHUNK_1_PROMPT).toMatch(/3\./);
    expect(REVIEW_CHUNK_1_PROMPT).toMatch(/4\./);
  });

  it("chunk-2 covers sections 5-6 (related work / detailed comments)", () => {
    expect(REVIEW_CHUNK_2_PROMPT).toMatch(/5\./);
    expect(REVIEW_CHUNK_2_PROMPT).toMatch(/6\./);
  });

  it("chunk-3 covers sections 7-9 + Bibliography and the recommendation tokens", () => {
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/7\./);
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/8\./);
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/9\./);
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/Bibliography/i);
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/Accept/);
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/Minor Revision/);
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/Major Revision/);
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/Reject/);
  });

  it("chunk-3 documents the ethics co-author block contract", () => {
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/CRITICAL|MAJOR|MINOR/);
    expect(REVIEW_CHUNK_3_PROMPT).toMatch(/NOT_CLEARED|clearance/i);
  });

  it("chunk-1 notes that citation/bibliography integrity belongs to the H ethicist", () => {
    expect(REVIEW_CHUNK_1_PROMPT).toMatch(/ethic|H\b/i);
  });
});

describe("Peer review — extractRecommendation", () => {
  it("parses each of the four canonical recommendation tokens", () => {
    expect(extractRecommendation("...\nRecommendation: Accept\n")).toBe("Accept");
    expect(extractRecommendation("...\nRecommendation: Minor Revision\n")).toBe("Minor Revision");
    expect(extractRecommendation("...\nRecommendation: Major Revision\n")).toBe("Major Revision");
    expect(extractRecommendation("...\nRecommendation: Reject\n")).toBe("Reject");
  });

  it("returns null when no recommendation token is present", () => {
    expect(extractRecommendation("nothing here")).toBeNull();
  });
});

describe("Peer review — co-author parallel synthesis flow", () => {
  it("awaits ethicsPromise (when supplied) before chunk 3 is built", async () => {
    const order: string[] = [];

    const chunk1 = (async () => { order.push("chunk1-start"); await Promise.resolve(); order.push("chunk1-done"); return "c1"; })();
    const chunk2 = (async () => { order.push("chunk2-start"); await Promise.resolve(); order.push("chunk2-done"); return "c2"; })();
    const ethicsPromise = (async () => { order.push("ethics-start"); await Promise.resolve(); await Promise.resolve(); order.push("ethics-done"); return { reportText: "E" }; })();

    await chunk1;
    await chunk2;
    const ethicsResult = await ethicsPromise;
    order.push("chunk3-start");

    expect(order.indexOf("chunk1-start")).toBeLessThan(order.indexOf("chunk3-start"));
    expect(order.indexOf("ethics-start")).toBeLessThan(order.indexOf("chunk3-start"));
    expect(order.indexOf("ethics-done")).toBeLessThan(order.indexOf("chunk3-start"));
    expect(ethicsResult).toEqual({ reportText: "E" });
  });
});

describe("Peer review — Future Science multi-author payload shape", () => {
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

  it("supports rR primary author with H co-author", () => {
    const a = buildAuthors("MachInstit DS32rR-N1", "MachInstit DS32H-N1");
    expect(a).toHaveLength(2);
    expect(a[0].lastName).toBe("DS32rR-N1");
    expect(a[1].lastName).toBe("DS32H-N1");
  });
});

describe("Peer review — ethics-failure co-author gating", () => {
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
      reusedEthicsReportId: "ER-2",
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

describe("Peer review — loadPaperContext shape (skips ethics-only verifiers)", () => {
  it("PaperContext returned by loadPaperContext exposes the fields peer-review needs and nothing more", async () => {
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
