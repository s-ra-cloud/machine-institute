import { describe, it, expect, vi } from "vitest";

// paper-catalogue imports storage → db, which requires DATABASE_URL at import
// time; the pure helpers under test never touch the database.
vi.mock("../storage", () => ({ storage: {} }));

import {
  parseJudgeOutput,
  deriveOverallVerdict,
  countVerdicts,
  verdictsToRevisions,
  verdictsFromRecordedResults,
  buildReproductionTitle,
  buildReproductionAbstract,
  buildReproductionMarkdown,
  REPRODUCER_PROMPT,
  JUDGE_PROMPT,
  type ClaimVerdict,
} from "../prompts/reproduce";
import { isOwnPublication } from "../paper-catalogue";
import { buildConventionName, buildFsAgentDescription } from "../agent-naming";
import { normalizeRevisions, _FS_TYPE_FALLBACKS_FOR_TEST } from "../future-science";

const sample: ClaimVerdict[] = [
  { id: "R1", claim: "Cohen's d = 1.25", verdict: "verified", originalValue: "1.25", reproducedValue: "1.24" },
  { id: "R2", claim: "Kendall tau = 1.0", verdict: "falsified", originalValue: "1.0", reproducedValue: "0.6" },
  { id: "R3", claim: "29 heads carry 50% of signal", verdict: "toy" },
  { id: "R4", claim: "d = 31.1 in decomposition", verdict: "inconclusive" },
];

describe("Reproduction — judge output parsing", () => {
  it("parses a fenced JSON block with the hackathon verdict scale", () => {
    const text = `Here is my grading.\n\`\`\`json\n{"summary": "Two of four held.", "results": [{"id":"R1","claim":"d = 1.25","verdict":"Verified","original_value":"1.25","reproduced_value":"1.24","evidence":"analysis_3","confidence":"high"},{"id":"R2","claim":"tau = 1.0","verdict":"FALSIFIED","confidence":"medium"}]}\n\`\`\``;
    const parsed = parseJudgeOutput(text);
    expect(parsed.summary).toBe("Two of four held.");
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0]).toMatchObject({ id: "R1", verdict: "verified", originalValue: "1.25", reproducedValue: "1.24", confidence: "high" });
    expect(parsed.results[1].verdict).toBe("falsified");
  });

  it("parses a bare JSON object without a fence and maps unknown verdicts to inconclusive", () => {
    const parsed = parseJudgeOutput(`{"summary":"s","results":[{"id":"R1","claim":"c","verdict":"maybe"}]}`);
    expect(parsed.results[0].verdict).toBe("inconclusive");
  });

  it("returns empty results on unparseable output", () => {
    expect(parseJudgeOutput("no json here")).toEqual({ summary: "", results: [] });
    expect(parseJudgeOutput("```json\n{broken\n```")).toEqual({ summary: "", results: [] });
  });

  it("falls back to the agent's recorded statuses, mapping pending to inconclusive", () => {
    const out = verdictsFromRecordedResults([
      { id: "R1", claim: "a", status: "verified" },
      { id: "R2", claim: "b", status: "pending" },
    ]);
    expect(out.map(r => r.verdict)).toEqual(["verified", "inconclusive"]);
  });
});

describe("Reproduction — paper-level verdict", () => {
  it("any falsified result marks the paper falsified", () => {
    expect(deriveOverallVerdict(sample)).toBe("falsified");
  });
  it("all verified → verified; some verified → partially verified", () => {
    expect(deriveOverallVerdict([sample[0], { ...sample[0], id: "R9" }])).toBe("verified");
    expect(deriveOverallVerdict([sample[0], sample[2]])).toBe("partially verified");
  });
  it("toy-only → toy; nothing → inconclusive", () => {
    expect(deriveOverallVerdict([sample[2]])).toBe("toy");
    expect(deriveOverallVerdict([sample[3]])).toBe("inconclusive");
    expect(deriveOverallVerdict([])).toBe("inconclusive");
  });
  it("counts each verdict", () => {
    expect(countVerdicts(sample)).toEqual({ total: 4, verified: 1, falsified: 1, toy: 1, inconclusive: 1 });
  });
});

