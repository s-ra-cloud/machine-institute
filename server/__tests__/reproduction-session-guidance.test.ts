import { describe, expect, it } from "vitest";
import type { ToolCallRecord } from "../model-service";
import { QuestioningState, type SuitabilityAssessment } from "../reproduction-questioning";
import { ReproductionSession } from "../reproduction-session";
import type { RecordedResult } from "../prompts/reproduce";

const bytes = (text: string) => Buffer.byteLength(JSON.stringify(text), "utf8");
const claimText = "held-out accuracy is 92.3%";
const quote = `The frozen evaluation reports that ${claimText} using the Atlas test set.`;
const navigation = 'Read /work/paper.md offset=5000; original read_file #7.';
const call = (index: number, name: string, result: string, args: Record<string, unknown>): ToolCallRecord => ({
  index, name, result, args, durationMs: 1, error: false,
});

function groundedSession() {
  const session = new ReproductionSession(() => []);
  session.configureSourceGrounding({ paperPath: "/work/paper.md", paperText: quote });
  session.observeToolCall(call(7, "read_file",
    `Verified file: /work/paper.md\nReturned characters: 0-${quote.length} of ${quote.length}\n---\n${quote}`,
    { path: "/work/paper.md" }));
  expect(session.recordResult({
    id: "R4", claim: claimText, status: "pending", original_value: "92.3%",
    source_quote: quote, source_location: `characters 0-${quote.length}`, source_tool_call_id: 7,
  })).toContain("Registered R4 as pending");
  return session;
}

function fullContext(session: ReproductionSession, ref: string) {
  let text = "";
  let offset: number | null = 0;
  do {
    const page = JSON.parse(session.readContext({ ref, offset, max_chars: 1000 }));
    text += page.text;
    offset = page.next_offset;
  } while (offset !== null);
  return JSON.parse(text);
}

function questioningSession(decision?: SuitabilityAssessment["decision"]) {
  const session = groundedSession();
  const q = new QuestioningState();
  const question = "Does the frozen evaluation accurately measure held-out classification performance?";
  const inventory = "Shipped materials include evaluator.py and the Atlas test set.";
  const code = "print(evaluate_atlas_test_set())";
  const originals = [
    ["/work/paper.md", question], ["/work/MATERIALS_INDEX.md", inventory], ["/work/materials/evaluator.py", code],
  ];
  const calls = originals.map(([path, text], index) => {
    q.addOriginal(path, text);
    return call(index + 10, "read_file", text, { path });
  });
  if (decision) {
    const assessment: SuitabilityAssessment = {
      research_question: question, question_quote: question, decision,
      rationale: "The evaluation requires class weighting to address the sampling design.",
      claim_ids: ["R4"], evidence: calls.map(c => ({ tool_call_id: c.index, excerpt: c.result })),
      intended_changes: "Apply class weights to the reported evaluation.",
      comparability: "Adapted evaluation is separate from the original reported reproduction.",
      planned_changes: [{ path: "/work/working/materials/evaluator.py",
        reason: "Account for unequal class sampling probabilities.", claim_ids: ["R4"] }],
    };
    expect(q.assess(JSON.stringify(assessment), calls, Array.from(session.recorded.values()))).toContain("committed");
  }
  session.questioning = q;
  return { session, q };
}

