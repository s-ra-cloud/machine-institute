import { describe, expect, it } from "vitest";
import { prepareSourcePackets, restoreSourceFormatting, validateCandidate } from "../reproduction-packets";

// A fixed-offset packet edge once fell inside a word ("idence correct-margin difference ..."):
// the fragment could not be quoted as a complete finding from that packet, every repair was
// rejected, and the whole run failed before any GPU was allocated.
const finding = (n: number) => `Finding ${n}: once the exact evidence has appeared, the post-evidence correct-margin difference is -0.0${n % 10}5 with a confidence interval spanning zero.`;
const source = `We report. ${Array.from({ length: 160 }, (_, n) => finding(n)).join(" ")}`;

it("starts and ends packets on sentence boundaries so every finding is quotable within one packet", () => {
  // Precondition: the former layout (6000-character packets, 600 overlap) would start packet 2 mid-word.
  expect(/\w/.test(source[5399]) && /\w/.test(source[5400])).toBe(true);
  const packets = prepareSourcePackets(source);
  expect(packets.length).toBeGreaterThan(3);
  expect(packets[packets.length - 1].end).toBe(source.length);
  for (const [i, packet] of packets.entries()) {
    expect(packet.text).toBe(source.slice(packet.start, packet.end));
    if (i > 0) {
      expect(packet.start).toBeLessThan(packets[i - 1].end);
      expect(source.slice(packet.start - 1, packet.start + 7)).toBe(" Finding");
    }
    if (packet.end < source.length) expect(source[packet.end - 1]).toBe(" ");
  }
  for (let n = 0; n < 160; n++) {
    const text = finding(n);
    const packet = packets.find(p => p.text.includes(text));
    expect(packet, text).toBeDefined();
    expect(validateCandidate({ claim: text, source_quote: text }, packet!, source)).toEqual([]);
  }
});

describe("restoring source formatting in quotations", () => {
  it("does not erase multiplication, subscripts or mathematical command escapes", () => {
    for (const [source, quote] of [
      ["The measured x_1 value was 0.91.", "The measured x1 value was 0.91."],
      ["The measured x*y value was 0.91.", "The measured xy value was 0.91."],
      ["The measured \\alpha value was 0.91.", "The measured alpha value was 0.91."],
    ]) {
      expect(restoreSourceFormatting({ claim: quote, source_quote: quote },
        { id: "p", start: 0, end: source.length, text: source }).restored).toBe(false);
    }
  });
  // The live paper writes statistics as LaTeX; DeepSeek resubmitted the plain text three times.
  const latex = "Crucially, the paired late-layer gaps are reliable with task-level uncertainty: semantic minus negated is +0.233 with a 95% bootstrap confidence interval of [0.181, 0.290] and permutation \\(p = 0.00025\\), while semantic minus placeholder is +0.159 with a 95% confidence interval of [0.108, 0.213] and the same permutation \\(p\\)-value.";
  const text = `For the placeholder control the scores are 0.302, 0.069, and 0.143.\n${latex}\n\n## Next`;
  const packet = { id: "p", start: 0, end: text.length, text };
  const plain = "semantic minus negated is +0.233 with a 95% bootstrap confidence interval of [0.181, 0.290] and permutation p = 0.00025, while semantic minus placeholder is +0.159 with a 95% confidence interval of [0.108, 0.213] and the same permutation p-value.";

  it("stores the exact LaTeX source text for a quote that differs only in formatting", () => {
    expect(validateCandidate({ claim: plain, source_quote: plain }, packet, text)).toContain("source_quote must occur exactly in this packet");
    const { candidate, restored } = restoreSourceFormatting({ claim: plain, source_quote: plain, original_value: "p = 0.00025" }, packet);
    expect(restored).toBe(true);
    const exact = text.slice(text.indexOf("semantic minus negated"), text.indexOf("-value.") + "-value.".length);
    expect(candidate).toEqual({ claim: exact, source_quote: exact, original_value: "p = 0.00025" });
    expect(exact).toContain("permutation \\(p = 0.00025\\), while");
    expect(validateCandidate(candidate, packet, text)).toEqual([]);
  });

  it("keeps the closing delimiter of a value at the end of the quote, and collapses whitespace", () => {
    const quote = "and   permutation p = 0.00025";
    const { candidate } = restoreSourceFormatting({ claim: quote, source_quote: quote }, packet);
    expect(candidate).toEqual({ claim: "and permutation \\(p = 0.00025\\)", source_quote: "and permutation \\(p = 0.00025\\)" });
    const multiline = restoreSourceFormatting({ claim: "0.143. Crucially, the paired", source_quote: "0.143. Crucially, the paired late-layer gaps" }, packet);
    expect(multiline.candidate).toMatchObject({ source_quote: "0.143.\nCrucially, the paired late-layer gaps", claim: "0.143.\nCrucially, the paired" });
  });

  it("never accepts a changed value, a paraphrase or an ambiguous passage", () => {
    for (const quote of [plain.replace("+0.233", "+0.234"), plain.replace("is +0.233", "equals +0.233")]) {
      expect(restoreSourceFormatting({ claim: quote, source_quote: quote }, packet).restored).toBe(false);
    }
    const twice = `${latex}\n${latex}`;
    expect(restoreSourceFormatting({ claim: plain, source_quote: plain }, { id: "p", start: 0, end: twice.length, text: twice }).restored).toBe(false);
    expect(restoreSourceFormatting({ claim: latex, source_quote: latex }, packet).restored).toBe(false);
  });
});

it("falls back to word boundaries when a passage has no sentence breaks", () => {
  const words = "token ".repeat(4_000);
  const packets = prepareSourcePackets(words);
  expect(packets.length).toBeGreaterThan(1);
  for (const packet of packets.slice(1)) expect(words[packet.start - 1]).toBe(" ");
  for (const packet of packets.slice(0, -1)) expect(words[packet.end - 1]).toBe(" ");
});
