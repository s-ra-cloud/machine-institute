// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  auth: { authenticated: true, isAdmin: true, user: { id: "admin", email: "sacharaoult@gmail.com" } } as any,
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => state.auth }));
vi.mock("wouter", () => ({
  useParams: () => ({ id: "failed" }),
  useLocation: () => ["/reproductions/failed", vi.fn()],
  Link: ({ children }: any) => children,
}));
vi.mock("@/components/Navigation", () => ({ Navigation: () => null }));
vi.mock("@/components/Footer", () => ({ Footer: () => null }));
vi.mock("@/components/ReviewProgress", () => ({ ReviewProgress: () => null }));
vi.mock("@/components/ui/motion", () => ({ FadeIn: ({ children }: any) => children }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, variant: _variant, ...props }: any) => React.createElement("button", props, children),
}));
import ReproductionDetail from "../../client/src/pages/ReproductionDetail";

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const fetchMock = vi.fn();
const cachedRun = {
  id: "failed", projectId: "project", documentId: "paper", journalId: "mirror", status: "failed",
  gpu: "A10G", createdAt: new Date().toISOString(), userId: "admin",
  promptTrace: '{"secret":"CACHED_PRIVATE_PROMPT"}', sourceTrace: '{"private":"CACHED_SOURCE_TRACE"}',
  contentHtml: "<p>LEGACY_RAW_ERROR</p>", reportTitle: "STALE_TITLE", reportAbstract: "STALE_ABSTRACT",
};

async function render() {
  await act(async () => {
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(ReproductionDetail)));
  });
}
async function toggle() {
  await act(async () => {
    (container.querySelector('[data-testid="button-toggle-failure-diagnostics"]') as HTMLButtonElement).click();
    await new Promise(resolve => setTimeout(resolve, 30));
  });
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ diagnostics: null }) });
  state.auth = { authenticated: true, isAdmin: true, user: { id: "admin", email: "sacharaoult@gmail.com" } };
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["/api/reproductions", "failed"], cachedRun);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});

describe("admin-only reproduction diagnostic disclosure", () => {
  it("starts collapsed without fetching and handles legacy runs with no snapshot", async () => {
    await render();
    expect(container.textContent).toContain("Show failure diagnostics");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-expanded="false"]')).not.toBeNull();
    await toggle();
    expect(fetchMock).toHaveBeenCalledWith("/api/reproductions/failed/diagnostics", { cache: "no-store" });
    expect(container.textContent).toContain("No diagnostics were saved");
  });

  it("never renders cached prompt traces or raw failure HTML to a nonadmin", async () => {
    state.auth = { authenticated: true, isAdmin: false, user: { id: "owner", email: "member@example.test" } };
    await render();
    expect(container.textContent).not.toMatch(/diagnostics|CACHED_|LEGACY_|STALE_/);
    expect(fetchMock).not.toHaveBeenCalled();
    // Completed cached payloads from older public APIs must not render traces.
    await act(async () => {
      client.setQueryData(["/api/reproductions", "failed"], { ...cachedRun, status: "completed", contentHtml: "<p>Published report</p>" });
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    await act(async () => {
      (container.querySelector('[data-testid="button-toggle-metadata"]') as HTMLButtonElement).click();
    });
    expect(container.textContent).not.toMatch(/CACHED_PRIVATE_PROMPT|CACHED_SOURCE_TRACE|Prompt trace|Source trace/);
  });

  it("renders snapshots as escaped text and removes the panel immediately on loss of admin access", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ diagnostics: { stage: "tool-loop", excerpt: "<img src=x>" } }) });
    await render();
    await toggle();
    expect(container.textContent).toContain("tool-loop");
    expect(container.querySelector("img")).toBeNull();
    state.auth = { authenticated: false, isAdmin: false, user: null };
    await render();
    expect(container.querySelector('[data-testid="section-failure-diagnostics"]')).toBeNull();
    expect(container.textContent).not.toContain("tool-loop");
  });

  it("shows a safe error when the diagnostic endpoint refuses access", async () => {
    fetchMock.mockResolvedValue({ ok: false });
    await render();
    await toggle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load private diagnostics");
  });
});