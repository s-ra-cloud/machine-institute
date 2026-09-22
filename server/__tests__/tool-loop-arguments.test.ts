import { beforeEach, describe, expect, it, vi } from "vitest";
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("openai", () => ({
  default: class { chat = { completions: { create } }; },
}));
import { runToolLoop, type ToolLoopOutcome, type ToolSpec } from "../model-service";
import { ReproductionSession } from "../reproduction-session";
import { fitToolContext } from "../tool-context";
import { RequestContextBudget } from "../llm-context";

const config = { providerMode: "platform" as const, provider: "openai", modelName: "gpt-4o" };
const tools: ToolSpec[] = [{
  name: "run_command", description: "execute",
  parameters: { type: "object", required: ["command"], properties: {
    command: { type: "string" }, timeout_seconds: { type: "integer" },
    evidence_ids: { type: "array", items: { type: "integer" } },
  } },
}];
const final = (finish_reason = "stop") => ({ choices: [{ finish_reason, message: { content: "Finished." } }] });
const turn = (raw: string, finish_reason = "tool_calls") => ({
  choices: [{ finish_reason, message: { tool_calls: [
    { id: "c1", type: "function", function: { name: "run_command", arguments: raw } },
  ] } }],
});

beforeEach(() => {
  create.mockReset();
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "test";
  process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "https://managed.example.test";
  process.env.AI_INTEGRATIONS_OPENAI_MODELS = "gpt-4o";
});

