import { describe, expect, it } from "vitest";
import { renderSourcePage } from "../reproduction-source-page";

const PATH = "/work/paper.md";
const verified = /^Verified file: \/work\/paper\.md\nReturned characters: (\d+)-(\d+) of (\d+)\n---\n/;

function readPage(page: string, text: string, offset: number, requested: number) {
  const match = verified.exec(page);
  expect(match).not.toBeNull();
  const start = Number(match![1]);
  const end = Number(match![2]);
  expect(start).toBe(offset);
  expect(Number(match![3])).toBe(text.length);
  expect(end).toBeLessThanOrEqual(offset + requested);
  expect(end).toBeLessThanOrEqual(text.length);
  expect(page.slice(match![0].length, match![0].length + end - start)).toBe(text.slice(start, end));
  expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(9_000);
  if (end < text.length) {
    expect(page).toContain(`Use offset=${end} to continue`);
  } else {
    expect(page).not.toContain("Use offset=");
  }
  return end;
}

describe("budget-aware verified source pages", () => {
  it("pages contiguously through long text, with the actual next offset and bounded wrappers", () => {
    const text = "An observation about results.\n".repeat(2000);
    let offset = 0;
    let pages = 0;
    while (offset < text.length) {
      const page = renderSourcePage(PATH, text, offset);
      const next = readPage(page, text, offset, 12_000);
      expect(next).toBeGreaterThan(offset);
      offset = next;
      pages++;
      expect(pages).toBeLessThan(100);
    }
    expect(pages).toBeGreaterThan(1);
    expect(offset).toBe(text.length);
  });

  it("counts JSON escaping and multibyte Unicode inside the serialized byte budget", () => {
    const text = '\"\\\n\t\u0000😀漢字'.repeat(3500);
    let offset = 0;
    let pages = 0;
    while (offset < text.length) {
      const next = readPage(renderSourcePage(PATH, text, offset), text, offset, 12_000);
      expect(next).toBeGreaterThan(offset);
      expect(next < text.length && text.charCodeAt(next - 1) >= 0xd800 && text.charCodeAt(next - 1) <= 0xdbff
        && text.charCodeAt(next) >= 0xdc00 && text.charCodeAt(next) <= 0xdfff).toBe(false);
      offset = next;
      pages++;
      expect(pages).toBeLessThan(100);
    }
    expect(pages).toBeGreaterThan(1);
  });

  it("honors small requested bounds and refuses an impossible partial surrogate", () => {
    const text = "ab😀cd";
    expect(readPage(renderSourcePage(PATH, text, 0, 1), text, 0, 1)).toBe(1);
    expect(readPage(renderSourcePage(PATH, text, 0, 3), text, 0, 3)).toBe(2);
    expect(readPage(renderSourcePage(PATH, text, 2, 2), text, 2, 2)).toBe(4);
    expect(renderSourcePage(PATH, text, 2, 1)).toMatch(/^Refused:/);
    expect(renderSourcePage(PATH, text, 3)).toMatch(/^Refused: invalid source offset/);
  });

  it("refuses invalid and beyond-end offsets without shifting their canonical location", () => {
    for (const offset of [-1, 4, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(renderSourcePage(PATH, "abc", offset)).toMatch(/^Refused:/);
    }
    expect(readPage(renderSourcePage(PATH, "abc", 3), "abc", 3, 12_000)).toBe(3);
    for (const requested of [0, -1, 1.2, Number.NaN]) {
      expect(renderSourcePage(PATH, "abc", 0, requested)).toMatch(/^Refused:/);
    }
  });

  it("refuses an oversized verified wrapper rather than returning an over-budget page", () => {
    expect(renderSourcePage(`/work/${"p".repeat(9500)}`, "abc")).toMatch(/^Refused:/);
  });
});