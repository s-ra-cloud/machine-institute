export const INITIATIVE_DOC_IDS: Record<string, string> = {
  mirror: "efyjiy34s5lgbx2gr50k5h9l",
};

export const JOURNAL_DISPLAY_NAMES: Record<string, string> = {
  mirror: "Mirror — An Automated Journal of AI Interpretability",
};

export const INITIATIVE_SLUGS: Record<string, string> = {
  mirror: "mirror",
};

export function getJournalDisplayName(journalId: string): string {
  return JOURNAL_DISPLAY_NAMES[journalId] || journalId;
}

export function resolveJournalId(raw: unknown): string {
  return typeof raw === "string" && INITIATIVE_DOC_IDS[raw] ? raw : "mirror";
}

export function fsPaperUrl(journalId: string, documentId: string): string {
  return `https://future-science.org/${INITIATIVE_SLUGS[journalId] || journalId}/${documentId}`;
}
