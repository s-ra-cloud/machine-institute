import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ loop: vi.fn() }));
vi.mock("../model-service", () => ({ runToolLoop: mock.loop }));
import { extractReproductionClaims } from "../reproduction-extraction";
import { prepareSourcePackets } from "../reproduction-packets";
const sentence = (n: number) => `The measured experimental score for condition ${n} was 0.91.`;
const paper = Array.from({ length: 5 }, (_, i) =>
  Array.from({ length: 5 }, (_, j) => sentence(i * 5 + j)).join("\n").padEnd(5400, " ")).join("");
const candidate = (claim: string) => ({ claim, source_quote: claim });
const input = () => ({ paper, instructions: "Custom science", config: {} as any, deadline: Date.now() + 60000 });
beforeEach(() => vi.resetAllMocks());
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
it("continues packet batches and refuses unresolved omissions within unchanged bounds", async () => {
  let n = 0;
  mock.loop.mockImplementation(async (_c, _s, _p, _t, execute, opts) => {
    const toolCalls = [];
    while (!opts.isStageComplete() && toolCalls.length < opts.maxToolCalls) {
      toolCalls.push(await execute("submit_claims", { claims: [candidate(sentence(n++))], has_more: n < 7 }));
    }
    return { toolCalls, rounds: toolCalls.length, stoppedBy: "model" };
  });
  await expect(extractReproductionClaims({ ...input(), paper: Array.from({ length: 7 }, (_, i) => sentence(i)).join("\n") })).rejects.toThrow("unresolved source packets");
  expect(n).toBe(3);
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
    expect(call[5]).toMatchObject({ maxTokens: 8000, maxToolCalls: 3, maxPrematureStopRecoveries: 1 });
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