describe("bounded active reproduction session guidance", () => {
  it("preserves the original EXTRACT action and places navigation after it", () => {
    const session = new ReproductionSession(() => []);
    const original = session.activeInstruction();
    expect(original).toBe("LATEST ACTION — EXTRACT: no claims are accepted. Search targeted sections of /work/paper.md for actual core quantitative claims, then register them pending. Do not repeat the first page, invent claims, return a plan, or return an archive notice.");
    const instruction = session.activeInstruction(navigation);
    expect(instruction.startsWith(original)).toBe(true);
    expect(instruction).toContain(`Subordinate navigation (after the action above): ${navigation}`);
    expect(bytes(instruction)).toBeLessThanOrEqual(800);
  });

  it("prioritizes pending R4's experiment over browsing and retains exact source provenance", () => {
    const session = groundedSession();
    const instruction = session.activeInstruction(navigation);
    expect(instruction).toMatch(/^LATEST ACTION — PREPARE\/EXECUTE.*no command has run/s);
    expect(instruction).toContain('Pending id="R4"');
    expect(instruction).toContain(`claim=${JSON.stringify(claimText)}`);
    expect(instruction).toContain("source_tool_call_id=7 (original paper read)");
    expect(instruction).toContain("Do not re-register claims");
    expect(instruction).toContain("Never guess values");
    expect(instruction.indexOf('Pending id="R4"')).toBeLessThan(instruction.indexOf("Subordinate navigation"));
    const ref = instruction.match(/ref="([^"]+)"/)![1];
    expect(fullContext(session, ref).accepted).toMatchObject({
      id: "R4", claim: claimText, sourceToolCallId: 7, originalValue: "92.3%", status: "pending",
    });
    expect(bytes(instruction)).toBeLessThanOrEqual(800);
  });

  it("assesses command output without claiming that a paper search is scientific evidence", () => {
    const session = groundedSession();
    session.observeToolCall(call(8, "run_command", `exit code 0\n${quote}`, { command: "grep -n accuracy /work/paper.md" }));
    const instruction = session.activeInstruction(navigation);
    expect(instruction).toMatch(/^LATEST ACTION — ASSESS\/RECORD.*remain pending/s);
    expect(instruction).toContain("First assess whether output supports");
    expect(instruction).toContain("otherwise prepare/run the missing claim experiment");
    expect(instruction).toContain('Pending id="R4"');
    expect(instruction).toContain("source_tool_call_id=7");
    expect(instruction).not.toContain("execution evidence exists");
    expect(bytes(instruction)).toBeLessThanOrEqual(800);
  });

  it("retains REPORT compatibility when all accepted claims have been finalized", () => {
    const session = groundedSession();
    session.recordResult({ id: "R4", status: "inconclusive", method: "blocked" });
    const instruction = session.activeInstruction(navigation);
    expect(instruction).toMatch(/^LATEST ACTION — REPORT.*every accepted claim is finalized/s);
    expect(instruction).not.toContain("Pending id=");
    expect(instruction).toContain(navigation);
    expect(bytes(instruction)).toBeLessThanOrEqual(800);
  });

  it.each([
    "🧪漢字é".repeat(2000),
    'quoted "metric"\\path\n\t'.repeat(2000).trim(),
  ])("bounds serialized Unicode and escaped claim excerpts with stable full-state retrieval", claim => {
    const session = new ReproductionSession(() => []);
    session.recordResult({ id: 'R"4\\🧪', claim, status: "pending", source_tool_call_id: 7 });
    session.observeToolCall(call(8, "run_command", "exit code 0\ninspection only", { command: "ls" }));
    const instruction = session.activeInstruction(navigation);
    expect(instruction).toContain(`id=${JSON.stringify('R"4\\🧪')}`);
    const excerpt = JSON.parse(instruction.match(/claim excerpt=("(?:[^"\\]|\\.)*") \[excerpt; omitted text in ref\]/)![1]);
    expect(excerpt.length).toBeGreaterThan(0);
    expect(claim.startsWith(excerpt)).toBe(true);
    expect(Array.from(excerpt).some(char => char.length === 1 && /[\uD800-\uDFFF]/.test(char))).toBe(false);
    const ref = instruction.match(/ref="([^"]+)"/)![1];
    expect(fullContext(session, ref).accepted.claim).toBe(claim);
    expect(session.activeInstruction().match(/ref="([^"]+)"/)![1]).toBe(ref);
    expect(instruction).not.toContain(navigation);
    expect(bytes(instruction)).toBeLessThanOrEqual(800);
    expect(bytes(`${"Recovery. ".repeat(19)}\n${instruction}`)).toBeLessThanOrEqual(1000);
  });

  it("replaces oversized IDs with an explicit exact-ID reference, never a truncated identity", () => {
    const session = new ReproductionSession(() => []);
    const id = "R4-🧪".repeat(1500);
    const claim = "Exact source claim. ".repeat(1500).trim();
    session.recordResult({ id, claim, status: "pending", source_tool_call_id: 7 });
    const instruction = session.activeInstruction();
    expect(instruction).toContain("id omitted; recover exact id from ref");
    expect(instruction).not.toContain("R4-");
    expect(instruction).toContain("source_tool_call_id=7");
    expect(instruction).toContain("claim excerpt=");
    const ref = instruction.match(/ref="([^"]+)"/)![1];
    expect(fullContext(session, ref).accepted).toMatchObject({ id, claim, sourceToolCallId: 7 });
    expect(bytes(instruction)).toBeLessThanOrEqual(800);
  });

  it("does not guess absent source IDs or values and makes omitted pending claims recoverable", () => {
    const session = new ReproductionSession(() => []);
    session.recordResult({ id: "R4", claim: "Source claim without numeric values", status: "pending" });
    session.recordResult({ id: "R5", claim: "Another accepted source claim", status: "pending" });
    const instruction = session.activeInstruction();
    expect(instruction).toContain("2 accepted claim(s) remain pending");
    expect(instruction).toContain("source_tool_call_id not recorded; recover provenance, do not guess");
    expect(instruction).not.toMatch(/source_tool_call_id=\d/);
    expect(instruction).toContain("Other pending claims: read_reproduction_context (paged index)");
    expect(instruction).toContain("Never guess values");
    expect(bytes(instruction)).toBeLessThanOrEqual(800);
  });

  it("omits oversized navigation whole instead of truncating its IDs or displacing the action", () => {
    const session = new ReproductionSession(() => []);
    const oversized = 'original source ID="🧪'.repeat(2000);
    expect(session.activeInstruction(oversized)).toBe(session.activeInstruction());
    const small = "Continue the source page.";
    expect(session.activeInstruction(small)).toContain(small);
  });

  it("puts qP suitability inspection first even with pending claims and executable-looking navigation", () => {
    const { session, q } = questioningSession();
    const before = q.gate("run_command");
    const instruction = session.activeInstruction(navigation);
    expect(instruction).toMatch(/^qP phase: assessment \(inspection only; write\/execute disabled\)/);
    expect(instruction).toContain("call assess_suitability before execution");
    expect(instruction).toContain('Pending id="R4"');
    expect(instruction).not.toContain("LATEST ACTION — PREPARE/EXECUTE");
    expect(q.gate("run_command")).toBe(before);
    expect(q.gate("write_file")).toContain("inspection only");
    expect(bytes(instruction)).toBeLessThanOrEqual(800);
  });

  it.each(["suitable", "adapt", "blocked"] as const)("preserves qP %s phase and authoritative gates", decision => {
    const { session, q } = questioningSession(decision);
    const before = ["run_command", "write_file", "setup_environment"].map(tool => q.gate(tool));
    const instruction = session.activeInstruction(navigation);
    expect(instruction.startsWith(`qP phase: ${decision}.`)).toBe(true);
    expect(instruction).toContain('ref="qp:metadata"');
    expect(instruction).toContain('Pending id="R4"');
    if (decision === "suitable") expect(instruction).toContain("Use suitable code unchanged");
    if (decision === "adapt") {
      expect(instruction).toContain("apply every planned adaptation before execution");
      expect(instruction).toContain("Adapted results are separate");
    }
    if (decision === "blocked") expect(instruction).toContain("write/execute disabled");
    expect(["run_command", "write_file", "setup_environment"].map(tool => q.gate(tool))).toEqual(before);
    expect(bytes(instruction)).toBeLessThanOrEqual(800);
  });

  it("keeps oversized qP limitations recoverable without weakening gates or exceeding the byte cap", () => {
    const { session, q } = questioningSession("adapt");
    q.limitation = "Provenance capacity exceeded: 🧪 ".repeat(3000);
    const instruction = session.activeInstruction(navigation);
    expect(instruction.startsWith("qP phase: adapt.")).toBe(true);
    expect(instruction).toContain("Limitation recorded: write/execute/setup disabled");
    expect(instruction).not.toContain("apply every planned adaptation");
    expect(fullContext(session, "qp:metadata").limitation).toBe(q.limitation);
    expect(q.gate("run_command")).toContain(q.limitation);
    expect(bytes(instruction)).toBeLessThanOrEqual(800);
  });

  it("reserves recovery space at the largest inline identity across all phases", () => {
    for (const phase of ["P", "assessment", "suitable", "adapt", "blocked"] as const) {
      for (const limited of [false, true]) {
        for (const sourceId of [undefined, Number.MAX_SAFE_INTEGER]) {
          const session = new ReproductionSession(() => []);
          if (phase !== "P") {
            const { q } = questioningSession(phase === "assessment" ? undefined : phase);
            if (limited) q.limitation = "A concrete capacity limitation.";
            session.questioning = q;
          }
          session.recordResult({ id: "R".repeat(94), claim: "🧪".repeat(2000),
            status: "pending", source_tool_call_id: sourceId });
          session.recordResult({ id: "R5", claim: "Another accepted claim", status: "pending" });
          session.observeToolCall(call(8, "run_command", "exit code 0\ninspection only", { command: "ls" }));
          expect(bytes(session.activeInstruction(navigation)), `${phase}, limited=${limited}, source=${sourceId}`)
            .toBeLessThanOrEqual(800);
        }
      }
    }
  });

  it.each(["R".repeat(94), "R-🧪".repeat(2000)])("bounds qP adapt with a long identity, missing source ID and multiple pending claims", id => {
    const { q } = questioningSession("adapt");
    const session = new ReproductionSession(() => []);
    session.questioning = q;
    session.recordResult({ id, claim: "🧪 quantitative source claim ".repeat(2000), status: "pending" });
    session.recordResult({ id: "R5", claim: "Another accepted claim", status: "pending" });
    const before = q.gate("run_command");
    const instruction = session.activeInstruction(navigation);
    expect(instruction.startsWith("qP phase: adapt.")).toBe(true);
    expect(instruction).toContain("Only planned working-copy edits are allowed");
    expect(instruction).toContain("apply every planned adaptation before execution");
    expect(instruction).toContain("source_tool_call_id not recorded");
    expect(instruction).toContain("Other pending claims:");
    if (id.length === 94) expect(instruction).toContain(`id=${JSON.stringify(id)}`);
    else expect(instruction).toContain("id omitted; recover exact id from ref");
    const ref = instruction.match(/Full accepted state: read_reproduction_context\(ref="([^"]+)"\)/)![1];
    expect(fullContext(session, ref).accepted.id).toBe(id);
    expect(q.gate("run_command")).toBe(before);
    expect(bytes(instruction)).toBeLessThanOrEqual(800);
  });

  it("checks the empty excerpt envelope before searching and drops optional content, not gates or identity", () => {
    const { q } = questioningSession("adapt");
    const session = new ReproductionSession(() => []);
    session.questioning = q;
    const id = "R".repeat(94);
    session.recordResult({ id, claim: "🧪".repeat(2000), status: "pending" });
    session.recordResult({ id: "R5", claim: "Another accepted claim", status: "pending" });
    // Exercise future action-template growth without changing production gates.
    const action = `${session.activeInstruction().split("\nPending ")[0]} ${"Authoritative extra gate. ".repeat(4)}`;
    const renderer = session as unknown as {
      withPendingGuidance(action: string, pending: RecordedResult[]): string;
    };
    const instruction = renderer.withPendingGuidance(action, Array.from(session.recorded.values()));
    expect(instruction.startsWith(action)).toBe(true);
    expect(instruction).toContain(`id=${JSON.stringify(id)}`);
    expect(instruction).toContain("source_tool_call_id not recorded");
    expect(instruction).toContain("claim omitted;");
    expect(instruction).not.toContain("claim excerpt=");
    expect(instruction).not.toContain("Other pending claims:");
    const ref = instruction.match(/Full accepted state: read_reproduction_context\(ref="([^"]+)"\)/)![1];
    expect(fullContext(session, ref).accepted.id).toBe(id);
    expect(bytes(instruction)).toBeLessThanOrEqual(800);
  });

  it("uses an exact-state reference when even inline identity overhead cannot fit", () => {
    const session = new ReproductionSession(() => []);
    const id = "R".repeat(94);
    session.recordResult({ id, claim: "A source-grounded accepted claim", status: "pending" });
    const renderer = session as unknown as {
      withPendingGuidance(action: string, pending: RecordedResult[]): string;
    };
    const action = `qP phase: adapt. Only planned working-copy edits; apply every planned adaptation before execution. ${"Extra gate. ".repeat(42)}`;
    const pending = Array.from(session.recorded.values());
    const instruction = renderer.withPendingGuidance(action, pending);
    expect(instruction.startsWith(action)).toBe(true);
    expect(instruction).toContain("Pending id/claim/source omitted; recover exact accepted state:");
    const ref = instruction.match(/read_reproduction_context\(ref="([^"]+)"\)/)![1];
    expect(fullContext(session, ref).accepted.id).toBe(id);
    expect(bytes(instruction)).toBeLessThanOrEqual(800);
    expect(() => renderer.withPendingGuidance("Gate. ".repeat(200), pending)).toThrow("byte limit");
  });
});