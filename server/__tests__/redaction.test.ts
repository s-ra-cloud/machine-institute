import { describe, it, expect } from "vitest";
import { createRedactor, buildModelVariantPattern } from "../redaction";

describe("buildModelVariantPattern", () => {
  it("matches common GPT-5 spelling variants", () => {
    const re = buildModelVariantPattern("GPT-5");
    for (const v of ["GPT-5", "GPT 5", "GPT5", "gpt-5", "gpt_5", "OpenAI GPT-5", "openai/gpt-5"]) {
      re.lastIndex = 0;
      expect(re.test(v), `should match "${v}"`).toBe(true);
    }
    re.lastIndex = 0;
    expect(re.test("GPT-55")).toBe(false);
  });

  it("matches Claude, DeepSeek, and Gemini variants", () => {
    const cs = buildModelVariantPattern("Claude Sonnet 4.5");
    for (const v of ["Claude Sonnet 4.5", "claude-sonnet-4-5", "ClaudeSonnet45", "Anthropic Claude Sonnet 4.5", "sonnet was claude_sonnet_4.5"]) {
      cs.lastIndex = 0;
      expect(cs.test(v), `should match "${v}"`).toBe(true);
    }
    const ds = buildModelVariantPattern("DeepSeek R1");
    for (const v of ["DeepSeek R1", "deepseek-r1", "DeepSeekR1", "deepseek/deepseek-r1"]) {
      ds.lastIndex = 0;
      expect(ds.test(v), `should match "${v}"`).toBe(true);
    }
    const gm = buildModelVariantPattern("Gemini 2.5 Pro");
    for (const v of ["Gemini 2.5 Pro", "gemini-2.5-pro", "Google Gemini 2.5 Pro", "gemini25pro"]) {
      gm.lastIndex = 0;
      expect(gm.test(v), `should match "${v}"`).toBe(true);
    }
  });
});

describe("createRedactor", () => {
  it("redacts author names, tokens, and model variants", () => {
    const redact = createRedactor({ authors: "MachInstit CS45bR-N1", targetModel: "Claude Sonnet 4.5" });
    const out = redact(
      "By MachInstit CS45bR-N1 (machinstit), running claude-sonnet-4.5 / ClaudeSonnet45 / Anthropic Claude Sonnet 4.5.",
    );
    expect(out).not.toMatch(/machinstit/i);
    expect(out).not.toMatch(/cs45/i);
    expect(out).not.toMatch(/claude[\s._/-]*sonnet[\s._/-]*4[\s._/-]*5/i);
    expect(out).toContain("[withheld]");
  });

  it("is the identity function when there is nothing to redact", () => {
    const redact = createRedactor({ authors: null, targetModel: null });
    expect(redact("unchanged text")).toBe("unchanged text");
  });
});
