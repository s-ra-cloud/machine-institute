// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  areReproductionModelModesCompatible,
  isByokModelSelectionReady,
  ModelSelector,
  type ModelConfig,
} from "./ModelSelector";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const container = document.createElement("div");
let root: Root;

function render(props: Partial<Parameters<typeof ModelSelector>[0]> = {}) {
  root = createRoot(container);
  act(() => root.render(createElement(ModelSelector, {
    value: { providerMode: "byok", provider: "openrouter", modelName: "custom/model" },
    onChange: vi.fn(),
    apiKey: "sensitive-test-key",
    onApiKeyChange: vi.fn(),
    activeType: "editorial",
    models: [],
    ...props,
  })));
}

afterEach(() => {
  act(() => root.unmount());
  container.replaceChildren();
  localStorage.clear();
});

describe("BYOK model selection", () => {
  it("offers the supported providers and custom models without managed estimates", () => {
    render();
    expect(container.querySelector('[data-testid="tab-platform"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="tab-byok"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="input-byok-model"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="select-byok-provider"] option[value="openai"]')?.textContent).toBe("OpenAI");
    expect(container.querySelector('[data-testid="select-byok-provider"] option[value="anthropic"]')?.textContent).toBe("Anthropic");
    expect(container.querySelector('[data-testid="select-byok-provider"] option[value="openrouter"]')?.textContent).toBe("OpenRouter");
    expect(container.querySelector('[data-testid="input-byok-api-key"]')?.getAttribute("type")).toBe("password");
    expect(container.textContent).not.toContain("sensitive-test-key");
    expect(container.textContent).toContain("billed by your provider account");
    expect(container.textContent).not.toContain("Replit usage");
    expect(container.textContent).not.toContain("app credits");
    expect(localStorage.length).toBe(0);
  });

  it("clears the ephemeral key when changing providers and selects a provider default", () => {
    const onChange = vi.fn();
    const onApiKeyChange = vi.fn();
    render({ onChange, onApiKeyChange });
    const provider = container.querySelector<HTMLSelectElement>('[data-testid="select-byok-provider"]')!;
    act(() => {
      provider.value = "anthropic";
      provider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onApiKeyChange).toHaveBeenCalledWith("");
    expect(onChange).toHaveBeenCalledWith({
      providerMode: "byok",
      provider: "anthropic",
      modelName: "claude-sonnet-4-20250514",
    });
  });

  it("rejects both mixed reproduction modes and requires a key for a cross-provider BYOK judge", () => {
    const managed: ModelConfig = { providerMode: "platform", provider: "openrouter", modelName: "managed/model" };
    const openAiReproducer: ModelConfig = { providerMode: "byok", provider: "openai", modelName: "gpt-4o" };
    const anthropicJudge: ModelConfig = { providerMode: "byok", provider: "anthropic", modelName: "claude-sonnet-4-20250514" };

    expect(areReproductionModelModesCompatible(managed, anthropicJudge)).toBe(false);
    expect(areReproductionModelModesCompatible(openAiReproducer, managed)).toBe(false);
    expect(areReproductionModelModesCompatible(openAiReproducer, anthropicJudge)).toBe(true);
    expect(isByokModelSelectionReady(anthropicJudge, "")).toBe(false);
    expect(isByokModelSelectionReady(anthropicJudge, "judge-provider-key")).toBe(true);
  });
});