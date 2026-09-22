import { describe, expect, it } from "vitest";
import {
  chooseInitialManagedModel,
  type ManagedModel,
} from "../../client/src/components/ModelSelector";

const model = (overrides: Partial<ManagedModel>): ManagedModel => ({
  provider: "openai",
  model: "gpt-5-mini",
  label: "GPT-5 Mini",
  contextWindow: 400_000,
  maxOutputTokens: 128_000,
  tools: true,
  inputPricePerMillion: 0.25,
  outputPricePerMillion: 2,
  pricingSource: "https://openai.com/api/pricing/",
  enabled: true,
  ...overrides,
});

describe("managed model selector initialization", () => {
  it("does not replace a nonempty selection that disappeared or became disabled", () => {
    const models = [
      model({ model: "gpt-5-mini", default: true, enabled: false }),
      model({ provider: "google", model: "gemini-2.5-flash" }),
    ];

    expect(chooseInitialManagedModel(models, "legacy-or-disabled-model", "peer-review")).toBeNull();
    expect(chooseInitialManagedModel(models, "gpt-5-mini", "peer-review")).toBeNull();
  });

  it("selects an enabled compatible default only for an empty form", () => {
    const models = [
      model({ model: "disabled-default", default: true, enabled: false }),
      model({ provider: "google", model: "gemini-2.5-flash", default: true }),
    ];

    expect(chooseInitialManagedModel(models, "", "reproduction")?.model).toBe("gemini-2.5-flash");
  });
});