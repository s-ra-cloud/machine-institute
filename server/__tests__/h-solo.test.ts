import { describe, it, expect } from "vitest";
import { H_SINGLE_PAPER_PROMPT } from "../prompts/h-solo";
import {
  formatVerificationReport,
  analyzeInTextVsBibliography,
  type PaperVerification,
} from "../citation-verifier";

describe("H single-paper prompt — Bug 1: abstract / body / Section J flag-count agreement", () => {
  it("self-consistency pass requires abstract count to match body section flag count AND Section J count", () => {
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/Abstract \/ body \/ Section J flag-count agreement/i);
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/MANDATORY RECONCILIATION/);
    // Three sources of truth must be enumerated
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/total flag count in the abstract/i);
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/body sections A through I/i);
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/Section J Consolidated Flags/);
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/All three totals AND all three severity breakdowns must be identical/i);
    // Body / Section J are the source of truth, not the abstract
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/regenerate the abstract counts FROM the body section flags/i);
  });

  it("self-consistency pass requires clearance verdict to match flag count (0 flags → CLEARED only, never CLEARED WITH CONDITIONS)", () => {
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/Clearance verdict consistency with flag count/i);
    // The exact failure mode from the bug report
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/0 flags total\s*→\s*"?CLEARED"? only/i);
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/"?CLEARED WITH CONDITIONS"? is INVALID for a zero-concern paper/i);
    // Must enumerate the other tiers
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/≥1 MINOR flag\(s\), no MAJOR \/ CRITICAL/);
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/≥1 CRITICAL flag\(s\)\s*→\s*"?NOT CLEARED"?/);
  });
});

describe("H single-paper prompt — Bug 2: title mismatches route to Section A, not Section G", () => {
  it("Section A explicitly enumerates claim-gloss mismatch as failure mode #4", () => {
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/FOUR distinct failure modes/i);
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/Claim-gloss mismatches surfaced by the Semantic gloss check/i);
    // Must explicitly say it belongs in Section A, not G
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/belongs in Section A as a "claim-gloss mismatch" subcategory, NOT in Section G/);
  });

  it("ROUTING RULES block makes citation-integrity findings unconditionally Section A", () => {
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/ROUTING RULES — citation-integrity findings always go to Section A/i);
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/Regardless of which auditor sub-check produced the finding/i);
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/Section G is reserved for cases where the paper misrepresents its OWN scope/);
  });

  it("Section G explicitly forbids citation-content findings", () => {
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/Section G covers ONLY cases where the paper misrepresents its OWN scope/);
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/Section G does NOT cover misrepresentation of EXTERNAL works/);
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/that finding goes in Section A, not Section G/);
    // Gloss check is no longer used as Section G evidence
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/file it in Section A as a claim-gloss mismatch.*Do not duplicate it here/is);
  });

  it("Section A title-mismatched count consistency is enforced by self-consistency pass", () => {
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/Section A title-mismatched count agreement/i);
    // The exact failure mode from the bug report
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/"?0 title-mismatched"? alongside any prose elsewhere describing a title mismatch is a contradiction/i);
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/reconcile before emission by routing the finding into Section A and incrementing Z/i);
  });
});

describe("H single-paper prompt — Bug 4: recommendations are 1:1 with flags (no generic platitudes)", () => {
  it("self-consistency pass forbids generic best-practice recommendations not tied to a flag", () => {
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/Recommendations are 1:1 with flags/);
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/no generic platitudes/i);
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/Generic best-practice advice that is not tied to a flag actually filed against this paper is FORBIDDEN/);
    // The exact regression example from the bug report
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/Consider consolidating in-text and bibliography formatting/);
    // Must require per-recommendation flag identification
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/identify the corresponding flag by category letter and short summary/);
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/remove any recommendation that has no corresponding flag/i);
  });
});

describe("H single-paper prompt — Bug 3 surface: bibliography count instructions", () => {
  it("Section A tells the agent to take N from the verifier's bibliography-entry count, not the citation-pattern count", () => {
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/N MUST come from the verifier's "bibliography entry\/entries detected" count/);
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/multi-author entries joined by "and"\/"&" counted as one entry/);
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/It must NOT come from the verifier's "citation pattern\(s\) extracted from the full text" count/);
  });

  it("self-consistency check 2 requires bibliography-count agreement with the verifier", () => {
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/Bibliography count consistency/);
    expect(H_SINGLE_PAPER_PROMPT).toMatch(/Multi-author entries connected by "and"\/"&" inside one bibliography record count as ONE entry/);
  });
});

