import { describe, it, expect } from "vitest";
import { QuestioningState, questioningSetupCommand, type SuitabilityAssessment } from "../reproduction-questioning";
import { ReproductionSession } from "../reproduction-session";
import { buildEffectiveReproducerPrompt, getReproducerPrompt, getJudgePrompt, REPRODUCER_PROMPT } from "../prompts/reproduce";
import type { ToolCallRecord } from "../model-service";

const question = "Does the estimator recover the population mean without bias?";
const inventory = "Shipped materials contain estimator.py and observations.csv";
const code = "print(sum(observations) / len(observations))";
const claims = [{ id: "R1", claim: "The mean is unbiased", status: "pending" as const }];
const calls: ToolCallRecord[] = [question, inventory, code].map((result, i) => ({
  index: i + 1, name: "read_file", args: { path: ["/work/paper.md", "/work/MATERIALS_INDEX.md", "/work/materials/estimator.py"][i] },
  result, durationMs: 1,
}));
function assessment(decision: SuitabilityAssessment["decision"] = "adapt"): SuitabilityAssessment {
  return { research_question: question, question_quote: question, decision, rationale: "The estimator must weight observations to match the sample design.", claim_ids: ["R1"],
    evidence: calls.map(c => ({ tool_call_id: c.index, excerpt: c.result })),
    intended_changes: "Use design weights instead of an unweighted sample mean.", comparability: "Changed estimand implementation is not an original reproduction.",
    planned_changes: [{ path: "/work/working/materials/estimator.py", reason: "Account for unequal sampling probabilities.", claim_ids: ["R1"] }] };
}
function state() {
  const q = new QuestioningState();
  q.addOriginal("/work/paper.md", question);
  q.addOriginal("/work/MATERIALS_INDEX.md", inventory);
  q.addOriginal("/work/materials/estimator.py", code);
  return q;
}
describe("qP authoritative assessment and provenance", () => {
  it("gates every arbitrary execution and write, not a shell classification", () => {
    const q = state();
    for (const command of ["ls", "pip install numpy", "python x.py", "echo safe; python x.py", "$(base64 -d x)"])
      expect(q.gate("run_command"), command).toContain("inspection only");
    expect(q.gate("write_file")).toContain("inspection only");
    expect(q.gate("read_file")).toBeUndefined();
    expect(q.gate("list_files")).toBeUndefined();
  });
  it("rejects fabricated evidence, unsupported claims and absent material inspections", () => {
    for (const bad of [
      { ...assessment(), evidence: [{ tool_call_id: 999, excerpt: question }] },
      { ...assessment(), claim_ids: ["unregistered"] },
      { ...assessment(), question_quote: "A completely invented question unrelated to the paper" },
      { ...assessment(), evidence: assessment().evidence.slice(0, 1) },
      { ...assessment(), planned_changes: [{ path: "/work/working/../paper.md", reason: "Rewrite the research objective", claim_ids: ["R1"] }] },
    ]) {
      const q = state();
      expect(q.assess(JSON.stringify(bad), calls, claims)).toMatch(/^Refused:/);
      expect(q.assessment).toBeUndefined();
      expect(q.gate("run_command")).toBeTruthy();
    }
  });
  it("uses suitable code unchanged and commits an immutable assessment", () => {
    const q = state();
    expect(q.assess(JSON.stringify(assessment("suitable")), calls, claims)).toContain("committed");
    expect(q.gate("run_command")).toBeUndefined();
    expect(q.write("/work/working/materials/estimator.py", "changed", "An unnecessary scientific modification")).toContain("unchanged");
    expect(q.assess(JSON.stringify(assessment()), calls, claims)).toContain("already committed");
    expect(q.constrainOriginalVerdicts([{ id: "R1", claim: "c", verdict: "verified" }])[0].verdict).toBe("verified");
  });
  it("allows only planned working-copy edits and captures immutable executed versions", () => {
    const q = state();
    q.assess(JSON.stringify(assessment()), calls, claims);
    expect(q.gate("run_command")).toContain("apply every planned adaptation");
    for (const path of ["/work/paper.md", "/work/materials/estimator.py", "/work/working/../paper.md", "/work/working/materials/unplanned.py"])
      expect(q.write(path, "changed", "Scientifically motivated weighting correction")).toMatch(/^Refused:/);
    expect(q.write("/work/working/materials/estimator.py", "weighted_mean(data)", "Account for unequal sampling probabilities")).toBeUndefined();
    expect(q.gate("run_command")).toBeUndefined();
    const execution = q.snapshot("python materials/estimator.py");
    q.write("/work/working/materials/estimator.py", "later_version(data)", "Improve weighting numerical stability");
    expect(q.readBlob(q.originals["/work/materials/estimator.py"])).toBe(code);
    expect(q.readBlob(execution.files[`${execution.snapshot}/materials/estimator.py`])).toBe("weighted_mean(data)");
    expect(q.changes[0].claimIds).toEqual(["R1"]);
    expect(q.constrainOriginalVerdicts([{ id: "R1", claim: "c", verdict: "falsified" }])[0].verdict).toBe("inconclusive");
  });
  it("safe setup accepts only fixed package names and binary wheels without dependencies", () => {
    for (const packages of [["numpy; python x"], ["https://evil.test/source.tar.gz"], ["--editable"], ["constructor"], [], "numpy"])
      expect(questioningSetupCommand(packages)).toBeUndefined();
    const command = questioningSetupCommand(["numpy"])!;
    expect(command).toContain("--only-binary=:all:");
    expect(command).toContain("--no-deps");
    expect(command).toContain("--isolated");
    expect(command).not.toContain("bash");
  });
  it("requires a versioned scientific entrypoint, not inline commands bypassing provenance", () => {
    const q = state();
    for (const cmd of ["python -c 'print(1)'", "bash -c 'echo 1'", "python /work/materials/estimator.py", "python /tmp/changed.py", "python materials/../paper.md", "echo 1"])
      expect(q.executionArgv(cmd)).toBeUndefined();
    expect(q.executionArgv('python materials/estimator.py --label "weighted sample"')).toEqual(["python", "materials/estimator.py", "--label", "weighted sample"]);
  });
  it("does not expose host files or symlinks through source inspection and freezes setup after execution", () => {
    const q = state();
    expect(q.readKnownSource("/proc/1/environ")).toBeUndefined();
    expect(q.readKnownSource("/work/results/link-to-secret")).toBeUndefined();
    expect(q.readKnownSource("/work/materials/estimator.py")).toBe(code);
    expect(q.gate("setup_environment")).toBeUndefined();
    q.snapshot("python materials/estimator.py");
    expect(q.gate("setup_environment")).toContain("frozen");
  });
  it("permits an honest missing-material limitation but no blocked execution", () => {
    const q = new QuestioningState();
    q.addOriginal("/work/paper.md", question);
    q.addOriginal("/work/MATERIALS_INDEX.md", inventory);
    const a = { ...assessment("blocked"), evidence: assessment().evidence.slice(0, 2) };
    expect(q.assess(JSON.stringify(a), calls, claims)).toContain("committed");
    expect(q.gate("run_command")).toContain("no defensible analysis");
    expect(q.gate("write_file")).toContain("no defensible analysis");
    expect(q.markdown()).toContain("paginated provenance endpoint");
  });
  it("recovers long assessment/change state through bounded session retrieval", () => {
    const q = state();
    q.assess(JSON.stringify(assessment()), calls, claims);
    q.write("/work/working/materials/estimator.py", "x".repeat(50000), "Record complete weighting implementation");
    const session = new ReproductionSession(() => []);
    session.questioning = q;
    const instruction = session.activeInstruction();
    const ref = instruction.match(/ref="([^"]+)"/)![1];
    let text = "", offset = 0;
    do {
      const page = JSON.parse(session.readContext({ ref, offset, max_chars: 1000 }));
      text += page.text;
      offset = page.next_offset;
    } while (offset !== null);
    const afterHash = JSON.parse(text).changes[0].afterHash;
    const page = JSON.parse(session.readContext({ ref: `qp:blob:${afterHash}`, offset: 49000, max_chars: 1000 }));
    expect(page.text).toBe("x".repeat(1000));
    expect(page.total_chars).toBe(50000);
    expect(instruction.length).toBeLessThan(1000);
    expect(session.progress).toBe(2);
  });
  it("preserves P defaults and custom persona instructions on retry", () => {
    expect(getReproducerPrompt()).toBe(REPRODUCER_PROMPT);
    expect(getReproducerPrompt("qP")).not.toBe(REPRODUCER_PROMPT);
    expect(buildEffectiveReproducerPrompt("MY CUSTOM SCIENCE", "qP")).toContain("MY CUSTOM SCIENCE");
    expect(buildEffectiveReproducerPrompt("saved", "qP")).toContain("Mandatory qP runtime");
    expect(buildEffectiveReproducerPrompt("saved")).not.toContain("Mandatory qP runtime");
    expect(getJudgePrompt("qP")).toContain("scientifically defensible");
  });
});