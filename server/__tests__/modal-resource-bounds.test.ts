import { describe, expect, it, vi, afterEach } from "vitest";

const { create, dockerfileCommands } = vi.hoisted(() => ({
  create: vi.fn(async (..._args: unknown[]) => ({ sandboxId: "offline-sandbox" })),
  dockerfileCommands: vi.fn(() => ({})),
}));
vi.mock("modal", () => ({
  ModalClient: class {
    apps = { fromName: async () => ({}) };
    images = { fromRegistry: () => ({ dockerfileCommands }) };
    secrets = { fromObject: async () => ({}) };
    sandboxes = { create };
  },
}));
import { ReproductionSandbox } from "../modal-sandbox";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("host-owned Modal resource bounds", () => {
  it("passes hard CPU and memory limits without changing GPU or lifetime", async () => {
    vi.stubEnv("MODAL_TOKEN_ID", "offline"); vi.stubEnv("MODAL_TOKEN_SECRET", "offline");
    await ReproductionSandbox.create({
      gpu: "A10G", timeoutMs: 8400000, resourceLimits: { cpu: 2, memoryMiB: 8192 },
    });
    expect(create).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      gpu: "A10G", timeoutMs: 8400000, cpu: 2, cpuLimit: 2, memoryMiB: 8192, memoryLimitMiB: 8192,
    }));
  });
  it("does not change resource selection for normal website callers", async () => {
    vi.stubEnv("MODAL_TOKEN_ID", "offline"); vi.stubEnv("MODAL_TOKEN_SECRET", "offline");
    await ReproductionSandbox.create({ gpu: "A10G", timeoutMs: 8400000 });
    const options = create.mock.calls[0]?.[2] as unknown as Record<string, unknown>;
    expect(options).not.toHaveProperty("cpuLimit");
    expect(options).not.toHaveProperty("memoryLimitMiB");
  });
});
