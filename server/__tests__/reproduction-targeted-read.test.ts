import { describe, it, expect } from "vitest";
import { readTargetedSourcePage, renderSourcePage } from "../reproduction-source-page";

describe("targeted verified source reads", () => {
  const path = "/work/materials/analysis.py";
  const prefix = "# unrelated setup\n".repeat(2500);
  const section = "def make_layer_summary(rows):\n    return rows.mean()\n";
  const text = prefix + section + "# other analysis\n".repeat(500);
  it("retrieves a late function in one bounded canonical page without a separate grep", () => {
    const result = readTargetedSourcePage(path, text, { query: "def make_layer_summary", max_chars: section.length });
    expect(result).toContain(`Returned characters: ${prefix.length}-${prefix.length + section.length} of ${text.length}`);
    expect(result).toContain(section);
    expect(result).not.toContain("# unrelated setup");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(9000);
  });
  it("preserves the ordinary read behavior and continuation", () => {
    expect(readTargetedSourcePage(path, text, { offset: 900, max_chars: 80 })).toBe(renderSourcePage(path, text, 900, 80));
    expect(readTargetedSourcePage(path, text, {})).toBe(renderSourcePage(path, text));
  });
  it("treats regex characters literally and starts searching at the supplied offset", () => {
    const source = "a+b(x)\nfirst\na+b(x)\nsecond";
    expect(readTargetedSourcePage(path, source, { query: "a+b(x)", offset: 1 })).toContain("Returned characters: 13-");
  });
  it("does not turn a missing literal into read evidence or a scientific blocker", () => {
    const result = readTargetedSourcePage(path, text, { query: "def absent" });
    expect(result).toContain("navigation feedback");
    expect(result).not.toContain("Verified file:");
  });
  it.each(["", " ", "a".repeat(129), 42, null])("refuses invalid query %s", query => {
    expect(readTargetedSourcePage(path, text, { query })).toMatch(/^Refused:/);
  });
  it.each([{offset:-1}, {offset:"1"}, {offset:1.5}, {max_chars:0}, {max_chars:"100"}])("refuses malformed range %j", args => {
    expect(readTargetedSourcePage(path, text, {query:"def",...args})).toMatch(/^Refused:/);
  });
  it("keeps Unicode boundaries and serialized page limits", () => {
    expect(readTargetedSourcePage(path, "😀def test", { query:"def", offset:1 })).toMatch(/^Refused:/);
    const result = readTargetedSourcePage(path, "😀".repeat(10000) + section + "😀".repeat(10000), {query:"def",max_chars:40000});
    expect(result).toContain("Returned characters: 20000-");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(9000);
  });
});
