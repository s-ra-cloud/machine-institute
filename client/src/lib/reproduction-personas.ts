import { useState } from "react";

export type ReproductionPersona = "P" | "qP";
export const REPRODUCTION_PERSONAS = {
  P: {
    name: "Reproduction Agent",
    description: "Re-runs the paper’s shipped code and data without changing its scientific analysis. An independent judge grades the original results.",
  },
  qP: {
    name: "Questioning Reproducer",
    description: "First assesses whether the methods, data, code, and metrics address the selected paper’s research question. Uses suitable code unchanged; otherwise automatically adapts working copies with evidence-backed reasons and change provenance. An independent judge separates adapted findings from verification of the original results. Missing materials or no defensible adaptation are reported as limitations.",
  },
} as const;

export function reproductionPersonaName(agentId: string | null | undefined) {
  return REPRODUCTION_PERSONAS[agentId === "qP" ? "qP" : "P"].name;
}

type Prompts = { reproducerPrompt: string; judgePrompt: string };

// Undefined means use the current persona's default. An empty edited draft is
// intentionally retained, not silently replaced by a late network response.
export function useReproductionPrompts(persona: ReproductionPersona, defaults?: Prompts) {
  const [drafts, setDrafts] = useState<Partial<Record<ReproductionPersona, Partial<Prompts>>>>({});
  const set = (field: keyof Prompts, value: string | undefined) =>
    setDrafts(previous => ({ ...previous, [persona]: { ...previous[persona], [field]: value } }));
  return {
    reproducerPrompt: drafts[persona]?.reproducerPrompt ?? defaults?.reproducerPrompt ?? "",
    judgePrompt: drafts[persona]?.judgePrompt ?? defaults?.judgePrompt ?? "",
    setReproducerPrompt: (value: string | undefined) => set("reproducerPrompt", value),
    setJudgePrompt: (value: string | undefined) => set("judgePrompt", value),
  };
}