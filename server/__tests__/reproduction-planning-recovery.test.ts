import { describe, it, expect } from "vitest";
import { PlanningRecovery } from "../reproduction-planning-recovery";
import { fitToolContext } from "../tool-context";
import { RequestContextBudget } from "../llm-context";

const page = (offset: number, text: string) =>
  `Verified file: /work/materials/test.py\nReturned characters: ${offset}-${offset + text.length} of 1000\n---\n${text}`;
describe("bounded planning navigation", () => {
  it("preserves repair, exact identity and inspected references through forced compaction", () => {
    const guard = new PlanningRecovery();
    for (let i = 1; i <= 3; i++) guard.observe("read_file", page(0, "abcd"), i, i);
    const packet = JSON.stringify({ stage: "planning", claim: { id: "R1", claim: "Exact measured statement 0.91." } });
    const fitted = fitToolContext({
      model: "offline", messages: [{ role: "system", content: "Scientific instructions stay." },
        { role: "user", content: packet },
        { role: "assistant", tool_calls: [{ id: "old", type: "function", function: { name: "read_file", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "old", content: "long README ".repeat(9000) }],
      max_tokens: 1000,
    }, { budget: new RequestContextBudget({ providerMode: "platform", provider: "openai", modelName: "offline" }, 1000, "test", 8000),
      protection: { compactUserMessage: packet, getState: () => JSON.stringify(guard.state()),
        getActiveInstruction: () => guard.instruction(9, 96, false) } });
    const rendered = JSON.stringify(fitted);
    expect(rendered).toContain("PLANNING REPAIR");
    expect(rendered).toContain("test.py:0-4");
    expect(rendered).toContain("Exact measured statement 0.91.");
    expect(rendered.length).toBeLessThan(40000);
  });
  it("allows changed files and new source pages without claiming repeated reads", () => {
    const guard = new PlanningRecovery();
    guard.observe("read_file", page(0, "abcd"), 1, 1);
    guard.observe("read_file", page(4, "efgh"), 2, 2);
    guard.observe("read_file", page(0, "NEW!"), 3, 3);
    expect(guard.firstStallCall).toBeUndefined();
    guard.observe("read_file", page(0, "NEW!"), 4, 4);
    guard.observe("read_file", page(0, "NEW!"), 5, 5);
    expect(guard.firstStallCall).toBe(5);
    expect(guard.instruction(7, 88, true)).toContain("assess_suitability");
    expect(Buffer.byteLength(JSON.stringify(guard.instruction(7, 88, true)))).toBeLessThan(1000);
  });
  it("detects unchanged directory loops and never resets repair for new reads", () => {
    const guard = new PlanningRecovery();
    for (let i = 1; i <= 3; i++) guard.observe("list_files", "Verified directory: /work/materials\nf test.py", i, i);
    expect(guard.firstStallCall).toBe(3);
    guard.observe("read_file", page(0, "abcd"), 4, 4);
    expect(guard.firstStallCall).toBe(3);
  });
});