describe("strict tool argument recovery", () => {
  it.each([
    ['{"command":', "invalid-json"],
    ['{"command":"a","\\u0063ommand":"b"}', "invalid-json"],
    ['null', "invalid-schema"],
    ['[]', "invalid-schema"],
    ['{}', "invalid-schema"],
    ['{"command":12}', "invalid-schema"],
    ['{"command":"a","timeout_seconds":"5"}', "invalid-schema"],
    ['{"command":"a","evidence_ids":["1"]}', "invalid-schema"],
    ['{"command":"a","timeout_seconds":1e999}', "invalid-schema"],
  ])("refuses %s, reports validation, and executes only corrected input", async (raw, reason) => {
    create.mockResolvedValueOnce(turn(raw))
      .mockResolvedValueOnce(turn('{"command":"python 実験.py"}'))
      .mockResolvedValueOnce(final());
    const execute = vi.fn(async () => "exit code 0 (1.0s)\nmetric=0.91");
    const events: ToolLoopOutcome[] = [];
    const session = new ReproductionSession(() => []);
    session.recordResult({ id: "R1", claim: "Accuracy", status: "pending" });
    const progressBeforeAttempts = session.progress;
    const result = await runToolLoop(config, "sys", "user", tools, execute, {
      maxToolCalls: 10, deadlineMs: Date.now() + 60_000,
      getArgumentRepair: () => session.contextState(),
      onOutcome: event => { events.push(event); },
      onToolCall: record => session.observeToolCall(record),
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith("run_command", { command: "python 実験.py" });
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].result).toContain('"id":"R1"');
    expect(result.toolCalls[0].result).toContain("do not register it again");
    expect(result.toolCalls[0].error).toBe(true);
    expect(session.progress).toBe(progressBeforeAttempts + 1);
    expect(events).toContainEqual(expect.objectContaining({ kind: "arguments", argumentParse: reason }));
    expect(events.at(-1)).toMatchObject({ kind: "stop", finishReason: "stop", stopReason: "model" });
  });

  it("rejects an entire truncated turn even when its first expensive call is valid", async () => {
    const truncated = turn('{"command":"expensive"}', "length");
    truncated.choices[0].message.tool_calls.push({
      id: "c2", type: "function", function: { name: "run_command", arguments: '{"command":' },
    });
    create.mockResolvedValueOnce(truncated).mockResolvedValueOnce(turn('{"command":"expensive"}')).mockResolvedValueOnce(final());
    const execute = vi.fn(async () => "done");
    const events: ToolLoopOutcome[] = [];
    const result = await runToolLoop(config, "sys", "user", tools, execute, {
      maxToolCalls: 10, deadlineMs: Date.now() + 60_000,
      onOutcome: async event => { events.push(event); throw new Error("observer unavailable"); },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.toolCalls.slice(0, 2).every(call => call.error && call.result.startsWith("Refused:"))).toBe(true);
    expect(events.filter(event => event.argumentParse === "truncated" && event.kind === "arguments")).toHaveLength(2);
  });

  it("does not accept repeatedly truncated final text as successful completion", async () => {
    create.mockResolvedValue(final("length"));
    const result = await runToolLoop(config, "sys", "user", tools, vi.fn(), {
      maxToolCalls: 10, deadlineMs: Date.now() + 60_000, maxPrematureStopRecoveries: 2,
    });
    expect(result).toMatchObject({ stoppedBy: "no-progress", content: "", rounds: 3, finishReason: "length" });
  });

  it("terminates repeated invalid calls within the existing tool budget", async () => {
    create.mockResolvedValueOnce(turn("{}")).mockResolvedValueOnce(turn("{}")).mockResolvedValueOnce(final());
    const execute = vi.fn();
    const result = await runToolLoop(config, "sys", "user", tools, execute, {
      maxToolCalls: 2, deadlineMs: Date.now() + 60_000,
    });
    expect(result.stoppedBy).toBe("tool-budget");
    expect(execute).not.toHaveBeenCalled();
    expect(create.mock.calls[2][0].tools).toBeUndefined();
  });
});

describe("claim repair and tool-aware argument compaction", () => {
  it("reports field-specific missing values and references the accepted claim without changing it", () => {
    const issues: string[][] = [];
    const session = new ReproductionSession(() => [], errors => { issues.push(errors); throw new Error("observer"); });
    session.recordResult({ id: "R1", claim: "Accuracy", status: "pending" });
    const missingId = session.recordResult({ claim: "Accuracy", status: "pending" });
    expect(missingId).toContain("id is required");
    expect(missingId).not.toContain("claim is required");
    expect(session.recordResult({ id: "R2", status: "pending" })).toContain("claim is required");
    const blankUpdate = session.recordResult({ id: "R1", claim: " ", status: "pending" });
    expect(blankUpdate).toContain("omit claim to preserve");
    expect(blankUpdate).toContain('Accepted id="R1" remains pending');
    const ref = blankUpdate.match(/ref="(\d+)"/)![1];
    expect(session.readContext({ ref })).toContain("Accuracy");
    expect(session.recordResult({ id: "R1", status: 123 })).toContain("status must be a string");
    expect(session.recordResult({ id: "R1", status: "unknown" })).toContain("status must be pending");
    expect(issues).toHaveLength(5);
    expect(session.recorded.get("R1")).toMatchObject({ claim: "Accuracy", status: "pending" });
    expect(session.recorded.has("R2")).toBe(false);
  });

  it("observes evidence validation failures as structured errors before rendering refusal output", () => {
    const observed: string[][] = [];
    const session = new ReproductionSession(() => ["R1 evidence excerpt does not match original output"], issues => { observed.push(issues); });
    session.recordResult({ id: "R1", claim: "Accuracy", status: "pending" });
    expect(session.recordResult({ id: "R1", status: "verified", method: "rerun" })).toContain("Refused finalization");
    expect(observed).toEqual([["R1 evidence excerpt does not match original output"]]);
    expect(session.recorded.get("R1")?.status).toBe("pending");
  });

  it("keeps accepted state unchanged on invalid types and gives pending work instead of registering twice", () => {
    const session = new ReproductionSession(() => []);
    session.recordResult({ id: "R1", claim: "Accuracy", status: "pending" });
    expect(session.recordResult({ id: "R1", status: "verified", evidence_tool_call_ids: ["1"] })).toContain("array of integers");
    expect(session.recorded.get("R1")?.status).toBe("pending");
    expect(session.recordResult({ id: "R1", status: "pending" })).toContain("Do not register this claim again");
    const progressAfterRegistration = session.progress;
    session.observeToolCall({ index: 1, name: "run_command", args: {}, result: "Tool error: failed", durationMs: 0, error: true });
    expect(session.progress).toBe(progressAfterRegistration);
  });

  it("preserves exact claim identity and evidence IDs while archiving oversized Unicode fields immutably", () => {
    const archived = new Map<string, string>();
    const argumentsText = JSON.stringify({
      id: "結果😀", claim: "測定した精度", status: "verified", evidence_tool_call_ids: [3, 8],
      evidence: "🌐漢字".repeat(10_000),
    });
    const request = { messages: [
      { role: "system", content: "instructions" },
      { role: "user", content: "paper" },
      { role: "assistant", tool_calls: [{ id: "call", function: { name: "record_result", arguments: argumentsText } }] },
      { role: "tool", tool_call_id: "call", content: "Recorded." },
    ] };
    const budget = new RequestContextBudget(config, 8000, "tool-loop", 64000);
    budget.inputLimit = 3000;
    const fitted = fitToolContext(request, { budget, protection: {
      getState: () => "{}",
      archiveContext: (key, text) => { archived.set(key, text); return JSON.stringify({ ref: key }); },
    } });
    const compact = JSON.parse(fitted.messages[2].tool_calls![0].function.arguments);
    expect(compact).toMatchObject({ id: "結果😀", claim: "測定した精度", status: "verified", evidence_tool_call_ids: [3, 8] });
    expect(compact._context_archive).toBeTruthy();
    expect(Array.from(archived.values())).toContain(argumentsText);
    expect(Buffer.byteLength(JSON.stringify(compact), "utf8")).toBeLessThan(1800);
    expect(request.messages[2].tool_calls![0].function.arguments).toBe(argumentsText);
    expect(budget.fits(fitted)).toBe(true);
  });

  it.each([
    '{"command":"' + "🌐漢字".repeat(10_000),
    JSON.stringify(["🌐漢字".repeat(10_000)]),
  ])("archives malformed/nonobject canonical arguments without interpreting them", raw => {
    const archived = new Map<string, string>();
    const request = { messages: [
      { role: "system", content: "instructions" },
      { role: "user", content: "paper" },
      { role: "assistant", tool_calls: [{ id: "bad", function: { name: "run_command", arguments: raw } }] },
      { role: "tool", tool_call_id: "bad", content: "Refused: invalid arguments." },
    ] };
    const budget = new RequestContextBudget(config, 8000, "tool-loop", 64000);
    budget.inputLimit = 3000;
    const fitted = fitToolContext(request, { budget, protection: {
      getState: () => "{}",
      archiveContext: (key, text) => { archived.set(key, text); return JSON.stringify({ ref: key }); },
    } });
    const compact = JSON.parse(fitted.messages[2].tool_calls![0].function.arguments);
    expect(compact._context_archive).toBeTruthy();
    expect(compact.command).toBeUndefined();
    expect(archived.get("tool-arguments:bad:run_command")).toBe(raw);
    expect(request.messages[2].tool_calls![0].function.arguments).toBe(raw);
    expect(budget.fits(fitted)).toBe(true);
  });
});