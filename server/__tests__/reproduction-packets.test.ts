import { expect, it } from "vitest";
import { prepareSourcePackets, validateCandidate } from "../reproduction-packets";

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

it("falls back to word boundaries when a passage has no sentence breaks", () => {
  const words = "token ".repeat(4_000);
  const packets = prepareSourcePackets(words);
  expect(packets.length).toBeGreaterThan(1);
  for (const packet of packets.slice(1)) expect(words[packet.start - 1]).toBe(" ");
  for (const packet of packets.slice(0, -1)) expect(words[packet.end - 1]).toBe(" ");
});
