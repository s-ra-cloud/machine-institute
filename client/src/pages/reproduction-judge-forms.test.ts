// @vitest-environment jsdom
import React, { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import GenerationDashboard from "./GenerationDashboard";
import ReproductionDetail from "./ReproductionDetail";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authenticated: true, user: { id: "owner", email: "sacharaoult@gmail.com", displayName: "Test" }, isAdmin: false, isLoading: false }),
}));
vi.mock("wouter", () => ({
  useParams: () => ({ id: "failed-run" }),
  useLocation: () => ["/generate", vi.fn()],
  Link: ({ children }: any) => children,
}));
vi.mock("@/components/Navigation", () => ({ Navigation: () => null }));
vi.mock("@/components/Footer", () => ({ Footer: () => null }));
vi.mock("@/components/ReviewProgress", () => ({ ReviewProgress: () => null }));
vi.mock("@/components/ui/motion", () => ({ FadeIn: ({ children }: any) => children }));
vi.mock("@/components/ui/carousel", () => ({
  Carousel: ({ children }: any) => children,
  CarouselContent: ({ children }: any) => children,
  CarouselItem: ({ children }: any) => children,
  CarouselNext: () => null, CarouselPrevious: () => null,
}));
vi.mock("@/components/PaperPicker", () => ({
  PaperPicker: ({ onSelect, papers }: any) => createElement("button", {
    "data-testid": "pick-paper", disabled: !papers.length, onClick: () => onSelect(papers[0]),
  }, "Pick paper"),
}));

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let client: QueryClient;
const container = document.createElement("div");
let submitted: any;
let submitSucceeds = false;
const model = {
  provider: "openai", model: "openai/gpt-5-mini", label: "GPT 5 mini",
  enabled: true, tools: true, default: true,
};
function click(testId: string, index = 0) {
  const element = container.querySelectorAll<HTMLButtonElement>(`[data-testid="${testId}"]`)[index];
  expect(element, testId).toBeDefined();
  act(() => element.click());
}
function input(testId: string, value: string, index = 0) {
  const element = container.querySelectorAll<HTMLInputElement>(`[data-testid="${testId}"]`)[index];
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function waitFor(check: () => void) {
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); }); check(); });
}
async function render(retry: boolean) {
  submitted = undefined;
  submitSucceeds = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      submitted = JSON.parse(String(options.body));
      if (submitSucceeds) return new Response(JSON.stringify({ id: "new-run" }), { status: 201 });
      // Stay on the form to inspect post-settlement cleanup and redaction.
      return new Response(JSON.stringify({ error: `Rejected ${submitted.byocApiKey || ""} ${submitted.judgeByocApiKey || ""}` }), { status: 400 });
    }
    let data: any = [];
    if (url === "/api/generation/config") data = {
      platformModels: [model], managedModelsConfigured: true,
      reproduction: { gpuOptions: ["A10G"], sandboxConfigured: true, hfTokenConfigured: true },
    };
    else if (url.startsWith("/api/reproductions/default-prompts")) data = { reproducerPrompt: "Reproduce scientifically", judgePrompt: "Grade independently" };
    else if (url.startsWith("/api/reproductions/available-papers")) data = { papers: [{
      documentId: "paper", title: "Test paper", lockedModels: [], reproducedModels: [],
    }] };
    else if (url === "/api/reproductions/failed-run") data = {
      id: "failed-run", status: "failed", userId: "owner", agentId: "P",
      createdAt: "2026-10-02", projectId: "project", journalId: "mirror", documentId: "paper",
    };
    else if (url.includes("status") || url.includes("rate-limit")) data = {};
    return new Response(JSON.stringify(data));
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  root = createRoot(container);
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    createElement(retry ? ReproductionDetail : GenerationDashboard))));
  if (!retry) {
    click("button-workflow-reproduce");
    await waitFor(() => expect(container.querySelector<HTMLButtonElement>('[data-testid="pick-paper"]')?.disabled).toBe(false));
    click("pick-paper");
  }
  await waitFor(() => expect(container.querySelector('[data-testid="button-link-judge"]')).not.toBeNull());
}
afterEach(() => {
  if (root) act(() => root.unmount());
  client?.clear(); container.replaceChildren(); vi.unstubAllGlobals();
  Object.assign(globalThis, { React });
  localStorage.clear();
});

