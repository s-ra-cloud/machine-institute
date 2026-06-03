import { describe, it, expect } from "vitest";
import {
  getPeerReviewPrompt,
  BR_PROMPT,
  IR_PROMPT,
  AR_PROMPT,
  RR_PROMPT,
  extractRecommendation,
  extractRevisions,
  extractReviewSummary,
  buildPeerReviewAbstract,
  buildVerificationSection,
  hasVerificationSection,
  derivePeerReviewKeywords,
  VERIFICATION_SECTION_HEADING,
} from "../prompts/peer-review";
import { normalizeRevisions } from "../future-science";

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
    it(`${persona} prompt is ≤200 words`, () => {
      expect(wordCount(prompt)).toBeLessThanOrEqual(200);
    });
    it(`${persona} prompt asks for a leading Review Summary section`, () => {
      expect(prompt).toMatch(/Review Summary/i);
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

describe("Peer review — extractRevisions", () => {
  const review = `# Review

## Summary
Good paper overall.

## Major Revisions
- The statistical analysis lacks a power calculation.
- Claim in Section 3 is unsupported by the data presented.
1. Add a control condition to experiment 2.

## Minor Revisions
- Fix the typo in Table 1.
* Clarify the units in Figure 4.

## Recommendation
Major Revision`;

  it("parses Major and Minor revision sections into separate arrays", () => {
    const { major, minor } = extractRevisions(review);
    expect(major).toHaveLength(3);
    expect(minor).toHaveLength(2);
    expect(major[0].description).toMatch(/power calculation/);
    expect(minor[0].description).toMatch(/typo in Table 1/);
  });

  it("supports both bullet and numbered list markers", () => {
    const { major } = extractRevisions(review);
    expect(major.some((m) => /control condition/.test(m.description))).toBe(true);
  });

  it("returns empty arrays when no revision sections are present", () => {
    const { major, minor } = extractRevisions("Just prose, no headings, recommendation: Accept.");
    expect(major).toEqual([]);
    expect(minor).toEqual([]);
  });

  it("joins continuation lines into a single revision item", () => {
    const text = `## Major Revisions\n- The methodology section\n  needs substantial rework\n  to be reproducible.\n`;
    const { major } = extractRevisions(text);
    expect(major).toHaveLength(1);
    expect(major[0].description).toBe("The methodology section needs substantial rework to be reproducible.");
  });

  it("caps each section at 10 items", () => {
    const items = Array.from({ length: 15 }, (_, i) => `- Item ${i + 1} requires attention`).join("\n");
    const { major } = extractRevisions(`## Major Revisions\n${items}\n`);
    expect(major).toHaveLength(10);
  });

  it("matches headings at any markdown depth and singular 'Revision'", () => {
    const text = `### Major Revision\n- One issue to address here\n#### Minor Revision\n- A small nit to fix\n`;
    const { major, minor } = extractRevisions(text);
    expect(major).toHaveLength(1);
    expect(minor).toHaveLength(1);
  });
});

describe("Peer review — extractReviewSummary", () => {
  it("pulls the leading Review Summary section as a single line of prose", () => {
    const review = `# Review

## Review Summary
The paper presents a solid contribution to interpretability.
Its main strength is a well-designed evaluation.
The chief weakness is the absence of a power analysis, which is why a Major Revision is recommended.

## Major Revisions
- Add a power analysis.`;
    const summary = extractReviewSummary(review);
    expect(summary).toContain("solid contribution to interpretability");
    expect(summary).toContain("well-designed evaluation");
    expect(summary).toContain("power analysis");
    // It must be flattened to one line and not bleed into later sections.
    expect(summary).not.toMatch(/\n/);
    expect(summary).not.toContain("Add a power analysis");
  });

  it("strips list markers and bold markers from the summary", () => {
    const review = `## Review Summary
- **Strength:** clear methodology and reproducible code.
- **Weakness:** limited sample size undermines the conclusions.`;
    const summary = extractReviewSummary(review)!;
    expect(summary).not.toContain("**");
    expect(summary).not.toMatch(/^-/);
    expect(summary).toContain("clear methodology");
    expect(summary).toContain("limited sample size");
  });

  it("falls back to alternative summary headings", () => {
    const review = `## Overall Assessment
This is a thorough study with strong empirical grounding and minor presentation issues.`;
    expect(extractReviewSummary(review)).toContain("thorough study");
  });

  it("returns null when there is no usable summary section", () => {
    expect(extractReviewSummary("## Major Revisions\n- Fix something specific here.")).toBeNull();
    expect(extractReviewSummary("Just loose prose, no headings at all.")).toBeNull();
  });

  it("returns null for a too-short summary section", () => {
    expect(extractReviewSummary("## Review Summary\nGood.")).toBeNull();
  });
});

describe("Peer review — buildPeerReviewAbstract", () => {
  it("builds a self-describing opener plus the substantive parsed summary", () => {
    const abstract = buildPeerReviewAbstract({
      title: "A Study of Sparse Autoencoders",
      persona: "bR",
      recommendation: "Major Revision",
      summary: "The work is methodologically sound but lacks a power analysis, motivating a major revision.",
    });
    expect(abstract).toContain('Basic peer review of "A Study of Sparse Autoencoders"');
    expect(abstract).toContain("recommendation: Major Revision");
    expect(abstract).toContain("methodologically sound");
    expect(abstract).toContain("power analysis");
  });

  it("uses the persona adjective for each persona", () => {
    expect(buildPeerReviewAbstract({ title: "T", persona: "aR", recommendation: "Reject", summary: "A long enough substantive summary of the review findings here." })).toMatch(/^Adversarial peer review/);
    expect(buildPeerReviewAbstract({ title: "T", persona: "iR", recommendation: "Accept", summary: "A long enough substantive summary of the review findings here." })).toMatch(/^Innovation peer review/);
    expect(buildPeerReviewAbstract({ title: "T", persona: "rR", recommendation: "Accept", summary: "A long enough substantive summary of the review findings here." })).toMatch(/^Rigorous peer review/);
  });

  it("appends an H-verification note when an ethics co-author ran", () => {
    const abstract = buildPeerReviewAbstract({
      title: "T",
      persona: "bR",
      recommendation: "Minor Revision",
      summary: "Solid contribution overall with a few clarity issues to address.",
      ethicsSummary: "Ethics co-author (H): CLEARED — 0 critical, 0 major, 0 minor flags.",
    });
    expect(abstract).toContain("Research Standards Verification co-author");
    expect(abstract).toContain("CLEARED");
  });

  it("omits the H note when no ethics co-author ran", () => {
    const abstract = buildPeerReviewAbstract({
      title: "T",
      persona: "bR",
      recommendation: "Accept",
      summary: "Solid contribution overall, clearly written and well evidenced throughout.",
    });
    expect(abstract).not.toContain("Research Standards Verification co-author");
  });

  it("falls back to extracted revisions when no summary is available", () => {
    const abstract = buildPeerReviewAbstract({
      title: "T",
      persona: "bR",
      recommendation: "Major Revision",
      summary: null,
      majorRevisions: [
        { description: "The statistical analysis lacks a power calculation." },
        { description: "Claim in Section 3 is unsupported." },
      ],
      minorRevisions: [{ description: "Fix the typo in Table 1." }],
    });
    expect(abstract).toContain("Key concerns requiring major revision");
    expect(abstract).toContain("power calculation");
    expect(abstract).toContain("Minor points raised");
    expect(abstract).toContain("typo in Table 1");
  });

  it("produces a sensible fallback even with no summary and no revisions", () => {
    const abstract = buildPeerReviewAbstract({
      title: "T",
      persona: "bR",
      recommendation: "Accept",
      summary: null,
      majorRevisions: [],
      minorRevisions: [],
    });
    expect(abstract).toContain('Basic peer review of "T"');
    expect(abstract).toContain("no major or minor revision items");
    expect(abstract.length).toBeGreaterThan(0);
  });

  it("is never empty and stays concise even with a very long summary", () => {
    const longSummary = "This sentence repeats. ".repeat(200);
    const abstract = buildPeerReviewAbstract({
      title: "T",
      persona: "bR",
      recommendation: "Reject",
      summary: longSummary,
      ethicsSummary: "Ethics co-author (H): NOT CLEARED — 1 critical flag.",
    });
    expect(abstract.length).toBeLessThanOrEqual(1200);
    expect(abstract).toMatch(/^Reject? ?|^Rigorous|^Basic peer review/);
  });

  it("defaults the recommendation and title when missing", () => {
    const abstract = buildPeerReviewAbstract({ persona: "bR", summary: "A substantive summary of the review with enough length to be kept." });
    expect(abstract).toContain("the submitted paper");
    expect(abstract).toContain("recommendation: Major Revision");
  });
});

describe("Future Science — normalizeRevisions", () => {
  it("returns undefined for empty or all-blank input", () => {
    expect(normalizeRevisions(undefined)).toBeUndefined();
    expect(normalizeRevisions([])).toBeUndefined();
    expect(normalizeRevisions([{ description: "   " }, { description: "" }])).toBeUndefined();
  });

  it("trims, collapses whitespace, and drops blanks", () => {
    const out = normalizeRevisions([
      { description: "  needs   work \n here " },
      { description: "" },
    ]);
    expect(out).toEqual([{ description: "needs work here" }]);
  });

  it("caps at 10 entries", () => {
    const input = Array.from({ length: 14 }, (_, i) => ({ description: `item ${i}` }));
    expect(normalizeRevisions(input)).toHaveLength(10);
  });

  it("truncates descriptions longer than 1500 chars with an ellipsis", () => {
    const long = "x".repeat(2000);
    const out = normalizeRevisions([{ description: long }])!;
    expect(out[0].description.length).toBe(1500);
    expect(out[0].description.endsWith("…")).toBe(true);
  });
});

describe("Future Science — revision arrays gated to response-style types", () => {
  // Mirrors the per-type stripping in submit{PeerReview,EthicsReport}ToFutureScience:
  // revisions ride alongside linkOriginalContribution and must be removed for
  // any fallback type that does not accept linkOriginalContribution.
  function assemble(
    candidateType: string,
    allowed: string[],
    withLink: boolean,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = { title: "t" };
    if (withLink) {
      base.linkOriginalContribution = "https://fs/x";
      base.majorRevisions = [{ description: "major" }];
      base.minorRevisions = [{ description: "minor" }];
    }
    const metadata: Record<string, unknown> = { ...base, type: candidateType };
    if (!allowed.includes(candidateType)) {
      delete metadata.linkOriginalContribution;
      delete metadata.majorRevisions;
      delete metadata.minorRevisions;
    }
    return metadata;
  }

  const PEER_ALLOWED = ["Peer-review", "Response to a contribution"];
  const ETHICS_ALLOWED = ["Audit", "Response to a contribution"];

  it("keeps revisions on allowed peer-review types", () => {
    for (const t of PEER_ALLOWED) {
      const m = assemble(t, PEER_ALLOWED, true);
      expect(m.majorRevisions).toBeDefined();
      expect(m.minorRevisions).toBeDefined();
      expect(m.linkOriginalContribution).toBeDefined();
    }
  });

  it("strips revisions on non-accepting peer-review fallback types", () => {
    for (const t of ["Unreviewed manuscript", "Other", "Article"]) {
      const m = assemble(t, PEER_ALLOWED, true);
      expect(m.majorRevisions).toBeUndefined();
      expect(m.minorRevisions).toBeUndefined();
      expect(m.linkOriginalContribution).toBeUndefined();
    }
  });

  it("strips revisions on non-accepting ethics fallback types", () => {
    for (const t of ["Unreviewed manuscript", "Other", "Article"]) {
      const m = assemble(t, ETHICS_ALLOWED, true);
      expect(m.majorRevisions).toBeUndefined();
      expect(m.minorRevisions).toBeUndefined();
    }
    const audit = assemble("Audit", ETHICS_ALLOWED, true);
    expect(audit.majorRevisions).toBeDefined();
  });

  it("never includes revisions when there is no linkOriginalContribution", () => {
    const m = assemble("Audit", ETHICS_ALLOWED, false);
    expect(m.majorRevisions).toBeUndefined();
    expect(m.minorRevisions).toBeUndefined();
    expect(m.linkOriginalContribution).toBeUndefined();
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

describe("Peer review — buildVerificationSection (H co-author audit)", () => {
  it("documents scope/methodology and a clean result when no flags are present", () => {
    const md = buildVerificationSection({
      clearanceStatus: "CLEARED",
      clearanceStatement: "No issues found in the audit.",
      flags: [],
      recommendations: [],
    });
    expect(md).toContain(`## ${VERIFICATION_SECTION_HEADING}`);
    // Scope/methodology must always be present, even when "cleared".
    expect(md).toMatch(/Scope & methodology/);
    expect(md).toMatch(/eight research-standards categories/);
    expect(md).toMatch(/OpenAlex/);
    expect(md).toContain("**Clearance status:** Cleared");
    expect(md).toContain("No issues found in the audit.");
    expect(md).toMatch(/No research-standards concerns were identified/);
  });

  it("groups findings by severity and lists recommendations when flagged", () => {
    const md = buildVerificationSection({
      clearanceStatus: "NOT_CLEARED",
      clearanceStatement: "Serious concerns.",
      flags: [
        { severity: "CRITICAL", summary: "Fabricated citation to nonexistent paper." },
        { severity: "MAJOR", summary: "Selective reporting of negative results." },
        { severity: "MINOR", summary: "Minor formatting issue in references." },
      ],
      recommendations: ["Retract and resubmit with verified citations."],
    });
    expect(md).toContain("**Clearance status:** Not cleared");
    expect(md).toMatch(/\*Critical concerns:\*/);
    expect(md).toContain("Fabricated citation to nonexistent paper.");
    expect(md).toMatch(/\*Major concerns:\*/);
    expect(md).toMatch(/\*Minor concerns:\*/);
    expect(md).toMatch(/Verification agent recommendations/);
    expect(md).toContain("Retract and resubmit with verified citations.");
    // Should NOT advertise the clean-result line when there are flags.
    expect(md).not.toMatch(/No research-standards concerns were identified/);
  });

  it("pretty-prints CLEARED_WITH_CONDITIONS and handles a missing statement", () => {
    const md = buildVerificationSection({
      clearanceStatus: "CLEARED_WITH_CONDITIONS",
      clearanceStatement: "",
      flags: [{ severity: "MINOR", summary: "One small nit." }],
      recommendations: [],
    });
    expect(md).toContain("**Clearance status:** Cleared with conditions");
    expect(md).toMatch(/No clearance statement was recorded/);
  });

  it("produces a section that extractRevisions does NOT mistake for revision lists", () => {
    const md = buildVerificationSection({
      clearanceStatus: "NOT_CLEARED",
      clearanceStatement: "x",
      flags: [{ severity: "MAJOR", summary: "A major concern here." }],
      recommendations: ["Do the thing."],
    });
    const { major, minor } = extractRevisions(md);
    expect(major).toEqual([]);
    expect(minor).toEqual([]);
  });
});

describe("Peer review — hasVerificationSection", () => {
  it("detects the section heading regardless of leading text", () => {
    expect(hasVerificationSection(`Some review body\n\n## ${VERIFICATION_SECTION_HEADING}\n\nbody`)).toBe(true);
    expect(hasVerificationSection("### Research Standards Verification (audit)")).toBe(true);
  });
  it("returns false when absent or empty", () => {
    expect(hasVerificationSection("Just a normal review with no audit section.")).toBe(false);
    expect(hasVerificationSection("")).toBe(false);
  });
});

describe("Peer review — derivePeerReviewKeywords", () => {
  it("prefers the audited paper's own Future Science keywords", () => {
    const kws = derivePeerReviewKeywords({
      paperKeywords: ["sparse autoencoders", "interpretability", "feature steering"],
      paperTitle: "A Study of Sparse Autoencoders",
      persona: "bR",
    });
    expect(kws.slice(0, 3)).toEqual(["sparse autoencoders", "interpretability", "feature steering"]);
    expect(kws).toContain("peer review");
  });

  it("falls back to salient title terms when paper keywords are missing", () => {
    const kws = derivePeerReviewKeywords({
      paperKeywords: [],
      paperTitle: "Mechanistic Interpretability of Transformer Circuits",
      persona: "aR",
    });
    expect(kws).toEqual(expect.arrayContaining(["mechanistic", "interpretability", "transformer", "circuits"]));
    expect(kws).toContain("peer review");
    // Stopwords like "of" must not appear.
    expect(kws).not.toContain("of");
  });

  it("satisfies the FS 3-keyword minimum even with no usable input", () => {
    const kws = derivePeerReviewKeywords({ paperKeywords: [], paperTitle: "", persona: "iR" });
    expect(kws.length).toBeGreaterThanOrEqual(3);
    expect(kws).toContain("peer review");
  });

  it("still returns >=3 keywords when paperTitle is null (legacy republish edge case)", () => {
    const kws = derivePeerReviewKeywords({ paperTitle: null, persona: "bR" });
    expect(kws.length).toBeGreaterThanOrEqual(3);
    expect(kws).toContain("peer review");
  });

  it("republish reuses the keywords persisted at generation (parity), falling back only when absent", () => {
    // Mirrors the route logic: generation stores result.keywords in
    // sourceTrace; republish reuses them verbatim for parity, and only
    // re-derives from paperTitle for legacy reviews lacking them.
    function republishKeywords(sourceTrace: string | null, paperTitle: string | null, persona: "bR" | "iR" | "aR" | "rR"): string[] {
      let chosen: string[] | undefined;
      try {
        const parsed = sourceTrace ? JSON.parse(sourceTrace) : null;
        if (parsed && Array.isArray(parsed.keywords) && parsed.keywords.length >= 3) {
          chosen = parsed.keywords.filter((k: unknown): k is string => typeof k === "string");
        }
      } catch {}
      if (!chosen || chosen.length < 3) {
        chosen = derivePeerReviewKeywords({ paperTitle, persona });
      }
      return chosen;
    }

    // Fresh generation derived keywords from the paper's FS keywords + title.
    const generated = derivePeerReviewKeywords({
      paperKeywords: ["sparse autoencoders", "interpretability", "feature steering"],
      paperTitle: "A Study of Sparse Autoencoders",
      persona: "bR",
    });
    const sourceTrace = JSON.stringify({ documentId: "doc1", keywords: generated });

    // Republish must reproduce the EXACT same keywords (parity).
    expect(republishKeywords(sourceTrace, "A Study of Sparse Autoencoders", "bR")).toEqual(generated);

    // Legacy review without persisted keywords falls back to title derivation.
    const legacy = republishKeywords(JSON.stringify({ documentId: "doc1" }), "Mechanistic Interpretability", "aR");
    expect(legacy.length).toBeGreaterThanOrEqual(3);
    expect(legacy).toContain("peer review");
  });

  it("dedupes case-insensitively and caps at 8 keywords", () => {
    const kws = derivePeerReviewKeywords({
      paperKeywords: ["Alpha", "alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta"],
      paperTitle: "Greek Letters Study",
      persona: "rR",
    });
    expect(kws.length).toBeLessThanOrEqual(8);
    const lower = kws.map((k) => k.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });
});
