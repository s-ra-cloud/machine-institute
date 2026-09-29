import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("openai", () => ({
  default: class OpenAIMock {
    chat = { completions: { create: createMock } };
  },
}));
vi.mock("../storage", () => ({ storage: {} }));

import { runToolLoop, type ToolSpec } from "../model-service";
import { getReproductionCompletionIssues } from "../reproduce";
import { ReproductionReadGuard } from "../reproduction-read-guard";
import { ReproductionSession } from "../reproduction-session";

const quote = "The frozen evaluation reports mean recovery 0.992 and 16/16 donor answers.";
const paper = `## 3. Results\n${quote}`;
const tools: ToolSpec[] = [
  { name: "read_file", description: "source", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "list_files", description: "directory", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "read_reproduction_context", description: "archive", parameters: { type: "object", properties: { ref: { type: "string" } } } },
  { name: "record_result", description: "claim", parameters: { type: "object", properties: { id: { type: "string" }, status: { type: "string" } }, required: ["id", "status"] } },
];
const call = (id: number, name: string, args: Record<string, unknown>) => ({
  choices: [{
    finish_reason: "tool_calls",
    message: { content: null, tool_calls: [{ id: `c${id}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
  }],
});
const final = (text: string) => ({ choices: [{ finish_reason: "stop", message: { content: text, tool_calls: [] } }] });

describe("source-to-claim handoff (mocked tool loop)", () => {
  beforeEach(() => {
    createMock.mockReset();
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("AI_INTEGRATIONS_OPENROUTER_BASE_URL", "https://managed.example.test");
    vi.stubEnv("LAB_ALLOWED_MODELS", "openai/gpt-4o");
  });

  const run = async (register: boolean) => {
    const guard = new ReproductionReadGuard();
    const session = new ReproductionSession(() => []);
    session.configureSourceGrounding({ paperPath: "/work/paper.md", paperText: paper });
    const script: Array<[string, Record<string, unknown>]> = [
      ["read_file", { path: "/work/paper.md" }],
      ["read_reproduction_context", { ref: "characters 0-86" }],
      ["list_files", { path: "/work" }],
      ["list_files", { path: "/work" }],
      ["list_files", { path: "/work" }],
      ...(register
        ? [["record_result", {
          id: "R1", status: "pending", claim: "mean recovery 0.992 and 16/16 donor answers",
          source_quote: quote, source_location: `characters 0-${paper.length}`,
          source_tool_call_id: 1, original_value: "0.992",
        }] as [string, Record<string, unknown>]]
        : Array.from({ length: 8 }, () => ["list_files", { path: "/work" }] as [string, Record<string, unknown>])),
    ];
    let step = 0;
    createMock.mockImplementation(async (request: any) => {
      if (!request.tools) return final('I will now call read_file(path="/work/paper.md").\n<｜DSML｜tool_calls>');
      const next = script[step++];
      return next ? call(step, ...next) : final("## Claims\nThe accepted claims are listed here.");
    });
    const execute = vi.fn(async (name: string, args: Record<string, unknown>) => {
      const result = name === "read_file"
        ? `Verified file: /work/paper.md\nReturned characters: 0-${paper.length} of ${paper.length}\n---\n${paper}`
        : name === "list_files"
          ? "Verified directory: /work\nf paper.md"
          : name === "read_reproduction_context"
            ? '{"error":"Refused: ref must identify archived reproduction context."}'
            : session.recordResult(args);
      session.captureOutput(name, result);
      return result;
    });
    const result = await runToolLoop(
      { providerMode: "platform", provider: "openai", modelName: "openai/gpt-4o" },
      "system", "user", tools, execute, {
        maxToolCalls: 100, deadlineMs: Date.now() + 60_000, numberToolResults: true,
        getStallReason: name => name === "record_result" || name === "assess_suitability" ? null : guard.stopReason,
        transformToolResult: (name, text, id) => guard.observe(name, text, {
          acceptedClaims: session.recorded.size, assessed: false,
        }, id),
        onToolCall: record => session.observeToolCall(record),
      },
    );
    return { result, session, guard, execute };
  };

  it("uses the original verified read after invalid archive retrieval and duplicate listings", async () => {
    const { result, session, guard } = await run(true);
    const firstRead = createMock.mock.calls[1][0].messages.find((m: any) => m.role === "tool");
    expect(firstRead.content).toContain("source_tool_call_id=1");
    expect(firstRead.content).toContain(`source_location="characters 0-${paper.length}"`);
    const laterRequest = createMock.mock.calls[5][0].messages;
    expect(laterRequest.some((m: any) => m.role === "tool" && String(m.content).includes("Repeated inspection 2/7"))).toBe(true);
    expect(result.toolCalls).toHaveLength(6);
    expect(session.recorded.get("R1")).toMatchObject({
      status: "pending", sourceToolCallId: 1, sourceQuote: quote,
    });
    expect(session.toolCalls[0].result).not.toContain("NEXT ACTION");
    expect(guard.extractionInstruction).toBeNull();
    expect(guard.stopReason).toBeNull();
  });

  it("fails early and cannot accept tool-call-looking final text as evidence", async () => {
    const { result, session, execute, guard } = await run(false);
    expect(result.stoppedBy).toBe("no-progress");
    expect(result.toolCalls.length).toBeLessThan(20);
    expect(execute).toHaveBeenCalledTimes(result.toolCalls.length);
    expect(guard.stopReason).not.toBeNull();
    expect(session.recorded.size).toBe(0);
    expect(getReproductionCompletionIssues({
      recordedResults: [], toolCalls: session.toolCalls, logbook: result.content,
    })).toEqual(expect.arrayContaining([
      "no core results have been registered",
      "no command execution or recorded reproduction evidence exists",
    ]));
    expect(getReproductionCompletionIssues({
      recordedResults: [], toolCalls: session.toolCalls, logbook: result.content,
    }).some(issue => issue.startsWith("the final logbook is missing"))).toBe(true);
  });

  it("allows an already-batched grounded claim immediately after the seventh repeated listing", async () => {
    const guard = new ReproductionReadGuard();
    const session = new ReproductionSession(() => []);
    session.configureSourceGrounding({ paperPath: "/work/paper.md", paperText: paper });
    const claimArgs = {
      id: "R1", status: "pending", claim: "mean recovery 0.992 and 16/16 donor answers",
      source_quote: quote, source_location: `characters 0-${paper.length}`,
      source_tool_call_id: 1, original_value: "0.992",
    };
    createMock
      .mockResolvedValueOnce(call(1, "read_file", { path: "/work/paper.md" }))
      .mockResolvedValueOnce({ choices: [{
        finish_reason: "tool_calls",
        message: { content: null, tool_calls: [
          ...Array.from({ length: 8 }, (_, i) => ({
            id: `l${i}`, type: "function",
            function: { name: "list_files", arguments: JSON.stringify({ path: "/work" }) },
          })),
          { id: "claim", type: "function", function: { name: "record_result", arguments: JSON.stringify(claimArgs) } },
        ] },
      }] })
      .mockResolvedValueOnce(final("## Claims\nA claim remains pending."));
    const result = await runToolLoop(
      { providerMode: "platform", provider: "openai", modelName: "openai/gpt-4o" },
      "system", "user", tools, async (name, args) => {
        const text = name === "read_file"
          ? `Verified file: /work/paper.md\nReturned characters: 0-${paper.length} of ${paper.length}\n---\n${paper}`
          : name === "list_files" ? "Verified directory: /work\nf paper.md" : session.recordResult(args);
        session.captureOutput(name, text);
        return text;
      }, {
        maxToolCalls: 100, deadlineMs: Date.now() + 60_000,
        getStallReason: name => name === "record_result" ? null : guard.stopReason,
        transformToolResult: (name, text, id) => guard.observe(name, text, {
          acceptedClaims: session.recorded.size, assessed: false,
        }, id),
        onToolCall: record => session.observeToolCall(record),
      },
    );
    expect(result.stoppedBy).toBe("model");
    expect(result.toolCalls).toHaveLength(10);
    expect(result.toolCalls[9].result).toContain("Registered R1 as pending");
    expect(session.recorded.get("R1")?.sourceToolCallId).toBe(1);
    expect(guard.stopReason).toBeNull();
  });
});