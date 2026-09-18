import { describe, expect, it } from "vitest";
import type { ToolCallRecord } from "../model-service";
import { ReproductionSession } from "../reproduction-session";

const bytes = (text: string) => Buffer.byteLength(JSON.stringify(text), "utf8");

function readAllContext(session: ReproductionSession, firstArgs: Record<string, unknown>) {
  let page = JSON.parse(session.readContext(firstArgs));
  const ref = page.ref as string;
  let text = "";
  do {
    expect(bytes(JSON.stringify(page))).toBeLessThanOrEqual(6000);
    text += page.text;
    if (page.next_offset === null) break;
    page = JSON.parse(session.readContext({ ref, offset: page.next_offset, max_chars: 8000 }));
    expect(page.ref).toBe(ref);
  } while (true);
  return { ref, text };
}

function evidenceCall(index: number, result: string): ToolCallRecord {
  return {
    index,
    name: "run_command",
    args: { command: `experiment-${index} --值 '${"q".repeat(index % 20)}'` },
    result,
    durationMs: 1,
    error: false,
  };
}

describe("Reproduction session bounded durable context", () => {
  it("bounds state while making 100 long Unicode claims and values retrievable", () => {
    const session = new ReproductionSession(() => []);
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = `R${i}-🧪-${"識".repeat(i + 20)}`;
      ids.push(id);
      session.recordResult({
        id,
        claim: `Claim ${i}: ${"δ😀".repeat(500)}`,
        status: "pending",
        original_value: `reported="${i}"\n${"\u0001値".repeat(400)}`,
      });
    }

    const defaultState = session.contextState();
    expect(bytes(defaultState)).toBeLessThanOrEqual(2500);
    expect(JSON.parse(defaultState).totals).toMatchObject({ claims: 100, pending: 100 });
    const smallState = session.contextState(600);
    expect(bytes(smallState)).toBeLessThanOrEqual(600);
    expect(bytes(session.contextState(Infinity))).toBeLessThanOrEqual(2500);

    const index = readAllContext(session, { max_chars: 91 });
    for (const id of ids) expect(index.text).toContain(`claim:${id}:accepted`);
    expect(index.text).not.toContain("source:");

    const firstRef = index.text.match(/^\[(\d+)\] claim:/m)?.[1];
    expect(firstRef).toBeDefined();
    const snapshot = JSON.parse(readAllContext(session, { ref: firstRef, max_chars: 73 }).text);
    expect(snapshot.accepted.id).toBe(ids[0]);
    expect(snapshot.accepted.originalValue).toContain("\u0001値");
  });

  it("keeps rejected and accepted repair snapshots immutable and indexed", () => {
    const session = new ReproductionSession(() => []);
    session.observeToolCall(evidenceCall(1, "exit code 0\nmetric=0.91"));
    session.recordResult({ id: "R1", claim: "Accuracy", status: "pending", original_value: "0.91" });
    const refusal = session.recordResult({
      id: "R1",
      status: "verified",
      method: "not-a-method",
      evidence_tool_call_ids: [1],
      evidence_excerpt: "metric=0.91",
      evidence: `draft evidence ${"😀".repeat(100)}`,
      notes: "repair me",
      raw_input_path: `/tmp/${"資料".repeat(100)}`,
    });
    expect(refusal).toContain("invalid reproduction method");

    const before = readAllContext(session, {});
    const rejectedRef = before.text.match(/\[(\d+)\] claim:R1:rejected/)?.[1];
    expect(rejectedRef).toBeDefined();
    const rejectedText = readAllContext(session, { ref: rejectedRef }).text;
    expect(JSON.parse(rejectedText)).toMatchObject({
      kind: "rejected",
      draft: { evidence: expect.stringContaining("draft evidence"), notes: "repair me" },
      issues: [expect.stringContaining("invalid reproduction method")],
    });

    expect(session.recordResult({ id: "R1", status: "verified", method: "rerun", reproduced_value: "0.91" }))
      .toContain("evidence validated");
    const after = readAllContext(session, {});
    expect(after.text).toContain(`[${rejectedRef}] claim:R1:rejected`);
    expect(readAllContext(session, { ref: rejectedRef }).text).toBe(rejectedText);
    const acceptedRefs = [...after.text.matchAll(/\[(\d+)\] claim:R1:accepted/g)].map(match => match[1]);
    expect(new Set(acceptedRefs).size).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(readAllContext(session, { ref: acceptedRefs.at(-1) }).text).accepted.status).toBe("verified");
  });

  it("deduplicates equal archives, preserves changed versions, and freezes index paging", () => {
    const session = new ReproductionSession(() => []);
    const original = `😀 astral "quotes" \\ slash\ncontrols:\u0000\u0001\t${"資料".repeat(5000)}`;
    const first = JSON.parse(session.archiveContext("canonical-message:user-7", original));
    const duplicate = JSON.parse(session.archiveContext("canonical-message:user-7", original));
    const changed = JSON.parse(session.archiveContext("canonical-message:user-7", `${original}!`));
    expect(duplicate.ref).toBe(first.ref);
    expect(changed.ref).not.toBe(first.ref);
    expect(bytes(session.archiveContext("canonical-message:user-7", original))).toBeLessThan(250);
    expect(readAllContext(session, { ref: first.ref, max_chars: 37 }).text).toBe(original);

    const page1 = JSON.parse(session.readContext({ max_chars: 25 }));
    session.archiveContext("later", "must not enter frozen index");
    session.contextState();
    const rest = readAllContext(session, { ref: page1.ref, offset: page1.next_offset, max_chars: 25 }).text;
    const frozen = page1.text + rest;
    expect(frozen).not.toContain("later");
    expect(frozen).toContain(`[${first.ref}] canonical-message:user-7`);
    expect(frozen).toContain(`[${changed.ref}] canonical-message:user-7`);
  });

  it("pages evidence and its index with exact offsets without advancing progress", () => {
    const session = new ReproductionSession(() => []);
    const output = `exit code 0\n😀"\\\u0000\n${"結果🧬".repeat(5000)}\ntail`;
    for (let i = 1; i <= 120; i++) session.observeToolCall(evidenceCall(i, i === 1 ? output : `exit code 0\nvalue=${i}`));
    const progress = session.progress;

    let offset = 0;
    let reconstructed = "";
    do {
      const response = session.readToolResult({ tool_call_id: 1, offset, max_chars: 8000 });
      expect(bytes(response)).toBeLessThanOrEqual(6000);
      const range = response.match(/characters (\d+)-(\d+) of (\d+)\./);
      expect(range).not.toBeNull();
      const start = Number(range![1]);
      const end = Number(range![2]);
      const payloadStart = response.indexOf("\n") + 1;
      const chunk = response.slice(payloadStart, payloadStart + end - start);
      expect(chunk).toBe(output.slice(start, end));
      reconstructed += chunk;
      offset = end;
    } while (offset < output.length);
    expect(reconstructed).toBe(output);

    offset = 0;
    let index = "";
    do {
      const response = session.readToolResult({ offset, max_chars: 71 });
      expect(bytes(response)).toBeLessThanOrEqual(6000);
      const range = response.match(/characters (\d+)-(\d+) of (\d+)\./)!;
      const start = Number(range[1]);
      const end = Number(range[2]);
      const payloadStart = response.indexOf("\n") + 1;
      index += response.slice(payloadStart, payloadStart + end - start);
      offset = end;
      if (end === Number(range[3])) break;
    } while (true);
    for (let i = 1; i <= 120; i++) expect(index).toContain(`[${i}] run_command`);
    expect(session.progress).toBe(progress);

    expect(bytes(session.readToolResult({ tool_call_id: 1, offset: Infinity, max_chars: Infinity }))).toBeLessThanOrEqual(6000);
    const finite = JSON.parse(session.readContext({ ref: JSON.parse(session.archiveContext("x", "y")).ref, offset: NaN, max_chars: Infinity }));
    expect(finite.offset).toBe(0);
    expect(session.progress).toBe(progress);
  });

  it("resizes retrieved pages without refetching or losing their exact continuation", () => {
    const session = new ReproductionSession(() => []);
    const archived = `prefix-${"😀\"\\\u0001資料".repeat(3000)}-tail`;
    const notice = JSON.parse(session.archiveContext(`logbook-version-${"😀\u0001".repeat(200)}`, archived));
    for (let i = 0; i < 80; i++) session.archiveContext(`claim-index-${i}-${"識".repeat(10)}`, `value-${i}`);

    const originalPage = session.readContext({ ref: notice.ref, offset: 500, max_chars: 6000 });
    for (const limit of [4000, 2500, 1500, 800, 400]) {
      const resized = session.resizeRetrieval("read_reproduction_context", {}, originalPage, limit);
      expect(resized).toBeDefined();
      expect(bytes(resized!)).toBeLessThanOrEqual(limit);
      const page = JSON.parse(resized!);
      expect(page.offset).toBe(500);
      expect(page.end).toBe(500 + page.text.length);
      expect(page.next_offset).toBe(page.end);
      expect(page.text.length).toBeGreaterThan(0);
      expect(page.text).toBe(archived.slice(500, page.end));
      const continuation = readAllContext(session, { ref: notice.ref, offset: page.next_offset }).text;
      expect(page.text + continuation).toBe(archived.slice(500));
    }

    const indexPage = session.readContext({ offset: 500, max_chars: 6000 });
    const frozenRef = JSON.parse(indexPage).ref;
    session.archiveContext("late-index-entry", "must not mutate snapshot");
    const resizedIndex = session.resizeRetrieval("read_reproduction_context", {}, indexPage, 800)!;
    const resizedIndexPage = JSON.parse(resizedIndex);
    expect(resizedIndexPage.ref).toBe(frozenRef);
    expect(bytes(resizedIndex)).toBeLessThanOrEqual(800);
    const frozenRest = readAllContext(session, { ref: frozenRef, offset: resizedIndexPage.next_offset }).text;
    expect(resizedIndexPage.text + frozenRest).not.toContain("late-index-entry");

    const evidence = `exit code 0\n${"🧬result=\"ok\"\\\u0000".repeat(3000)}\ntail`;
    for (let i = 1; i <= 100; i++) {
      session.observeToolCall(evidenceCall(i, i === 1 ? evidence : `exit code 0\nmetric-${i}`));
    }
    const progress = session.progress;
    const evidencePage = session.readToolResult({ tool_call_id: 1, offset: 500, max_chars: 6000 });
    for (const limit of [4000, 2500, 1500, 800, 400]) {
      const resized = session.resizeRetrieval("read_tool_result", {}, evidencePage, limit);
      expect(resized).toBeDefined();
      expect(bytes(resized!)).toBeLessThanOrEqual(limit);
      const range = resized!.match(/characters (\d+)-(\d+) of (\d+)\./)!;
      const start = Number(range[1]);
      const end = Number(range[2]);
      const payloadStart = resized!.indexOf("\n") + 1;
      const chunk = resized!.slice(payloadStart, payloadStart + end - start);
      expect(start).toBe(500);
      expect(end).toBeGreaterThan(start);
      expect(chunk).toBe(evidence.slice(start, end));
      expect(session.readToolResult({ tool_call_id: 1, offset: end })).toContain(evidence.slice(end, end + 20));
    }

    const evidenceIndexPage = session.readToolResult({ offset: 500, max_chars: 6000 });
    const resizedEvidenceIndex = session.resizeRetrieval("read_tool_result", {}, evidenceIndexPage, 400)!;
    expect(bytes(resizedEvidenceIndex)).toBeLessThanOrEqual(400);
    const indexRange = resizedEvidenceIndex.match(/characters (\d+)-(\d+) of (\d+)\./)!;
    expect(Number(indexRange[1])).toBe(500);
    expect(Number(indexRange[2])).toBeGreaterThan(500);
    expect(session.resizeRetrieval("read_tool_result", {}, "unknown response", 800)).toBeUndefined();
    expect(session.resizeRetrieval("other_tool", {}, originalPage, 800)).toBeUndefined();
    expect(session.progress).toBe(progress);
  });
});