describe.each([false, true])("real reproduction form (retry=%s)", retry => {
  const submitId = retry ? "button-retry-reproduction" : "button-generate";
  it("defaults to a linked judge and submits matching managed model metadata", async () => {
    await render(retry);
    expect(container.querySelector('[data-testid="button-link-judge"]')?.getAttribute("aria-pressed")).toBe("true");
    if (retry) click("button-model-openai/gpt-5-mini");
    await waitFor(() => expect(container.querySelector<HTMLButtonElement>(`[data-testid="${submitId}"]`)?.disabled).toBe(false));
    click(submitId);
    await waitFor(() => expect(submitted).toBeDefined());
    expect(submitted).toMatchObject({
      modelName: model.model, modelProvider: "openai", providerMode: "platform",
      judgeModelName: model.model, judgeModelProvider: "openai", judgeProviderMode: "platform",
    });
    expect(submitted).not.toHaveProperty("judgeByocApiKey");
  });

  it("submits one BYOK key when linked, redacts errors and clears it after failure", async () => {
    await render(retry);
    click("tab-byok");
    input("input-byok-model", "gpt-4o");
    input("input-byok-api-key", "sk-test-reproducer-key-123456");
    expect(container.querySelectorAll('[data-testid="input-byok-api-key"]').length).toBe(1);
    await waitFor(() => expect(container.querySelector<HTMLButtonElement>(`[data-testid="${submitId}"]`)?.disabled).toBe(false));
    click(submitId);
    await waitFor(() => expect(container.querySelector<HTMLInputElement>('[data-testid="input-byok-api-key"]')?.value).toBe(""));
    expect(submitted).toMatchObject({
      providerMode: "byok", judgeProviderMode: "byok", modelProvider: "openai", judgeModelProvider: "openai",
      modelName: "gpt-4o", judgeModelName: "gpt-4o", byocApiKey: "sk-test-reproducer-key-123456",
    });
    expect(submitted).not.toHaveProperty("judgeByocApiKey");
    expect(container.textContent).not.toContain("sk-test-reproducer-key-123456");
    expect(localStorage.length).toBe(0);
  });

  it("requires a separate key for a different provider and never sends it after relinking", async () => {
    await render(retry);
    click("tab-byok");
    input("input-byok-model", "gpt-4o");
    input("input-byok-api-key", "sk-test-reproducer-key-123456");
    click("button-link-judge");
    click("tab-byok", 1);
    const provider = container.querySelectorAll<HTMLSelectElement>('[data-testid="select-byok-provider"]')[1];
    act(() => { provider.value = "anthropic"; provider.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelector<HTMLButtonElement>(`[data-testid="${submitId}"]`)?.disabled).toBe(true);
    input("input-byok-api-key", "sk-ant-test-judge-key-123456", 1);
    await waitFor(() => expect(container.querySelector<HTMLButtonElement>(`[data-testid="${submitId}"]`)?.disabled).toBe(false));
    click("button-link-judge");
    click(submitId);
    await waitFor(() => expect(submitted).toBeDefined());
    expect(submitted.judgeModelName).toBe("gpt-4o");
    expect(submitted).not.toHaveProperty("judgeByocApiKey");
    expect(JSON.stringify(submitted)).not.toContain("sk-ant-test-judge-key-123456");
  });

  it("submits an independent cross-provider judge and clears both keys on success", async () => {
    await render(retry);
    submitSucceeds = true;
    click("tab-byok");
    input("input-byok-model", "gpt-4o");
    input("input-byok-api-key", "sk-test-reproducer-key-123456");
    click("button-link-judge");
    click("tab-byok", 1);
    const provider = container.querySelectorAll<HTMLSelectElement>('[data-testid="select-byok-provider"]')[1];
    act(() => { provider.value = "anthropic"; provider.dispatchEvent(new Event("change", { bubbles: true })); });
    input("input-byok-api-key", "sk-ant-test-judge-key-123456", 1);
    click(submitId);
    await waitFor(() => expect(submitted).toBeDefined());
    expect(submitted).toMatchObject({
      providerMode: "byok", modelProvider: "openai", modelName: "gpt-4o",
      judgeProviderMode: "byok", judgeModelProvider: "anthropic", judgeModelName: "claude-sonnet-4-20250514",
      byocApiKey: "sk-test-reproducer-key-123456", judgeByocApiKey: "sk-ant-test-judge-key-123456",
    });
    await waitFor(() => {
      for (const keyInput of container.querySelectorAll<HTMLInputElement>('[data-testid="input-byok-api-key"]')) expect(keyInput.value).toBe("");
    });
    expect(localStorage.length).toBe(0);
  });
});