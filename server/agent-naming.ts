import { MANAGED_MODELS } from "../shared/model-catalog";

export const ROLE_LABELS: Record<string, string> = {
  bR:  "Balanced Reviewer",
  aR:  "Adversarial Reviewer",
  iR:  "Interpretive Reviewer",
  rR:  "Rigorous Reviewer",
  bLR: "Literature Reviewer",
  H:   "Research Standards Verification Agent",
  P:   "Reproduction Agent",
  qP:  "Questioning Reproduction Agent",
};

export function modelInitials(modelName: string): string {
  const m = (modelName || "").toLowerCase();
  if (m.startsWith("gemini-2.5-flash-lite")) return "G25FL";
  if (m.startsWith("gemini-2.5-flash")) return "G25F";
  if (m.startsWith("gemini-2.5-pro")) return "G25P";
  if (m === "gpt-5-nano") return "G5N";
  if (m === "gpt-5-mini") return "G5M";
  if (m === "gpt-4.1-mini") return "G41M";
  if (m.includes("deepseek-r1")) return "DSR1";
  if (m.includes("deepseek")) return "DS32";
  if (m.includes("claude-sonnet-5") || m.includes("sonnet-5")) return "CS5";
  if (m.includes("claude-sonnet-4-6") || m.includes("sonnet-4-6")) return "CS46";
  if (m.includes("claude-sonnet-4-5") || m.includes("sonnet-4-5")) return "CS45";
  if (m.includes("claude-sonnet-4") || m.includes("sonnet-4")) return "CS4";
  if (m.includes("claude-opus")) return "CO";
  if (m.includes("claude-haiku")) return "CH";
  if (m.includes("gpt-5.6-luna") || m.includes("gpt-56-luna")) return "G56L";
  if (m.includes("gpt-5")) return "G5";
  if (m.includes("gpt-4o")) return "G4O";
  if (m.includes("gpt-4")) return "G4";
  return "ML";
}

// Model-blind reviews are flagged with an MB suffix at the end of the
// evaluator's configuration code (e.g. "MachInstit CS45bR-N1MB").
export function buildConventionName(modelName: string, agentId: string, modelBlind: boolean = false): string {
  return `MachInstit ${modelInitials(modelName)}${agentId}-N1${modelBlind ? "MB" : ""}`;
}

// Ensures the MB (model-blind) suffix on an evaluator code, including
// user-supplied custom orchestrator names.
export function withMbSuffix(name: string, modelBlind: boolean): string {
  const trimmed = name.trim();
  if (!modelBlind || !trimmed || trimmed.endsWith("MB")) return trimmed;
  return `${trimmed}MB`;
}

/**
 * Builds the agent description that is always sent to Future Science.
 * Stamps the resolved model, agent role/persona, and provider mode so the
 * FS catalogue always carries full provenance, even when no custom description
 * was supplied.  Any user-supplied text is appended after the config block.
 */
export function buildFsAgentDescription(opts: {
  model: string;
  agentId: string;
  providerMode?: "platform" | "byoc" | string | null;
  modelBlind?: boolean;
  userDescription?: string | null;
  extra?: string[];
}): string {
  const role     = ROLE_LABELS[opts.agentId] || opts.agentId;
  const provider = opts.providerMode === "byoc"
    ? "BYOC (user-supplied key)"
    : MANAGED_MODELS.some(model => model.model === opts.model)
      ? "Machine Institute Platform (Replit-managed)"
      : "Machine Institute Platform (via OpenRouter)";
  const parts = [
    `Agent: ${opts.agentId} (${role})`,
    `Model: ${opts.model}`,
    `Provider: ${provider}`,
    ...(opts.extra || []),
  ];
  if (opts.modelBlind) parts.push("Model-blind evaluation: true");
  const base = parts.join(". ");
  return opts.userDescription ? `${base}. ${opts.userDescription}` : base;
}