describe("Reproduction — Future Science revisions", () => {
  it("maps falsified to major and toy/inconclusive to minor, verified to neither", () => {
    const { major, minor } = verdictsToRevisions(sample);
    expect(major).toHaveLength(1);
    expect(major[0].description).toContain("R2");
    expect(major[0].description).toContain("reported: 1.0");
    expect(minor.map(m => m.description.slice(0, 2))).toEqual(["R3", "R4"]);
  });
  it("produces revisions that survive FS normalisation", () => {
    const { major } = verdictsToRevisions(sample);
    expect(normalizeRevisions(major)).toHaveLength(1);
  });
  it("reproduction reports lead with the response-style FS type", () => {
    expect(_FS_TYPE_FALLBACKS_FOR_TEST.reproduction[0]).toBe("Response to a contribution");
  });
});

describe("Reproduction — report composition", () => {
  it("builds a title the catalogue filter recognises as an institute publication", () => {
    const title = buildReproductionTitle("Safety Heads Are Relational Assessment Heads");
    expect(title).toBe('Reproduction Report: "Safety Heads Are Relational Assessment Heads"');
    expect(isOwnPublication(title, "Some Author")).toBe(true);
  });
  it("recognises the P agent code as an institute author", () => {
    expect(isOwnPublication("Anything", buildConventionName("anthropic/claude-sonnet-4-5", "P"))).toBe(true);
    expect(buildConventionName("anthropic/claude-sonnet-4-5", "P")).toBe("MachInstit CS45P-N1");
  });
  it("stamps the judge model and sandbox into the FS agent description", () => {
    const desc = buildFsAgentDescription({ model: "openai/gpt-5", agentId: "P", providerMode: "platform", extra: ["Judge model: deepseek/deepseek-chat", "Sandbox: Modal A10G"] });
    expect(desc).toContain("Agent: P (Reproduction Agent)");
    expect(desc).toContain("Judge model: deepseek/deepseek-chat");
    expect(desc).toContain("Sandbox: Modal A10G");
  });
  it("writes a substantive abstract under the FS length cap", () => {
    const abstract = buildReproductionAbstract({ paperTitle: "T", overall: "falsified", counts: countVerdicts(sample), summary: "One result did not hold.", gpu: "A10G", realExecution: true });
    expect(abstract).toContain("overall verdict: falsified");
    expect(abstract).toContain("1 verified, 1 falsified, 1 toy-scale, 1 inconclusive");
    expect(abstract).toContain("A10G");
    expect(abstract.length).toBeLessThanOrEqual(1200);
  });
  it("renders every result, the logbook, and the executed commands in the markdown", () => {
    const md = buildReproductionMarkdown({
      paperTitle: "T", paperAuthors: "A", paperDate: "2026-01-01", paperUrl: "https://future-science.org/mirror/x", journalDisplayName: "Mirror",
      overall: "falsified", results: sample, judgeSummary: "Judge says.", logbook: "## Claims\n- R1", materialsInventory: "- /work/materials/README.md",
      materialsCounts: { text: 3, binary: 2 },
      environment: { gpu: "A10G", image: "img", reproducerModel: "m", judgeModel: "j", maxToolCalls: 100, wallClockMinutes: 120, perCommandMinutes: 15 },
      toolCalls: [
        { index: 1, name: "read_file", args: { path: "/work/paper.md" }, durationMs: 100, error: false, resultPreview: "..." },
        { index: 2, name: "run_command", args: { command: "python 01.py" }, durationMs: 61000, error: false, resultPreview: "exit code 0" },
      ],
      stoppedBy: "model", sandboxAvailable: true,
    });
    for (const r of sample) expect(md).toContain(`### ${r.id}`);
    expect(md).toContain("Judge says.");
    expect(md).toContain("## Reproduction Logbook");
    expect(md).toContain("`python 01.py`");
    expect(md).toContain("Modal GPU sandbox (A10G)");
  });
  it("prompts describe the four-verdict scale and the logbook contract", () => {
    for (const v of ["verified", "falsified", "toy", "inconclusive"]) {
      expect(REPRODUCER_PROMPT).toContain(v);
      expect(JUDGE_PROMPT).toContain(v);
    }
    expect(REPRODUCER_PROMPT).toContain("## Reproduction Log");
    expect(JUDGE_PROMPT).toContain("```json");
  });
});
