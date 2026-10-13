import { isPlannedEntrypoint } from "./reproduction-entrypoint";
import { isSupportedRawInputPath } from "./reproduction-stage-evidence";

/**
 * Pure validation of a batch experiment plan. The model proposes experiments
 * once for every pending claim; the application executes planned commands
 * itself. Nothing here grants a scientific verdict or authorizes qP changes.
 */
export type ExperimentMethod = "rerun" | "raw-data-rederived" | "toy" | "blocked";
export const EXPERIMENT_METHODS: readonly ExperimentMethod[] = ["rerun", "raw-data-rederived", "toy", "blocked"];

export interface PlannedClaim { claimId: string; measurement: string }
export interface PlannedExperiment {
  id: string;
  method: ExperimentMethod;
  command?: string;
  workingDirectory?: "/work" | "/work/materials";
  timeoutSeconds?: number;
  materialPaths: string[];
  rawInputs: string[];
  claims: PlannedClaim[];
  rationale: string;
}

export const PLAN_LIMITS = {
  maxExperiments: 16,
  maxClaimsPerExperiment: 12,
  maxMaterialPaths: 30,
  maxRawInputs: 8,
  maxText: 2000,
  maxTimeoutSeconds: 900,
} as const;

const asString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

export function normalizeShippedPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith("/work/")) return trimmed;
  if (trimmed.startsWith("materials/")) return `/work/${trimmed}`;
  return trimmed;
}

export interface PlanValidationInput {
  pendingClaimIds: readonly string[];
  shippedPaths: ReadonlySet<string>;
  questioning: boolean;
  firstExperimentNumber: number;
}

export type PlanValidation = { experiments: PlannedExperiment[]; errors?: undefined } | { errors: string[]; experiments?: undefined };

export function validateExperimentPlan(raw: unknown, input: PlanValidationInput): PlanValidation {
  const errors: string[] = [];
  const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
  const items = root && Array.isArray(root.experiments) ? root.experiments : undefined;
  if (!items) return { errors: ["experiments must be a non-empty array"] };
  if (!items.length) return { errors: ["experiments must contain at least one experiment"] };
  if (items.length > PLAN_LIMITS.maxExperiments) errors.push(`at most ${PLAN_LIMITS.maxExperiments} experiments are accepted; merge claims that share a command`);
  const pending = new Set(input.pendingClaimIds);
  const assigned = new Map<string, string>();
  const commands = new Map<string, string>();
  const experiments: PlannedExperiment[] = [];
  items.forEach((item, position) => {
    const label = `experiments[${position}]`;
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
    if (!entry) { errors.push(`${label} must be an object`); return; }
    const method = asString(entry.method) as ExperimentMethod | undefined;
    if (!method || !EXPERIMENT_METHODS.includes(method)) errors.push(`${label}.method must be one of ${EXPERIMENT_METHODS.join(", ")}`);
    const rationale = asString(entry.rationale)?.trim() ?? "";
    if (!rationale || rationale.length > PLAN_LIMITS.maxText) errors.push(`${label}.rationale must be a non-empty string of at most ${PLAN_LIMITS.maxText} characters`);
    const materialPaths: string[] = [];
    if (!Array.isArray(entry.material_paths)) errors.push(`${label}.material_paths must be an array of shipped paths`);
    else {
      if (entry.material_paths.length > PLAN_LIMITS.maxMaterialPaths) errors.push(`${label}.material_paths lists more than ${PLAN_LIMITS.maxMaterialPaths} paths`);
      for (const value of entry.material_paths) {
        const path = typeof value === "string" ? normalizeShippedPath(value) : "";
        if (!path || !input.shippedPaths.has(path)) errors.push(`${label}.material_paths contains ${JSON.stringify(value)}, which is not a shipped text file`);
        else if (!materialPaths.includes(path)) materialPaths.push(path);
      }
    }
    const rawInputs: string[] = [];
    if (entry.raw_inputs !== undefined) {
      if (!Array.isArray(entry.raw_inputs)) errors.push(`${label}.raw_inputs must be an array of shipped data paths`);
      else {
        if (entry.raw_inputs.length > PLAN_LIMITS.maxRawInputs) errors.push(`${label}.raw_inputs lists more than ${PLAN_LIMITS.maxRawInputs} files`);
        for (const value of entry.raw_inputs) {
          const path = typeof value === "string" ? normalizeShippedPath(value) : "";
          if (!path || !input.shippedPaths.has(path)) errors.push(`${label}.raw_inputs contains ${JSON.stringify(value)}, which is not a shipped text file`);
          else if (!isSupportedRawInputPath(path)) errors.push(`${label}.raw_inputs contains ${path}, which is not a supported raw data format (csv, tsv, json, jsonl, parquet, arrow, npy, npz, pt, pkl)`);
          else {
            if (!rawInputs.includes(path)) rawInputs.push(path);
            if (!materialPaths.includes(path)) materialPaths.push(path);
          }
        }
      }
    }
    const command = asString(entry.command)?.trim();
    if (entry.command !== undefined && !command) errors.push(`${label}.command must be a non-empty string when supplied`);
    const workingDirectory = entry.working_directory;
    if (workingDirectory !== undefined) {
      if (input.questioning) errors.push(`${label}.working_directory must be omitted for qP; the sealed snapshot determines the working directory`);
      else if (workingDirectory !== "/work" && workingDirectory !== "/work/materials") errors.push(`${label}.working_directory must be /work or /work/materials`);
    }
    const timeout = entry.timeout_seconds;
    if (timeout !== undefined && (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > PLAN_LIMITS.maxTimeoutSeconds))
      errors.push(`${label}.timeout_seconds must be an integer between 1 and ${PLAN_LIMITS.maxTimeoutSeconds}`);
    if (method === "rerun" && !command) errors.push(`${label} (rerun) requires command: the standalone planned entrypoint, e.g. python ${input.questioning ? "materials/analysis.py" : "/work/materials/analysis.py"}`);
    if (method === "blocked" && command) errors.push(`${label} (blocked) must not include a command; use rerun, raw-data-rederived or toy for executable experiments`);
    if (method === "raw-data-rederived" && !rawInputs.length) errors.push(`${label} (raw-data-rederived) requires raw_inputs naming shipped raw observation files (csv/tsv/json/jsonl/parquet/npy/npz/pt/pkl)`);
    if (command && !isPlannedEntrypoint(command, materialPaths)) {
      errors.push(`${label}.command must launch one shipped script listed in material_paths without cd, chaining, pipes or redirection, e.g. python ${input.questioning ? "materials/FILE.py" : "/work/materials/FILE.py"} [arguments]`);
    }
    if (command) {
      const key = `${command}\n${workingDirectory ?? ""}`;
      const previous = commands.get(key);
      if (previous) errors.push(`${label} repeats the command of ${previous}; merge their claims into one experiment`);
      else commands.set(key, label);
    }
    const claims: PlannedClaim[] = [];
    if (!Array.isArray(entry.claims) || !entry.claims.length) errors.push(`${label}.claims must list at least one pending claim with its measurement`);
    else {
      if (entry.claims.length > PLAN_LIMITS.maxClaimsPerExperiment) errors.push(`${label}.claims lists more than ${PLAN_LIMITS.maxClaimsPerExperiment} claims; split the experiment`);
      for (const value of entry.claims) {
        const claim = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
        const claimId = asString(claim?.claim_id)?.trim() ?? "";
        const measurement = asString(claim?.measurement)?.trim() ?? "";
        if (!claimId || !pending.has(claimId)) { errors.push(`${label}.claims names ${JSON.stringify(claim?.claim_id)}, which is not a pending claim id`); continue; }
        if (!measurement || measurement.length > PLAN_LIMITS.maxText) errors.push(`${label}.claims[${claimId}].measurement must be a non-empty string of at most ${PLAN_LIMITS.maxText} characters`);
        const owner = assigned.get(claimId);
        if (owner) { errors.push(`${claimId} is assigned to both ${owner} and ${label}; every pending claim belongs to exactly one experiment`); continue; }
        assigned.set(claimId, label);
        claims.push({ claimId, measurement });
      }
    }
    if (method !== "blocked" && !materialPaths.length) errors.push(`${label} (${method}) must list the shipped material_paths it uses`);
    experiments.push({
      id: `X${input.firstExperimentNumber + position}`,
      method: method ?? "blocked",
      command: command || undefined,
      workingDirectory: !input.questioning && (workingDirectory === "/work" || workingDirectory === "/work/materials") ? workingDirectory : undefined,
      timeoutSeconds: typeof timeout === "number" ? timeout : undefined,
      materialPaths, rawInputs, claims, rationale,
    });
  });
  const unassigned = input.pendingClaimIds.filter(id => !assigned.has(id));
  if (unassigned.length) errors.push(`pending claims ${unassigned.join(", ")} are not assigned to any experiment; assign each to a rerun, raw-data-rederived or toy experiment, or to a blocked experiment whose rationale explains the missing material`);
  if (errors.length) return { errors };
  return { experiments };
}

