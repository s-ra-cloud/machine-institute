// Thin wrapper around a Modal GPU Sandbox used by the reproduction agent. Keeps
// all Modal-specific API surface in one place so the agent loop only sees
// exec / read / write primitives.

import { ModalClient, type Sandbox } from "modal";

export const GPU_OPTIONS = ["T4", "A10G", "A100", "H100"] as const;
export type GpuType = (typeof GPU_OPTIONS)[number];
export const DEFAULT_GPU: GpuType = "A10G";

export function resolveGpu(raw: unknown): GpuType {
  return typeof raw === "string" && (GPU_OPTIONS as readonly string[]).includes(raw) ? (raw as GpuType) : DEFAULT_GPU;
}

export function isModalConfigured(): boolean {
  return !!(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);
}

// PyTorch's official CUDA runtime image already ships torch; only the
// analysis stack the Mirror papers import is layered on top.
const DEFAULT_IMAGE = "pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime";
const PIP_PACKAGES = [
  "transformers", "accelerate", "huggingface_hub", "safetensors", "sentencepiece",
  "numpy", "scipy", "pandas", "matplotlib", "scikit-learn", "einops", "tqdm",
  "nbformat", "nbconvert", "ipykernel", "jupyter_client",
];
const APP_NAME = "machine-institute-reproductions";

const MAX_CAPTURE_CHARS = 40_000;

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export interface CreateSandboxOptions {
  gpu: GpuType;
  timeoutMs: number;
  env?: Record<string, string>;
}

function truncateCapture(s: string): string {
  if (s.length <= MAX_CAPTURE_CHARS) return s;
  const head = s.slice(0, MAX_CAPTURE_CHARS * 0.6);
  const tail = s.slice(-MAX_CAPTURE_CHARS * 0.4);
  return `${head}\n\n[... ${s.length - MAX_CAPTURE_CHARS} chars elided ...]\n\n${tail}`;
}

export class ReproductionSandbox {
  private constructor(
    private readonly sb: Sandbox,
    readonly sandboxId: string,
    readonly gpu: GpuType,
    readonly image: string,
  ) {}

  static async create(opts: CreateSandboxOptions): Promise<ReproductionSandbox> {
    if (!isModalConfigured()) {
      throw new Error("Modal is not configured. MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are required for reproduction sandboxes.");
    }
    const modal = new ModalClient({
      tokenId: process.env.MODAL_TOKEN_ID,
      tokenSecret: process.env.MODAL_TOKEN_SECRET,
    });
    const app = await modal.apps.fromName(APP_NAME, { createIfMissing: true });
    const baseImage = process.env.MODAL_SANDBOX_IMAGE || DEFAULT_IMAGE;
    const image = modal.images.fromRegistry(baseImage).dockerfileCommands([
      "RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates build-essential && rm -rf /var/lib/apt/lists/*",
      `RUN pip install --no-cache-dir ${PIP_PACKAGES.join(" ")}`,
      "RUN mkdir -p /work/materials /work/results /work/outputs",
      "WORKDIR /work",
    ]);
    const secrets = opts.env && Object.keys(opts.env).length > 0
      ? [await modal.secrets.fromObject(opts.env)]
      : [];
    const sb = await modal.sandboxes.create(app, image, {
      gpu: opts.gpu,
      timeoutMs: opts.timeoutMs,
      secrets,
      workdir: "/work",
    });
    return new ReproductionSandbox(sb, sb.sandboxId, opts.gpu, baseImage);
  }

  async exec(command: string[], opts: { timeoutMs: number; workdir?: string }): Promise<ExecResult> {
    const started = Date.now();
    let timedOut = false;
    const proc = await this.sb.exec(command, {
      timeoutMs: opts.timeoutMs,
      workdir: opts.workdir || "/work",
      mode: "text",
    });
    // Read both streams concurrently with the exit wait so large outputs can't
    // deadlock the process on a full pipe.
    const [stdout, stderr, exitCode] = await Promise.all([
      proc.stdout.readText().catch(() => ""),
      proc.stderr.readText().catch(() => ""),
      Promise.race([
        proc.wait().catch(() => null),
        new Promise<number | null>((resolve) => setTimeout(() => { timedOut = true; resolve(null); }, opts.timeoutMs + 15_000)),
      ]),
    ]);
    const durationMs = Date.now() - started;
    if (!timedOut && exitCode === null) timedOut = durationMs >= opts.timeoutMs;
    return {
      stdout: truncateCapture(stdout),
      stderr: truncateCapture(stderr),
      exitCode,
      timedOut,
      durationMs,
    };
  }

  async writeText(path: string, content: string): Promise<void> {
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    await this.sb.filesystem.makeDirectory(dir, { createParents: true }).catch(() => {});
    await this.sb.filesystem.writeText(content, path);
  }

  async readText(path: string): Promise<string> {
    return this.sb.filesystem.readText(path);
  }

  async listFiles(path: string): Promise<Array<{ name: string; isDir: boolean; size?: number }>> {
    const entries = await this.sb.filesystem.listFiles(path);
    return entries.map((e: any) => ({
      name: String(e.name ?? e.path ?? ""),
      isDir: !!(e.isDirectory ?? e.isDir ?? e.type === "directory"),
      size: typeof e.size === "number" ? e.size : undefined,
    }));
  }

  async terminate(): Promise<void> {
    try {
      await this.sb.terminate();
    } catch (err) {
      console.warn(`[ModalSandbox ${this.sandboxId}] terminate failed:`, err);
    }
  }
}