describe("citation-verifier — Bug 3: bibliography count is the parsed References count, not the citation-pattern count", () => {
  // Build a synthetic paper with 10 bibliography entries (some multi-author with
  // "and" / "&") and a body that cites several of them in-text. The previous
  // bug: extractCitations would pull in DOIs / arXiv IDs / (Author, Year)
  // patterns from BOTH body and bibliography and the verifier would emit
  // "12 citations detected in bibliography". The fix must report 10.
  const fullText = `
# Introduction

This paper builds on Brown et al. (2020) and Smith and Jones (2021), as well
as the foundational work of Crosbie & Shutova (2024). We extend the analysis
of Yin, Z., & Steinhardt, J. (2025) and use methods from Olsson et al. (2022).
Heimersheim and Nanda (2024) provide a complementary view, and we adopt
the framework of Müller & Dupont (2023). Vaswani et al. (2017) introduced
the transformer. Devlin et al. (2018) introduced BERT. Radford et al. (2019)
introduced GPT-2.

# References

1. Brown, T., Mann, B., Ryder, N., et al. (2020). Language models are few-shot learners. NeurIPS, 33, 1877-1901.
2. Smith, J. and Jones, K. (2021). A study of methods for evaluating language models. Journal of NLP, 12(3), 45-67.
3. Crosbie, J., & Shutova, E. (2024). Jailbreak prompts in practice. Journal of AI Safety, 1(1), 1-20.
4. Yin, Z., & Steinhardt, J. (2025). Extending alignment results. Proceedings of NeurIPS.
5. Olsson, C., Elhage, N., Nanda, N., et al. (2022). In-context learning and induction heads. Transformer Circuits Thread.
6. Heimersheim, S. and Nanda, N. (2024). Complementary mechanistic views. arXiv:2401.00001.
7. Müller, A., & Dupont, J. (2023). A French-German collaboration. Journal X, 5, 1-10.
8. Vaswani, A., Shazeer, N., Parmar, N., et al. (2017). Attention is all you need. NeurIPS, 30, 5998-6008.
9. Devlin, J., Chang, M., Lee, K., and Toutanova, K. (2018). BERT: Pre-training of deep bidirectional transformers. NAACL, 4171-4186.
10. Radford, A., Wu, J., Child, R., et al. (2019). Language models are unsupervised multitask learners. OpenAI Technical Report.
`;

  it("analyzeInTextVsBibliography reports exactly 10 bibliography entries (not 12+) for the test paper", () => {
    const a = analyzeInTextVsBibliography(fullText);
    expect(a.bibliographyDetected).toBe(true);
    expect(a.bibliographyCount).toBe(10);
  });

  it("formatVerificationReport reports the parsed bibliography count when supplied, not citations.length", () => {
    const verification: PaperVerification = {
      paperTitle: "test",
      hadFullText: true,
      // 12 citation patterns extracted (including in-text matches) — must NOT
      // be reported as bibliography count.
      citations: Array.from({ length: 12 }, (_, i) => ({
        raw: `cite-${i}`,
        verifiedSource: "none" as const,
      })),
    };
    const out = formatVerificationReport(verification, 10);
    expect(out).toMatch(/10 bibliography entry\/entries detected/);
    expect(out).toMatch(/12 citation pattern\(s\) extracted from the full text for verification/);
    // The over-counted "12 citations detected in bibliography" pattern must NOT appear
    expect(out).not.toMatch(/12 citation\(s\) detected\b/);
  });

  it("formatVerificationReport falls back to a clearly-labelled pattern count when no bibliography section is detected", () => {
    const verification: PaperVerification = {
      paperTitle: "test",
      hadFullText: true,
      citations: [{ raw: "cite-0", verifiedSource: "none" as const }],
    };
    const out = formatVerificationReport(verification);
    expect(out).toMatch(/no bibliography section heading detected/);
    expect(out).toMatch(/bibliography size unknown/);
  });
});
