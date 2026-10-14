import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fixture from "./fixtures/paper-bookkeeping.json";
import { preparationIssue } from "../reproduction-preparation";

const path = "/work/materials/analysis1_baseline.py";
const dependency = "/work/data/confidence_history.json";
const source = `ROOT_DIR = Path(__file__).resolve().parent.parent\n${fixture.functionSource}\ndef main():\n    ${fixture.initialization}\n    update_confidence(confidence_path, confidence, rationale)\n`;
const read = (index: number, p: string, text: string) => ({
  index, name: "read_file", args: { path: p }, result: `Verified file: ${p}\n${text}`, error: false,
});

describe("pre-execution preparation against shipped bookkeeping source", () => {
  it("blocks the recognizable dependency before any execution, without writing data", () => {
    expect(preparationIssue(path, source, [])).toContain(`reads then rewrites ${dependency}`);
    expect(preparationIssue(path, source, [read(1, path, fixture.functionSource)])).toContain("Refused");
    expect(preparationIssue(path, source, [read(1, dependency, "{}")])).toContain("Refused");
    expect(preparationIssue(path, source, [
      read(1, path, fixture.functionSource), read(2, dependency, "{}"),
    ])).toBeUndefined();
  });
  it("rejects failed, unrelated, and pre-edit inspection", () => {
    const reads = [read(1, path, fixture.functionSource), read(2, dependency, "{}")];
    expect(preparationIssue(path, source, [{ ...reads[0], error: true }, reads[1]])).toContain("Refused");
    expect(preparationIssue(path, source, [reads[0], read(2, "/work/data/other.json", "{}")])).toContain("Refused");
    const write = { index: 3, name: "write_file", args: { path, content: source },
      result: `Wrote ${source.length} chars to ${path}.`, error: false };
    expect(preparationIssue(path, source, [...reads, write])).toContain("Refused");
  });
  it("does not classify arbitrary filenames or block scripts without the recognized pattern", () => {
    expect(preparationIssue(path, "print('confidence_history.json')", [])).toBeUndefined();
    expect(preparationIssue(path, source.replace("confidence_path.read_text()", "'{}'"), [])).toBeUndefined();
  });
  it("runs the exact shipped function with stdlib only, never importing the model or invoking main", () => {
    const python = `
import json, tempfile
from pathlib import Path
source = json.loads(input())
namespace = {"Path": Path, "json": json}
exec(compile(source, "shipped-update-confidence", "exec"), namespace)
update = namespace["update_confidence"]
with tempfile.TemporaryDirectory() as tmp:
    target = Path(tmp) / "confidence_history.json"
    try:
        update(target, 0.45, "test")
        raise AssertionError("Missing input should fail")
    except FileNotFoundError:
        assert not target.exists()
    target.write_text("[]")
    try:
        update(target, 0.45, "test")
        raise AssertionError("List initialization should fail")
    except TypeError:
        assert target.read_text() == "[]"
    target.write_text("{}")
    update(target, 0.45, "test")
    result = json.loads(target.read_text())
    assert result["current_confidence"] == 0.45
    assert result["history"] == [{"analysis": 1, "confidence": 0.45, "rationale": "test"}]
    result["history"].append({"analysis": 2, "confidence": 0.7})
    result["unrelated"] = "preserved"
    target.write_text(json.dumps(result))
    update(target, 0.35, "second")
    result = json.loads(target.read_text())
    assert len(result["history"]) == 2
    assert result["history"][0]["analysis"] == 2
    assert result["unrelated"] == "preserved"
print("bookkeeping cases passed")
`;
    // The interpreter needs well under a second alone; the generous timeout only
    // guards against a hung process when the full suite runs under heavy load.
    const result = spawnSync("python3", ["-I", "-c", python], {
      input: JSON.stringify(fixture.functionSource), encoding: "utf8", timeout: 120_000,
      env: { PATH: process.env.PATH },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("bookkeeping cases passed");
  }, 150_000);
});
