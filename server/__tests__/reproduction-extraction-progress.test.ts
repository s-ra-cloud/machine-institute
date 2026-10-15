import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ loop: vi.fn() }));
vi.mock("../model-service", () => ({ runToolLoop: mock.loop }));
import { extractReproductionClaims, extractionRepairPassage } from "../reproduction-extraction";
import { prepareSourcePackets } from "../reproduction-packets";
const sentence = (n: number) => `The measured experimental score for condition ${n} was 0.91.`;
const paper = Array.from({ length: 5 }, (_, i) =>
  Array.from({ length: 5 }, (_, j) => sentence(i * 5 + j)).join("\n").padEnd(5400, " ")).join("");
const candidate = (claim: string) => ({ claim, source_quote: claim });
const input = () => ({ paper, instructions: "Custom science", config: {} as any, deadline: Date.now() + 60000 });
beforeEach(() => vi.resetAllMocks());
it("offers canonical repair context without accepting a correction or clearing a rejection implicitly", async () => {
  const accepted = vi.fn();
  mock.loop.mockImplementation(async (_c, _s, _p, _t, execute, opts) => {
    const wrong = `Invented prefix. ${sentence(0)}`;
    const refusal = await execute("submit_claims", { claims: [candidate(wrong)] });
    expect(refusal).toContain("canonicalPassage");
    expect(refusal).toContain(sentence(0));
    expect(accepted).not.toHaveBeenCalled();
    const stillOpen = await execute("submit_claims", { claims: [candidate(sentence(0))] });
    expect(stillOpen).toContain('replaces=\\"E1\\"');
    expect(opts.isStageComplete()).toBe(false);
    await execute("submit_claims", { claims: [{ ...candidate(sentence(0)), replaces: "E1" }], has_more: false });
    expect(opts.isStageComplete()).toBe(true);
    return { toolCalls: [{}, {}, {}], rounds: 3, stoppedBy: "model" };
  });
  const result = await extractReproductionClaims({ ...input(), paper: sentence(0), onAccepted: accepted });
  expect(result.claims).toHaveLength(1);
  expect(accepted).toHaveBeenCalledTimes(1);
});
it("never constructs repair context from guessed text or outside the current packet", () => {
  expect(extractionRepairPassage("This fabricated source shares no matching phrase.", sentence(0))).toBeUndefined();
  const source = `Canonical introduction. ${sentence(0)}\nCanonical ending.`;
  const hint = extractionRepairPassage(`Incorrect prefix ${sentence(0)}`, source);
  expect(hint).toBeDefined();
  expect(source.includes(hint!)).toBe(true);
});
function respond(get: (packet: number, attempt: number, text: string) => unknown[]) {
  let packet = 0;
  mock.loop.mockImplementation(async (_c, _s, text, _t, execute, opts) => {
    const p = packet++;
    const toolCalls = [];
    for (let attempt = 0; attempt < opts.maxToolCalls; attempt++) {
      opts.onOutcome?.({ kind: "arguments", round: attempt + 1, callCount: attempt });
      const result = await execute("submit_claims", { claims: get(p, attempt, text) }).catch(() => "error");
      toolCalls.push({ result });
      opts.onOutcome?.({ kind: "tool", round: attempt + 1, callCount: attempt + 1 });
      if (opts.isStageComplete() || opts.getStallReason()) break;
    }
    return { toolCalls, rounds: toolCalls.length, stoppedBy: opts.isStageComplete() ? "model" : "tool-budget" };
  });
}
it.each([12, 15])("retains all %i grounded candidates and inspects every packet", async count => {
  respond((p) => Array.from({ length: Math.min(5, Math.max(0, count - p * 5)) }, (_, j) => candidate(sentence(p * 5 + j))));
  const onAccepted = vi.fn(async () => {});
  const result = await extractReproductionClaims({ ...input(), onAccepted });
  expect(onAccepted).toHaveBeenCalledTimes(count);
  expect(result.coverage.termination).toBe("complete");
  expect(mock.loop).toHaveBeenCalledTimes(prepareSourcePackets(paper).length);
});
it("retains valid siblings and deduplicates repeated repairs without inferring metadata", async () => {
  respond((p, attempt) => p ? [] : [candidate(sentence(0)), { ...candidate(sentence(1)), ...(attempt ? {} : { original_value: "invented" }) }]);
  const onAccepted = vi.fn(async () => {});
  const result = await extractReproductionClaims({ ...input(), onAccepted });
  expect(result.claims).toHaveLength(2);
  expect(onAccepted).toHaveBeenCalledTimes(2);
  expect(result.claims[1].original_value).toBeUndefined();
});
it("retains early claims after later validation exhaustion, with aggregate and local counts", async () => {
  respond(p => p === 0 ? [candidate(sentence(0))] : [{ ...candidate(sentence(p * 5)), required_material: "invented" }]);
  const accepted = vi.fn();
  const progress = vi.fn();
  await expect(extractReproductionClaims({ ...input(), onAccepted: accepted, onProgress: progress })).rejects.toThrow("unresolved source packets");
  expect(accepted).toHaveBeenCalledTimes(1);
  expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({ termination: "failed", failure: "incomplete-coverage" });
});
it("visits late packets beyond six without exceeding the existing eighteen-call allowance", async () => {
  const long = Array.from({ length: 9 }, (_, i) => sentence(i).padEnd(5400, " ")).join("");
  respond((_p, _a, text) => [candidate(text.match(/The measured experimental score for condition \d+ was 0.91./)![0])]);
  const result = await extractReproductionClaims({ ...input(), paper: long });
  expect(result.inspectedPackets).toBe(prepareSourcePackets(long).length);
  expect(result.claims.some(c => c.claim === sentence(8))).toBe(true);
  expect(result.calls).toBeLessThanOrEqual(18);
});
it("lets productive batches borrow spare calls within the unchanged global bound", async () => {
  let n = 0;
  mock.loop.mockImplementation(async (_c, _s, _p, _t, execute, opts) => {
    const toolCalls = [];
    while (!opts.isStageComplete() && toolCalls.length < opts.maxToolCalls) {
      toolCalls.push(await execute("submit_claims", { claims: [candidate(sentence(n++))], has_more: n < 7 }));
    }
    return { toolCalls, rounds: toolCalls.length, stoppedBy: "model" };
  });
  const result = await extractReproductionClaims({ ...input(), paper: Array.from({ length: 7 }, (_, i) => sentence(i)).join("\n") });
  expect(result.coverage.termination).toBe("complete");
  expect(n).toBe(7);
});
it.each(["duplicate", "invalid", "productive"])("bounds additional batches without hiding remaining work: %s", async kind => {
  let calls = 0;
  mock.loop.mockImplementation(async (_c, _s, _p, _t, execute, opts) => {
    const toolCalls = [];
    while (toolCalls.length < opts.maxToolCalls && !opts.getStallReason() && !opts.isStageComplete()) {
      const claim = kind === "invalid" ? "This text is not in the paper."
        : sentence(kind === "duplicate" ? 0 : calls);
      calls++;
      toolCalls.push(await execute("submit_claims", { claims: [candidate(claim)], has_more: true }));
    }
    return { toolCalls, rounds: toolCalls.length, stoppedBy: opts.getStallReason() ? "no-progress" : "tool-budget" };
  });
  const progress = vi.fn();
  await expect(extractReproductionClaims({ ...input(),
    paper: Array.from({ length: 20 }, (_, i) => sentence(i)).join("\n"), onProgress: progress,
  })).rejects.toThrow(kind === "invalid" ? "no grounded claims" : "unresolved source packets");
  expect(calls).toBe(kind === "productive" ? 18 : kind === "duplicate" ? 4 : 3);
  expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({ termination: "failed" });
});
it("accepts a quote that only drops LaTeX delimiters, storing the exact source text, without spending repairs", async () => {
  const latex = "Semantic minus negated is +0.233 with a 95% bootstrap confidence interval of [0.181, 0.290] and permutation \\(p = 0.00025\\).";
  const plain = "Semantic minus negated is +0.233 with a 95% bootstrap confidence interval of [0.181, 0.290] and permutation p = 0.00025.";
  respond(() => [candidate(plain)]);
  const result = await extractReproductionClaims({ ...input(), paper: `## Results\n${latex}\n` });
  expect(result.claims.map(c => c.claim)).toEqual([latex]);
  expect(result.calls).toBe(1);
});
it("deduplicates claims in overlapping packets", async () => {
  const overlap = " ".repeat(5500) + sentence(0) + " ".repeat(5000);
  expect(prepareSourcePackets(overlap).filter(p => p.text.includes(sentence(0))).length).toBe(2);
  respond((_p, _a, text) => text.includes(sentence(0)) ? [candidate(sentence(0))] : []);
  const onAccepted = vi.fn(async () => {});
  await extractReproductionClaims({ ...input(), paper: overlap, onAccepted });
  expect(onAccepted).toHaveBeenCalledOnce();
});
it("fails without claims, and retains checkpoint failures as hard errors", async () => {
  respond(() => []);
  await expect(extractReproductionClaims(input())).rejects.toThrow("no grounded claims");
  respond(() => [candidate(sentence(0))]);
  await expect(extractReproductionClaims({ ...input(), onAccepted: async () => { throw new Error("Storage unavailable"); } })).rejects.toThrow("Storage unavailable");
});
it("does not convert provider or deadline failures to partial success", async () => {
  respond(() => [candidate(sentence(0))]);
  await expect(extractReproductionClaims({ ...input(), deadline: 0 })).rejects.toThrow("deadline");
  mock.loop.mockRejectedValue(new Error("Provider authentication failed"));
  await expect(extractReproductionClaims(input())).rejects.toThrow("Provider authentication");
});
it("reserves structured-output headroom without increasing extraction tool calls", async () => {
  respond(p => p ? [] : [candidate(sentence(0))]);
  await extractReproductionClaims(input());
  for (const call of mock.loop.mock.calls) {
    expect(call[5]).toMatchObject({ maxTokens: 8000, maxPrematureStopRecoveries: 1 });
    expect(call[5].maxToolCalls).toBeLessThanOrEqual(18);
  }
});
it("reserves visits to later packets despite early invalid candidates", async () => {
  const long = Array.from({ length: 16 }, (_, i) => sentence(i).padEnd(5400, " ")).join("");
  respond((p, _attempt, text) => p < 2
    ? [{ ...candidate(sentence(p)), original_value: "invented" }]
    : [candidate(text.match(/The measured experimental score for condition \d+ was 0.91./)![0])]);
  const progress = vi.fn();
  await expect(extractReproductionClaims({ ...input(), paper: long, onProgress: progress })).rejects.toThrow("unresolved");
  expect(progress.mock.calls.at(-1)?.[0].packets).toHaveLength(16);
  expect(progress.mock.calls.at(-1)?.[0].calls).toBeLessThanOrEqual(18);
});
it("rejects oversized coverage before provider calls rather than silently truncating", async () => {
  await expect(extractReproductionClaims({ ...input(), paper: "x ".repeat(60000) })).rejects.toThrow("coverage exceeds");
  expect(mock.loop).not.toHaveBeenCalled();
});
it("keeps rejection IDs actionable after a failed replacement and does not erase them with empty submissions", async () => {
  let state: any;
  mock.loop.mockImplementation(async (_c, _s, _p, _t, execute, opts) => {
    const first = await execute("submit_claims", { claims: [candidate("A made up scientific claim with wrong words.")] });
    expect(first).toContain("E1");
    const second = await execute("submit_claims", { claims: [{ ...candidate(sentence(0)), original_value: "wrong", replaces: "E1" }] });
    expect(second).toContain("E1");
    expect(second).toContain("original_value");
    expect(await execute("submit_claims", { claims: [], has_more: false })).toContain("E1");
    state = opts.contextProtection.getState();
    return { toolCalls: [{}, {}, {}], rounds: 3, stoppedBy: "tool-budget" };
  });
  const progress = vi.fn();
  await expect(extractReproductionClaims({ ...input(), paper: sentence(0), onProgress: progress })).rejects.toThrow("no grounded claims");
  expect(state).toContain("E1");
  expect(progress.mock.calls.at(-1)?.[0].packets[0]).toMatchObject({
    stopReason: "tool-budget", unresolved: [{ id: "E1", errors: expect.arrayContaining([expect.stringContaining("original_value")]) }],
  });
});
it("cannot replace an accepted claim or clear an unknown replacement reference by submitting nothing", async () => {
  mock.loop.mockImplementation(async (_c, _s, _p, _t, execute, opts) => {
    await execute("submit_claims", { claims: [candidate(sentence(0))], has_more: true });
    const rejected = await execute("submit_claims", {
      claims: [{ ...candidate(sentence(1)), replaces: "R1" }], has_more: false,
    });
    expect(rejected).toContain("accepted claims cannot be replaced");
    expect(await execute("submit_claims", { claims: [], has_more: false })).toContain("E1");
    expect(opts.isStageComplete()).toBe(false);
    return { toolCalls: [{}, {}, {}], rounds: 3, stoppedBy: "tool-budget" };
  });
  const onAccepted = vi.fn();
  await expect(extractReproductionClaims({ ...input(), paper: sentence(0) + "\n" + sentence(1), onAccepted })).rejects.toThrow("unresolved");
  expect(onAccepted).toHaveBeenCalledTimes(1);
});
it("explicitly copies an exact quote to repair a rejected paraphrase without inventing optional metadata", async () => {
  mock.loop.mockImplementation(async (_c, _s, _p, _t, execute, opts) => {
    expect(await execute("submit_claims", { claims: [candidate("Paraphrased and unsupported scientific claim.")] })).toContain("E1");
    expect(await execute("submit_claims", { claims: [{
      source_quote: sentence(0), copy_source_quote: true, replaces: "E1",
    }], has_more: false })).toBe("Extraction accepted.");
    expect(opts.isStageComplete()).toBe(true);
    return { toolCalls: [{}, {}], rounds: 2, stoppedBy: "model" };
  });
  const result = await extractReproductionClaims({ ...input(), paper: sentence(0) });
  expect(result.claims[0]).toMatchObject(candidate(sentence(0)));
  expect(result.claims[0].original_value).toBeUndefined();
  expect(result.claims[0]).not.toHaveProperty("copy_source_quote");
});
it.each([
  { source_quote: "This quotation does not occur in the actual paper.", copy_source_quote: true },
  { source_quote: sentence(0), claim: "Conflicting claim", copy_source_quote: true },
  { source_quote: sentence(0), copy_source_quote: true, original_value: "fabricated" },
  { source_quote: sentence(0) },
  { source_quote: sentence(0), copy_source_quote: "true" },
])("does not use quote copying to bypass evidence validation: %j", async submission => {
  respond(() => [submission]);
  const accepted = vi.fn();
  await expect(extractReproductionClaims({ ...input(), paper: sentence(0), onAccepted: accepted })).rejects.toThrow("no grounded claims");
  expect(accepted).not.toHaveBeenCalled();
});
it("does not truncate oversized copied quotes into accepted claims", async () => {
  const quote = sentence(0).repeat(40);
  respond(() => [{ source_quote: quote, copy_source_quote: true }]);
  await expect(extractReproductionClaims({ ...input(), paper: quote })).rejects.toThrow("no grounded claims");
});