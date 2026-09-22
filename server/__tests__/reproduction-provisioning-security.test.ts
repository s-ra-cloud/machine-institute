import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fromObject: vi.fn(async () => "secret"), fromRegistry: vi.fn(), create: vi.fn(async () => ({ sandboxId: "test" })) }));
vi.mock("modal", () => ({ ModalClient: class {
  apps = { fromName: vi.fn(async () => "app") };
  images = { fromRegistry: mocks.fromRegistry };
  secrets = { fromObject: mocks.fromObject };
  sandboxes = { create: mocks.create };
} }));
import { ReproductionSandbox } from "../modal-sandbox";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MODAL_TOKEN_ID", "mock-id");
  vi.stubEnv("MODAL_TOKEN_SECRET", "mock-secret");
  vi.stubEnv("MODAL_SANDBOX_IMAGE", "custom-image-with-inherited-secrets");
  mocks.fromRegistry.mockReturnValue({ dockerfileCommands: vi.fn(() => "image") });
});
afterEach(() => vi.unstubAllEnvs());
describe("qP provisioning secret boundary", () => {
  it("never provisions caller environment secrets or custom credential-bearing images", async () => {
    await ReproductionSandbox.create({ gpu: "T4", timeoutMs: 1, questioning: true, env: { HF_TOKEN: "must-not-provision", HUGGING_FACE_HUB_TOKEN: "must-not-provision", OTHER_SECRET: "must-not-provision" } });
    expect(mocks.fromObject).not.toHaveBeenCalled();
    expect(mocks.create.mock.calls[0][2]).toMatchObject({ secrets: [] });
    expect(mocks.fromRegistry).toHaveBeenCalledWith("pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime");
  });
  it("preserves P's existing token and image behavior", async () => {
    await ReproductionSandbox.create({ gpu: "T4", timeoutMs: 1, env: { HF_TOKEN: "P-token" } });
    expect(mocks.fromObject).toHaveBeenCalledWith({ HF_TOKEN: "P-token" });
    expect(mocks.fromRegistry).toHaveBeenCalledWith("custom-image-with-inherited-secrets");
    expect(mocks.create.mock.calls[0][2]).toMatchObject({ secrets: ["secret"] });
  });
});