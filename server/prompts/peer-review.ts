// Peer-review persona prompts (bR / iR / aR / rR).
// One short prompt per persona (≤100 words). Each prompt explains the
// reviewer's role, the optional H Research Standards Verification Agent
// co-author, and what content the model will receive. No section outline.

export const BR_PROMPT = `You are a peer reviewer (bR — basic) for a scientific journal. Write one structured peer review of the submitted paper. Add "## Major Revisions" and "## Minor Revisions" lists of specific changes, and end with exactly one recommendation: Accept, Minor Revision, Major Revision, or Reject.

Your input has (1) the paper's title, authors, abstract, and full text; (2) prior work from the journal; and (3) optionally an ETHICS CO-AUTHOR BLOCK from the H Research Standards Verification Agent — integrate its findings if present.`;

export const IR_PROMPT = `You are an INNOVATION-focused peer reviewer (iR) for a scientific journal. Foreground novelty and positioning relative to prior work. Write one structured peer review of the submitted paper. Add "## Major Revisions" and "## Minor Revisions" lists of specific changes, and end with exactly one recommendation: Accept, Minor Revision, Major Revision, or Reject.

Your input has (1) the paper's title, authors, abstract, and full text; (2) prior work from the journal; and (3) optionally an ETHICS CO-AUTHOR BLOCK from the H Research Standards Verification Agent — integrate its findings if present.`;

export const AR_PROMPT = `You are an ADVERSARIAL peer reviewer (aR) for a scientific journal. Probe every weakness and challenge every claim at the highest bar. Write one structured peer review of the submitted paper. Add "## Major Revisions" and "## Minor Revisions" lists of specific changes, and end with exactly one recommendation: Accept, Minor Revision, Major Revision, or Reject.

Your input has (1) the paper's title, authors, abstract, and full text; (2) prior work from the journal; and (3) optionally an ETHICS CO-AUTHOR BLOCK from the H Research Standards Verification Agent — integrate its findings if present.`;

export const RR_PROMPT = `You are a RIGOROUS peer reviewer (rR) for a scientific journal. Apply strict methodological scrutiny — statistical correctness, design validity, reproducibility — without adversarial framing. Write one structured peer review of the submitted paper. Add "## Major Revisions" and "## Minor Revisions" lists of specific changes, and end with exactly one recommendation: Accept, Minor Revision, Major Revision, or Reject.

Your input has (1) the paper's title, authors, abstract, and full text; (2) prior work from the journal; and (3) optionally an ETHICS CO-AUTHOR BLOCK from the H Research Standards Verification Agent — integrate its findings if present.`;

export type PeerReviewPersona = "bR" | "iR" | "aR" | "rR";

export const PERSONA_LABELS: Record<PeerReviewPersona, string> = {
  bR: "Basic Reviewer",
  iR: "Innovation Reviewer",
  aR: "Adversarial Reviewer",
  rR: "Rigorous Reviewer",
};

export function getPeerReviewPrompt(persona: PeerReviewPersona): string {
  switch (persona) {
    case "aR": return AR_PROMPT;
    case "iR": return IR_PROMPT;
    case "rR": return RR_PROMPT;
    default:   return BR_PROMPT;
  }
}

export function extractRecommendation(reviewText: string): string | null {
  const text = reviewText || "";
  // Look for the final recommendation token. Order matters — match longer
  // strings first so "Major Revision" doesn't get caught by a bare "Major".
  const patterns: Array<{ re: RegExp; label: string }> = [
    { re: /\bmajor\s+revision\b/i, label: "Major Revision" },
    { re: /\bminor\s+revision\b/i, label: "Minor Revision" },
    { re: /\breject\b/i,           label: "Reject" },
    { re: /\baccept\b/i,           label: "Accept" },
  ];
  // Prefer the last occurrence (the final recommendation line).
  let best: { idx: number; label: string } | null = null;
  for (const p of patterns) {
    const re = new RegExp(p.re.source, "gi");
    let m: RegExpExecArray | null;
    let lastIdx = -1;
    while ((m = re.exec(text)) !== null) {
      lastIdx = m.index;
      if (m[0].length === 0) re.lastIndex++;
    }
    if (lastIdx >= 0 && (!best || lastIdx > best.idx)) {
      best = { idx: lastIdx, label: p.label };
    }
  }
  return best ? best.label : null;
}

export interface ExtractedRevisions {
  major: Array<{ description: string }>;
  minor: Array<{ description: string }>;
}

// Pull individual list items (bullets or numbered) out of a markdown section,
// joining continuation lines and dropping trivially short fragments.
function extractListItems(section: string): string[] {
  const items: string[] = [];
  let current = "";
  const flush = () => {
    const cleaned = current.replace(/\s+/g, " ").trim();
    if (cleaned.length >= 4) items.push(cleaned);
    current = "";
  };
  for (const raw of section.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      flush();
      current = bullet[1];
    } else if (line.trim().length === 0) {
      flush();
    } else if (current) {
      current += " " + line.trim();
    }
  }
  flush();
  return items;
}

// Parse "Major Revisions" / "Minor Revisions" markdown sections out of a peer
// review and return them as FS revision items (capped at 10 each).
export function extractRevisions(reviewText: string): ExtractedRevisions {
  const text = reviewText || "";
  const grab = (label: string): string[] => {
    const re = new RegExp(
      `(?:^|\\n)\\s*#{1,6}\\s*(?:\\*\\*)?\\s*${label}[^\\n]*\\n([\\s\\S]*?)(?=\\n\\s*#{1,6}\\s|$)`,
      "i",
    );
    const m = text.match(re);
    return m ? extractListItems(m[1]) : [];
  };
  return {
    major: grab("major\\s+revisions?").slice(0, 10).map((d) => ({ description: d })),
    minor: grab("minor\\s+revisions?").slice(0, 10).map((d) => ({ description: d })),
  };
}