/** Deterministic repairs the application may try before spending model calls. */
export const PIP_PACKAGE_ALIASES: Record<string, string> = {
  sklearn: "scikit-learn", cv2: "opencv-python-headless", PIL: "pillow", yaml: "pyyaml", skimage: "scikit-image",
  umap: "umap-learn", Bio: "biopython", attr: "attrs", dateutil: "python-dateutil", bs4: "beautifulsoup4",
  OpenSSL: "pyopenssl", jwt: "pyjwt", serial: "pyserial", tensorflow_probability: "tensorflow-probability",
  sentence_transformers: "sentence-transformers",
};

export type ExecutionDiagnosis =
  | { kind: "missing-module"; module: string; local: boolean }
  | { kind: "missing-file"; path: string }
  | { kind: "refused" }
  | { kind: "timeout" }
  | { kind: "oom" }
  | { kind: "other" };

export function diagnoseExecutionFailure(output: string, shippedPaths: ReadonlySet<string>): ExecutionDiagnosis {
  if (/^Refused/.test(output)) return { kind: "refused" };
  if (/^TIMED OUT/.test(output)) return { kind: "timeout" };
  const tail = output.slice(-6000);
  if (/\b(?:CUDA out of memory|out of memory|OutOfMemoryError|MemoryError|Killed)\b/i.test(tail)) return { kind: "oom" };
  const module = /ModuleNotFoundError: No module named ['"]([^'"\s]+)['"]/.exec(tail)?.[1]
    ?? /ImportError: cannot import name .* from ['"]([^'"\s]+)['"] \(unknown location\)/.exec(tail)?.[1];
  if (module) {
    const top = module.split(".")[0];
    const local = shippedPaths.has(`/work/materials/${top}.py`) || Array.from(shippedPaths).some(path => path.startsWith(`/work/materials/${top}/`));
    return { kind: "missing-module", module: top, local };
  }
  const file = /(?:FileNotFoundError|No such file or directory)[^\n]*?['"]([^'"\n]+)['"]/.exec(tail)?.[1]
    ?? /can't open file ['"]([^'"\n]+)['"]/.exec(tail)?.[1];
  if (file) return { kind: "missing-file", path: file };
  return { kind: "other" };
}
