import { describe, expect, it } from "vitest";
import { ContextBudgetError, RequestContextBudget } from "../llm-context";
import { ACTIVE_INSTRUCTION_MAX_BYTES, fitToolContext } from "../tool-context";

const config = {
  providerMode: "byoc" as const,
  provider: "openai",
  modelName: "gpt-4o",
};

function budget(inputLimit: number): RequestContextBudget {
  const result = new RequestContextBudget(config, 8_000, "tool-loop", 128_000);
  result.inputLimit = inputLimit;
  return result;
}

describe("fitToolContext", () => {
  const freshOutputRequest = (output = "NEW_MEASUREMENT score=0.91") => ({
    messages: [
      { role: "system", content: "Preserve scientific evidence." },
      { role: "user", content: "Execute the accepted experiment." },
      { role: "assistant", content: "", tool_calls: [
        { id: "old", type: "function", function: { name: "read_tool_result", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "old", content: "old source ".repeat(4000) },
      { role: "assistant", content: "", tool_calls: [
        { id: "fresh", type: "function", function: { name: "run_command", arguments: "{}" } },
        { id: "sibling", type: "function", function: { name: "read_file", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "fresh", content: `[Tool call #2]\n${output}` },
      { role: "tool", tool_call_id: "sibling", content: "[Tool call #3]\nCURRENT_CONFIGURATION" },
    ],
  });

  it("retains every fresh result in the newest batch instead of favoring stale retrievals", () => {
    const request = freshOutputRequest();
    const canonical = JSON.stringify(request);
    const limit = budget(2000);
    const fitted = fitToolContext(request, {
      budget: limit, protection: { getState: () => "state", preserveLatestToolBatch: true },
    });
    expect(limit.fits(fitted)).toBe(true);
    expect(JSON.stringify(fitted)).toContain("NEW_MEASUREMENT");
    expect(JSON.stringify(fitted)).toContain("CURRENT_CONFIGURATION");
    expect(JSON.stringify(request)).toBe(canonical);
    const declared = fitted.messages.flatMap((message: any) => message.tool_calls ?? []).map((call: any) => call.id);
    for (const message of fitted.messages.filter((message: any) => message.role === "tool"))
      expect(declared).toContain(message.tool_call_id);
  });

  it("fails closed rather than erasing an oversized fresh result without a safe pager", () => {
    expect(() => fitToolContext(freshOutputRequest("x".repeat(40000)), {
      budget: budget(2000), protection: { getState: () => "state", preserveLatestToolBatch: true },
    })).toThrow(ContextBudgetError);
  });

  it("uses the supplied evidence pager for fresh results and preserves canonical output", () => {
    const request = freshOutputRequest("x".repeat(40000));
    const canonical = JSON.stringify(request);
    const limit = budget(2000);
    let paged = false;
    const fitted = fitToolContext(request, {
      budget: limit,
      protection: {
        getState: () => "state", preserveLatestToolBatch: true,
        resizeRecentToolOutput: original => {
          if (!original.startsWith("[Tool call #2]")) return undefined;
          expect(original).toBe(request.messages[5].content);
          paged = true;
          return "Original evidence #2; page 0-10 of 40000: xxxxxxxxxx; retrieve offset=10";
        },
      },
    });
    expect(paged).toBe(true);
    expect(limit.fits(fitted)).toBe(true);
    expect(JSON.stringify(fitted)).toContain("retrieve offset=10");
    expect(JSON.stringify(fitted)).toContain("CURRENT_CONFIGURATION");
    expect(JSON.stringify(request)).toBe(canonical);
  });
  it("fits a clone while preserving system, exact state, paired calls, and canonical args", () => {
    const args = JSON.stringify({ command: "python reproduce.py", source: "x".repeat(3_000) });
    const request = {
      model: "gpt-4o",
      tools: [{ type: "function", function: { name: "run_command", parameters: { type: "object" } } }],
      messages: [
        { role: "system", content: "Never omit the evidence contract." },
        { role: "user", content: "A very large initial paper prompt " + "p".repeat(2_000) },
        { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "run_command", arguments: args } }] },
        { role: "tool", tool_call_id: "call-1", content: "[Tool call #1]\n" + "result ".repeat(1_000) },
      ],
    };
    const fitted = fitToolContext(request, {
      budget: budget(1_500),
      protection: {
        getState: () => "Current ledger state",
        compactUserMessage: "Read existing files and continue from the ledger.",
      },
    });

    expect(fitted).not.toBe(request);
    expect(request.messages[1].content).toContain("large initial");
    expect(request.messages[2].tool_calls[0].function.arguments).toBe(args);
    expect(fitted.messages[0]).toEqual(request.messages[0]);
    expect(fitted.messages.at(-1)).toEqual({ role: "user", content: "Current ledger state" });
    expect(JSON.stringify(fitted)).toContain("read_tool_result");
    expect(JSON.stringify(fitted)).toContain("old command arguments omitted");
    const ids = fitted.messages.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id);
    const declared = fitted.messages.flatMap((m: any) => m.tool_calls ?? []).map((c: any) => c.id);
    expect(ids.every((id: string) => declared.includes(id))).toBe(true);
  });

  it("does not allow a recent-output exemption to bypass the hard bound", () => {
    const request = {
      messages: [
        { role: "system", content: "system" },
        ...Array.from({ length: 10 }, (_, i) => [
          { role: "assistant", content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }] },
          { role: "tool", tool_call_id: `c${i}`, content: "x".repeat(500) },
        ]).flat(),
      ],
    };
    const fitted = fitToolContext(request, {
      budget: budget(800),
      protection: { getState: () => "state" },
    });
    expect(JSON.stringify(fitted).length).toBeLessThan(JSON.stringify(request).length);
  });

  it("keeps the newest complete retrieval page when older groups can be removed", () => {
    const request = {
      messages: [
        { role: "system", content: "system" },
        ...Array.from({ length: 3 }, (_, i) => [
          { role: "assistant", content: "", tool_calls: [{ id: `old-${i}`, type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "x".repeat(500) }) } }] },
          { role: "tool", tool_call_id: `old-${i}`, content: "old noise ".repeat(400) },
        ]).flat(),
        { role: "assistant", content: "", tool_calls: [{ id: "retrieval-1", type: "function", function: { name: "read_tool_result", arguments: JSON.stringify({ index: 1 }) } }] },
        { role: "tool", tool_call_id: "retrieval-1", content: "BEGIN evidence " + "e".repeat(1_500) + " END evidence" },
      ],
    };
    const fitted = fitToolContext(request, {
      budget: budget(3_000),
      protection: { getState: () => "state" },
    });
    const latest = fitted.messages.find((message: any) => message.tool_call_id === "retrieval-1");
    expect(latest.content).toContain("BEGIN");
    expect(latest.content).toContain("END evidence");
    expect(latest.content).not.toContain("output shortened");
  });

  it("throws before a request when system plus exact state is irreducible", () => {
    expect(() => fitToolContext(
      { messages: [{ role: "system", content: "instructions" }] },
      { budget: budget(1), protection: { getState: () => "state" } },
    )).toThrow(ContextBudgetError);
  });

  it("archives generated prose under stable canonical keys without mutating history", () => {
    const draft = "latest draft ".repeat(3_000);
    const repair = "repair the unfinished analysis " + "r".repeat(10_000);
    const page = JSON.stringify({
      source_offset: 500,
      next_offset: 6_000,
      content: "NEWEST PAGE\n" + "e".repeat(5_400) + "\nEND PAGE",
    });
    const request = {
      tools: [{
        type: "function",
        function: {
          name: "read_reproduction_context",
          description: "schema ".repeat(500),
          parameters: { type: "object" },
        },
      }],
      messages: [
        { role: "system", content: "fixed ".repeat(1_100) },
        { role: "user", content: "immutable initial instructions " + "i".repeat(1_000) },
        { role: "assistant", content: draft },
        { role: "user", content: repair },
        { role: "assistant", content: "", tool_calls: [{ id: "read-1", type: "function", function: { name: "read_reproduction_context", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "read-1", content: page },
      ],
    };
    const archive = new Map<string, string>();
    const seenBounds: number[] = [];
    const protection = {
      getState: (maxBytes = 2_500) => {
        seenBounds.push(maxBytes);
        return "s".repeat(Math.max(0, maxBytes - 2));
      },
      archiveContext: (key: string, text: string) => {
        const existing = archive.get(key);
        if (existing !== undefined && existing !== text) throw new Error("archive changed");
        archive.set(key, text);
        return `[Archived ${key}; use read_reproduction_context.]`;
      },
    };

    const first = fitToolContext(request, { budget: budget(23_744), protection });
    const second = fitToolContext(request, { budget: budget(23_744), protection });
    expect(request.messages[2].content).toBe(draft);
    expect(request.messages[3].content).toBe(repair);
    expect(archive.get("assistant-2")).toBe(draft);
    expect(archive.get("user-3")).toBe(repair);
    expect(archive.size).toBe(2);
    expect(seenBounds).toContain(2_500);
    for (const fitted of [first, second]) {
      expect(fitted.messages.find((message: any) => message.tool_call_id === "read-1")?.content).toBe(page);
      const ids = fitted.messages.filter((message: any) => message.role === "tool")
        .map((message: any) => message.tool_call_id);
      const declared = fitted.messages.flatMap((message: any) => message.tool_calls ?? [])
        .map((call: any) => call.id);
      expect(ids.every((id: string) => declared.includes(id))).toBe(true);
    }
  });

  it("preserves one bounded active action while archiving verbose latest repair and all assistant prose", () => {
    const oldDraft = "OLD ASSISTANT DRAFT " + "a".repeat(8_000);
    const latestDraft = "LATEST ASSISTANT DRAFT " + "b".repeat(8_000);
    const repair = "Continue the ordinary repair using exact claim C-7. " + "r".repeat(18_000);
    const action = "ACT NOW: run the existing verification for claim C-7, then submit its measured evidence.";
    const archive = new Map<string, string>();
    const activeBounds: number[] = [];
    const request = {
      messages: [
        { role: "system", content: "fixed ".repeat(500) },
        { role: "user", content: "initial scientific prompt" },
        { role: "assistant", content: oldDraft },
        { role: "user", content: "repair an earlier claim " + "x".repeat(5_000) },
        { role: "assistant", content: latestDraft },
        { role: "user", content: repair },
      ],
    };
    const protection = {
      getState: () => "bounded ledger",
      getActiveInstruction: (maxBytes?: number) => {
        activeBounds.push(maxBytes ?? -1);
        return action;
      },
      archiveContext: (key: string, text: string) => {
        archive.set(key, text);
        return `[Archived ${key}; retrieve with read_reproduction_context.]`;
      },
    };

    const fitted = fitToolContext(request, { budget: budget(4_000), protection });
    expect(activeBounds).toEqual([ACTIVE_INSTRUCTION_MAX_BYTES]);
    expect(fitted.messages.at(-1)).toEqual({ role: "user", content: action });
    expect(fitted.messages.filter((message: any) => message.content === action)).toHaveLength(1);
    expect(JSON.stringify(fitted)).not.toContain("Archived assistant");
    expect(JSON.stringify(fitted)).not.toContain("Archived user");
    expect(archive.get("assistant-2")).toBe(oldDraft);
    expect(archive.get("assistant-4")).toBe(latestDraft);
    expect(archive.get("user-5")).toBe(repair);
    expect(request.messages[4].content).toBe(latestDraft);
    expect(request.messages[5].content).toBe(repair);
  });

  it("caps active instructions by full serialized UTF-8 bytes under a tight provider budget", () => {
    const verbose = "Execute claim λ safely 😀\n" + "😀\\\n".repeat(2_000);
    const fitted = fitToolContext({
      tools: [{ type: "function", function: { name: "run_command", parameters: {} } }],
      messages: [
        { role: "system", content: "fixed" },
        { role: "user", content: "initial" },
      ],
    }, {
      budget: budget(3_000),
      protection: {
        getState: () => "state",
        getActiveInstruction: () => verbose,
      },
    });
    const active = fitted.messages.at(-1).content;
    expect(active).toContain("Execute claim λ safely 😀");
    expect(active).toContain("projection truncated");
    expect(Buffer.byteLength(JSON.stringify(active), "utf8")).toBeLessThanOrEqual(ACTIVE_INSTRUCTION_MAX_BYTES);
    expect(active.includes("\uFFFD")).toBe(false);
  });

  it("keeps forced-final STOP last and does not add a competing active instruction", () => {
    const stop = "STOP: do not call tools; write the final bounded logbook.";
    let snapshots = 0;
    const fitted = fitToolContext({
      messages: [
        { role: "system", content: "fixed" },
        { role: "user", content: "initial" },
        { role: "assistant", content: "verbose draft ".repeat(500) },
        { role: "user", content: stop },
      ],
    }, {
      budget: budget(1_500),
      protection: {
        getState: () => "state",
        getActiveInstruction: () => {
          snapshots++;
          return "CONTINUE REPAIR (must not override STOP)";
        },
        archiveContext: key => `[Archived ${key}]`,
      },
    });
    expect(snapshots).toBe(0);
    expect(fitted.messages.at(-1)).toEqual({ role: "user", content: stop });
    expect(JSON.stringify(fitted)).not.toContain("CONTINUE REPAIR");
  });

  it("does not archive the latest forced-final STOP control", () => {
    const archived: string[] = [];
    const stop = "STOP: do not call tools; write the final logbook.";
    const fitted = fitToolContext({
      messages: [
        { role: "system", content: "x".repeat(500) },
        { role: "user", content: "initial" },
        { role: "assistant", content: "draft ".repeat(500) },
        { role: "user", content: stop },
      ],
    }, {
      budget: budget(1_500),
      protection: {
        getState: () => "state",
        archiveContext: (key, text) => {
          archived.push(key);
          return `[Archived ${key}: ${text.length}]`;
        },
      },
    });
    expect(archived).toContain("assistant-2");
    expect(archived).not.toContain("user-3");
    expect(fitted.messages.some((message: any) => message.content === stop)).toBe(true);
    expect((fitted as any).tools).toBeUndefined();
  });

  it("fails explicitly rather than corrupting an irreducible newest context page", () => {
    const page = JSON.stringify({
      source_offset: 500,
      next_offset: 2_500,
      content: "λ".repeat(2_000),
    });
    const request = {
      tools: [{ type: "function", function: { name: "read_reproduction_context", parameters: {} } }],
      messages: [
        { role: "system", content: "fixed" },
        { role: "user", content: "initial" },
        { role: "assistant", content: "", tool_calls: [{ id: "context-1", type: "function", function: { name: "read_reproduction_context", arguments: JSON.stringify({ key: "assistant-2", offset: 500 }) } }] },
        { role: "tool", tool_call_id: "context-1", content: page },
      ],
    };
    expect(() => fitToolContext(request, {
      budget: budget(1_500),
      protection: {
        getState: maxBytes => "s".repeat(Math.min(100, maxBytes ?? 100)),
        archiveContext: key => `[Archived ${key}]`,
      },
    })).toThrow(/newest retrieval page is irreducible/);
    expect(request.messages[3].content).toBe(page);
    expect(JSON.parse(request.messages[3].content).source_offset).toBe(500);
  });

  it("uses the opt-in retrieval resizer with canonical source arguments and valid paging JSON", () => {
    const prefix = "[Tool call #9]\n";
    const fullPage = JSON.stringify({
      source_offset: 500,
      next_offset: 6_500,
      content: "z".repeat(6_000),
    });
    const canonicalArgs = JSON.stringify({ key: "assistant-2", offset: 500, max_chars: 6_000 });
    const seen: Array<{ name: string; args: Record<string, unknown>; original: string; maxBytes: number }> = [];
    const request = {
      tools: [{ type: "function", function: { name: "read_reproduction_context", parameters: {} } }],
      messages: [
        { role: "system", content: "fixed ".repeat(150) },
        { role: "user", content: "initial" },
        { role: "assistant", content: "", tool_calls: [{ id: "context-9", type: "function", function: { name: "read_reproduction_context", arguments: canonicalArgs } }] },
        { role: "tool", tool_call_id: "context-9", content: prefix + fullPage },
      ],
    };
    const fitted = fitToolContext(request, {
      budget: budget(5_000),
      protection: {
        getState: () => "state",
        archiveContext: key => `[Archived ${key}]`,
        resizeRetrieval: (name, args, original, maxBytes) => {
          seen.push({ name, args, original, maxBytes });
          const parsed = JSON.parse(original);
          const length = Math.max(1, maxBytes - 120);
          return JSON.stringify({
            source_offset: parsed.source_offset,
            next_offset: parsed.source_offset + length,
            content: parsed.content.slice(0, length),
          });
        },
      },
    });
    const result = fitted.messages.find((message: any) => message.tool_call_id === "context-9").content;
    expect(result.match(/\[Tool call #9\]/g)).toHaveLength(1);
    const resized = JSON.parse(result.slice(prefix.length));
    expect(resized.source_offset).toBe(500);
    expect(resized.next_offset).toBe(500 + resized.content.length);
    expect(seen[0]).toMatchObject({
      name: "read_reproduction_context",
      args: { key: "assistant-2", offset: 500, max_chars: 6_000 },
      original: fullPage,
      maxBytes: 4_000,
    });
    expect(request.messages[2].tool_calls[0].function.arguments).toBe(canonicalArgs);
    expect(request.messages[3].content).toBe(prefix + fullPage);
  });

  it("evicts nonprotected call/result members from a multi-call retrieval group", () => {
    const ordinaryCalls = Array.from({ length: 20 }, (_, index) => ({
      id: `ordinary-${index}`,
      type: "function",
      function: { name: "run_command", arguments: JSON.stringify({ command: `echo ${index}` }) },
    }));
    const latestCall = {
      id: "latest-context",
      type: "function",
      function: { name: "read_reproduction_context", arguments: JSON.stringify({ offset: 500 }) },
    };
    const request = {
      tools: [
        { type: "function", function: { name: "run_command", parameters: {} } },
        { type: "function", function: { name: "read_reproduction_context", parameters: {} } },
      ],
      messages: [
        { role: "system", content: "fixed" },
        { role: "user", content: "initial" },
        { role: "assistant", content: "", tool_calls: [...ordinaryCalls, latestCall] },
        ...ordinaryCalls.map(call => ({
          role: "tool",
          tool_call_id: call.id,
          content: "old result ".repeat(300),
        })),
        {
          role: "tool",
          tool_call_id: latestCall.id,
          content: JSON.stringify({ source_offset: 500, next_offset: 1_500, content: "n".repeat(1_000) }),
        },
      ],
    };
    const fitted = fitToolContext(request, {
      budget: budget(3_500),
      protection: {
        getState: () => "state",
        archiveContext: key => `[Archived ${key}]`,
      },
    });
    const declaration = fitted.messages.find((message: any) =>
      message.role === "assistant" && message.tool_calls?.some((call: any) => call.id === "latest-context"));
    expect(declaration.tool_calls.map((call: any) => call.id)).toEqual(["latest-context"]);
    expect(fitted.messages.find((message: any) => message.tool_call_id === "latest-context")).toBeTruthy();
    const resultIds = fitted.messages.filter((message: any) => message.role === "tool")
      .map((message: any) => message.tool_call_id);
    const declaredIds = fitted.messages.flatMap((message: any) => message.tool_calls ?? [])
      .map((call: any) => call.id);
    expect(resultIds.every((id: string) => declaredIds.includes(id))).toBe(true);
    expect(request.messages[2].tool_calls).toHaveLength(21);
  });
});