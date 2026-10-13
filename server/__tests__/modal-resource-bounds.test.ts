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
  describe("exec timeout classification", () => {
    const sandboxWith = (exitCode: number | null, runForMs: number) => {
      const sb = {
        sandboxId: "offline-sandbox",
        exec: vi.fn(async () => ({
          stdout: { readText: async () => "progress 1/3\n" },
          stderr: { readText: async () => "" },
          wait: () => new Promise<number | null>(resolve => setTimeout(() => resolve(exitCode), runForMs)),
        })),
      };
      return new ReproductionSandbox(sb as any, sb.sandboxId, "A10G", "image");
    };
    it("reports a process Modal killed at the timeout (exit 137 after the full allotment) as TIMED OUT, not as a command error", async () => {
      vi.useFakeTimers();
      try {
        const pending = sandboxWith(137, 1_000).exec(["python", "slow.py"], { timeoutMs: 1_000 });
        await vi.advanceTimersByTimeAsync(1_000);
        const result = await pending;
        expect(result).toMatchObject({ exitCode: 137, timedOut: true });
        expect(result.durationMs).toBeGreaterThanOrEqual(1_000);
      } finally {
        vi.useRealTimers();
      }
    });
    it("keeps an early SIGKILL (for example an OOM kill) as exit 137 without a timeout label", async () => {
      vi.useFakeTimers();
      try {
        const pending = sandboxWith(137, 100).exec(["python", "hungry.py"], { timeoutMs: 60_000 });
        await vi.advanceTimersByTimeAsync(100);
        expect(await pending).toMatchObject({ exitCode: 137, timedOut: false });
      } finally {
        vi.useRealTimers();
      }
    });
    it("keeps a normal exit untouched", async () => {
      vi.useFakeTimers();
      try {
        const pending = sandboxWith(0, 10).exec(["python", "ok.py"], { timeoutMs: 60_000 });
        await vi.advanceTimersByTimeAsync(10);
        expect(await pending).toMatchObject({ exitCode: 0, timedOut: false });
      } finally {
        vi.useRealTimers();
      }
    });
  });
  it("does not change resource selection for normal website callers", async () => {
    vi.stubEnv("MODAL_TOKEN_ID", "offline"); vi.stubEnv("MODAL_TOKEN_SECRET", "offline");
    await ReproductionSandbox.create({ gpu: "A10G", timeoutMs: 8400000 });
    const options = create.mock.calls[0]?.[2] as unknown as Record<string, unknown>;
    expect(options).not.toHaveProperty("cpuLimit");
    expect(options).not.toHaveProperty("memoryLimitMiB");
  });
});
