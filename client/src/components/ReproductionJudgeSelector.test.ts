// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isByokModelSelectionReady, type ModelConfig } from "./ModelSelector";
import { ReproductionJudgeSelector, useReproductionJudge, reproductionModelPayload, postReproduction } from "./ReproductionJudgeSelector";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
let root: Root;
let selection: ReturnType<typeof useReproductionJudge>;
let setReproducer: (config: ModelConfig) => void;
let setKey: (key: string) => void;
const managed: ModelConfig = { providerMode: "platform", provider: "openai", modelName: "openai/gpt-5-mini" };
const byok: ModelConfig = { providerMode: "byok", provider: "openai", modelName: "gpt-4o" };
const anthropic: ModelConfig = { providerMode: "byok", provider: "anthropic", modelName: "claude-sonnet-4-20250514" };

function render() {
  function Harness() {
    const [config, update] = useState(managed);
    const [key, updateKey] = useState("");
    setReproducer = update; setKey = updateKey;
    selection = useReproductionJudge(config, key);
    return createElement(ReproductionJudgeSelector, { selection, activeType: "judge", models: [] });
  }
  root = createRoot(container);
  act(() => root.render(createElement(Harness)));
}
afterEach(() => {
  if (root) act(() => root.unmount());
  container.replaceChildren(); localStorage.clear(); vi.unstubAllGlobals();
});

describe("linked reproduction judge", () => {
  it("defaults on and immediately follows model, provider and billing changes", () => {
    render();
    expect(selection.linked).toBe(true);
    expect(container.querySelector("button")?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[data-testid="model-selector"]')).toBeNull();
    for (const config of [byok, anthropic, { ...anthropic, modelName: "another/model" }, managed]) {
      act(() => setReproducer(config));
      expect(selection.config).toBe(config);
      expect(container.querySelector('[data-testid="linked-judge-summary"]')?.textContent).toContain(config.modelName);
    }
    expect(localStorage.length).toBe(0);
  });

  it("supports independent selections, single-key same-provider readiness and cross-provider keys", () => {
    render();
    act(() => { setReproducer(byok); setKey("temporary-reproducer-key"); });
    expect(isByokModelSelectionReady(selection.config, selection.apiKey)).toBe(true);
    act(() => selection.setLinked(false));
    expect(container.querySelector('[data-testid="model-selector"]')).not.toBeNull();
    act(() => selection.setConfig({ ...byok, modelName: "gpt-4.1" }));
    expect(selection.needsSeparateKey).toBe(false);
    expect(isByokModelSelectionReady(selection.config, selection.apiKey)).toBe(true);
    expect(container.querySelector('[data-testid="input-byok-api-key"]')).toBeNull();
    act(() => selection.setConfig(anthropic));
    expect(selection.needsSeparateKey).toBe(true);
    expect(isByokModelSelectionReady(selection.config, selection.apiKey)).toBe(false);
    act(() => selection.setApiKey("temporary-judge-key"));
    expect(isByokModelSelectionReady(selection.config, selection.apiKey)).toBe(true);
    act(() => selection.setLinked(true));
    expect(selection.config).toBe(byok);
    expect(selection.apiKey).toBe("temporary-reproducer-key");
    expect(container.textContent).not.toContain("temporary-judge-key");
    act(() => selection.setLinked(false));
    expect(selection.config).toBe(anthropic);
    expect(selection.apiKey).toBe("");
  });

  it("clears independent keys when reproducer provider changes and on settlement cleanup", () => {
    render();
    act(() => { setReproducer(byok); setKey("temporary-key"); });
    act(() => { selection.setLinked(false); selection.setConfig(anthropic); });
    act(() => selection.setApiKey("old-judge-key"));
    act(() => setReproducer({ ...byok, provider: "openrouter" }));
    expect(selection.apiKey).toBe("");
    act(() => selection.setApiKey("new-judge-key"));
    act(() => { selection.clearKey(); setKey(""); });
    expect(selection.apiKey).toBe("");
  });

  it("omits stale judge credentials in linked and same-provider payloads", () => {
    expect(reproductionModelPayload(byok, byok, "reproducer-key", "stale-judge-key")).toEqual({
      providerMode: "byok", modelProvider: "openai", modelName: "gpt-4o",
      judgeProviderMode: "byok", judgeModelProvider: "openai", judgeModelName: "gpt-4o", byocApiKey: "reproducer-key",
    });
    expect(reproductionModelPayload(byok, anthropic, "reproducer-key", "judge-key").judgeByocApiKey).toBe("judge-key");
    expect(reproductionModelPayload(managed, managed, "stale-key", "stale-judge-key")).not.toHaveProperty("byocApiKey");
  });

  it.each(["/api/reproductions", "/api/reproductions/run/retry"])("redacts response and transport errors on %s", async url => {
    const payload = reproductionModelPayload(byok, anthropic, "reproducer-key", "judge-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "reproducer-key judge-key" }), { status: 400 })));
    await expect(postReproduction(url, payload)).rejects.toThrow("[redacted] [redacted]");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("reproducer-key judge-key")));
    await expect(postReproduction(url, payload)).rejects.toThrow("[redacted] [redacted]");
  });
});