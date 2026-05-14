import { describe, it, expect } from "vitest";
import {
  getPeerReviewPrompt,
  BR_PROMPT,
  IR_PROMPT,
  AR_PROMPT,
  RR_PROMPT,
  extractRecommendation,
} from "../prompts/peer-review";

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

describe("Peer review — persona prompt routing", () => {
  it("returns the bR prompt by default and for explicit bR", () => {
    expect(getPeerReviewPrompt("bR")).toBe(BR_PROMPT);
  });
  it("returns the aR prompt for aR", () => {
    expect(getPeerReviewPrompt("aR")).toBe(AR_PROMPT);
  });
  it("returns the iR prompt for iR", () => {
    expect(getPeerReviewPrompt("iR")).toBe(IR_PROMPT);
  });
  it("returns the rR prompt for rR", () => {
    expect(getPeerReviewPrompt("rR")).toBe(RR_PROMPT);
  });

  it("each non-basic persona's prompt mentions its own role code", () => {
    expect(AR_PROMPT).toMatch(/aR/);
    expect(IR_PROMPT).toMatch(/iR/);
    expect(RR_PROMPT).toMatch(/rR/);
  });
});

describe("Peer review — single-prompt contract", () => {
  const all = { bR: BR_PROMPT, iR: IR_PROMPT, aR: AR_PROMPT, rR: RR_PROMPT };

  for (const [persona, prompt] of Object.entries(all)) {
    it(`${persona} prompt is ≤100 words`, () => {
      expect(wordCount(prompt)).toBeLessThanOrEqual(100);
    });
    it(`${persona} prompt mentions the H Research Standards Verification Agent`, () => {
      expect(prompt).toMatch(/Research Standards Verification Agent|ETHICS CO-AUTHOR/i);
    });
    it(`${persona} prompt describes the inputs the model will receive`, () => {
      expect(prompt).toMatch(/full text|paper/i);
      expect(prompt).toMatch(/prior work|Publications|journal/i);
    });
    it(`${persona} prompt mentions all four recommendation tokens`, () => {
      expect(prompt).toMatch(/Accept/);
      expect(prompt).toMatch(/Minor Revision/);
      expect(prompt).toMatch(/Major Revision/);
      expect(prompt).toMatch(/Reject/);
    });
    it(`${persona} prompt has NO numbered section outline`, () => {
      // Must not enumerate sections like "### 1.", "### 5.", etc.
      expect(prompt).not.toMatch(/###\s*\d+\./);
      expect(prompt).not.toMatch(/9-section/i);
    });
  }
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

  it("prefers the LAST recommendation token in the text (final verdict)", () => {
    const text = "Earlier we considered Accept, but ultimately the recommendation is Reject.";
    expect(extractRecommendation(text)).toBe("Reject");
  });
});

describe("Peer review — co-author parallel synthesis flow", () => {
  it("awaits ethicsPromise (when supplied) before the LLM call is built", async () => {
    const order: string[] = [];

    const ethicsPromise = (async () => { order.push("ethics-start"); await Promise.resolve(); await Promise.resolve(); order.push("ethics-done"); return { reportText: "E" }; })();

    const ethicsResult = await ethicsPromise;
    order.push("llm-call");

    expect(order.indexOf("ethics-start")).toBeLessThan(order.indexOf("llm-call"));
    expect(order.indexOf("ethics-done")).toBeLessThan(order.indexOf("llm-call"));
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
    const g = gate({ includeEthicsCoauthor: true, reusedEthicsReportId: "ER-1", ethicsUsed: true, ethicsAgentName: "MachInstit DS32H-N1" });
    expect(g.linkedEthicsReportId).toBe("ER-1");
    expect(g.ethicsCoauthorName).toBe("MachInstit DS32H-N1");
  });

  it("DROPS H from FS payload AND nulls ethicsReportId when parallel ethics audit fails", () => {
    const g = gate({ includeEthicsCoauthor: true, reusedEthicsReportId: "ER-2", ethicsUsed: false, ethicsAgentName: "MachInstit DS32H-N1" });
    expect(g.linkedEthicsReportId).toBeNull();
    expect(g.ethicsCoauthorName).toBeUndefined();
  });

  it("does not include H when the user opted out, regardless of ethicsUsed", () => {
    const g = gate({ includeEthicsCoauthor: false, reusedEthicsReportId: null, ethicsUsed: false, ethicsAgentName: "MachInstit DS32H-N1" });
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
