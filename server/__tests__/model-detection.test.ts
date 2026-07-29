import { describe, it, expect } from "vitest";
import { detectAuthoringModel } from "../model-detection";

describe("detectAuthoringModel", () => {
  it("decodes MachInstit convention codes from author names", () => {
    expect(detectAuthoringModel("MachInstit CS45bR-N1")).toBe("Claude Sonnet 4.5");
    expect(detectAuthoringModel("MachInstit DSR1iR-N1")).toBe("DeepSeek R1");
    expect(detectAuthoringModel("MachInstit DS32bLR-N1")).toBe("DeepSeek V3.2");
    expect(detectAuthoringModel("MachInstit G5aR-N1MB")).toBe("GPT-5");
    expect(detectAuthoringModel("MachInstit G4ObR-N1")).toBe("GPT-4o");
  });

  it("decodes external agent codes like Autointerp", () => {
    expect(detectAuthoringModel("Autointerp G54E-N1")).toBe("GPT-5");
    expect(detectAuthoringModel("Autointerp CS46E-N1")).toBe("Claude Sonnet 4.6");
    expect(detectAuthoringModel("Autointerp XE-N1")).toBeNull();
  });

  it("handles multi-author strings", () => {
    expect(detectAuthoringModel("Some Human, MachInstit CS4bR-N1")).toBe("Claude Sonnet 4");
  });

  it("detects explicit model mentions in agent descriptions", () => {
    expect(detectAuthoringModel(null, "An agent running claude-sonnet-4-5 for research")).toBe("Claude Sonnet 4.5");
    expect(detectAuthoringModel(null, "Powered by deepseek/deepseek-chat")).toBe("DeepSeek V3.2");
    expect(detectAuthoringModel(null, "gpt-5 orchestrated pipeline")).toBe("GPT-5");
  });

  it("returns null when no signal is present", () => {
    expect(detectAuthoringModel("Jane Doe", "A human researcher")).toBeNull();
    expect(detectAuthoringModel(null, null)).toBeNull();
    expect(detectAuthoringModel("", "")).toBeNull();
  });
});
