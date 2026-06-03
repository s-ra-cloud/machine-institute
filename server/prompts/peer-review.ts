// Peer-review persona prompts (bR / iR / aR / rR).
// One short prompt per persona (≤100 words). Each prompt explains the
// reviewer's role, the optional H Research Standards Verification Agent
// co-author, and what content the model will receive. No section outline.

// Shared closing instruction for every persona. It pins down (a) the revision
// lists, (b) a single, clearly-delimited final recommendation line in a fixed
// format, and (c) the rule that the verdict must be logically consistent with
// the severity of the requested revisions — a non-empty Major Revisions list
// rules out "Accept" and "Minor Revision".
export const RECOMMENDATION_INSTRUCTION = `Add "## Major Revisions" and "## Minor Revisions" lists of specific changes. Then finish with a single final line, on its own, in exactly this format:

Recommendation: <verdict>

where <verdict> is one of: Accept, Minor Revision, Major Revision, or Reject. Emit this line exactly once, as the very last line of your review. The verdict must be logically consistent with your revision lists: if your Major Revisions list has one or more items, the verdict must be "Major Revision" or "Reject" — never "Accept" or "Minor Revision".`;

const INPUT_DESCRIPTION = `Your input has (1) the paper's title, authors, abstract, and full text; (2) prior work from the journal; and (3) optionally an ETHICS CO-AUTHOR BLOCK from the H Research Standards Verification Agent — integrate its findings if present.`;

export const BR_PROMPT = `You are a peer reviewer (bR — basic) for a scientific journal. Write one structured peer review of the submitted paper. ${RECOMMENDATION_INSTRUCTION}

${INPUT_DESCRIPTION}`;

export const IR_PROMPT = `You are an INNOVATION-focused peer reviewer (iR) for a scientific journal. Foreground novelty and positioning relative to prior work. Write one structured peer review of the submitted paper. ${RECOMMENDATION_INSTRUCTION}

${INPUT_DESCRIPTION}`;

export const AR_PROMPT = `You are an ADVERSARIAL peer reviewer (aR) for a scientific journal. Probe every weakness and challenge every claim at the highest bar. Write one structured peer review of the submitted paper. ${RECOMMENDATION_INSTRUCTION}

${INPUT_DESCRIPTION}`;

export const RR_PROMPT = `You are a RIGOROUS peer reviewer (rR) for a scientific journal. Apply strict methodological scrutiny — statistical correctness, design validity, reproducibility — without adversarial framing. Write one structured peer review of the submitted paper. ${RECOMMENDATION_INSTRUCTION}

${INPUT_DESCRIPTION}`;

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

const VERDICT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // Order matters — match longer strings first so "Major Revision" doesn't get
  // caught by a bare "Major".
  { re: /\bmajor\s+revision\b/i, label: "Major Revision" },
  { re: /\bminor\s+revision\b/i, label: "Minor Revision" },
  { re: /\breject\b/i,           label: "Reject" },
  { re: /\baccept\b/i,           label: "Accept" },
];

// Resolve a verdict label from a short fragment (e.g. the text after
// "Recommendation:"), matching the first known verdict keyword it contains.
function verdictFromFragment(fragment: string): string | null {
  const text = fragment || "";
  let best: { idx: number; label: string } | null = null;
  for (const p of VERDICT_PATTERNS) {
    const m = text.match(p.re);
    if (m && m.index !== undefined && (!best || m.index < best.idx)) {
      best = { idx: m.index, label: p.label };
    }
  }
  return best ? best.label : null;
}

export function extractRecommendation(reviewText: string): string | null {
  const text = reviewText || "";

  // 1. Prefer the explicit, clearly-delimited final recommendation line the
  //    persona prompts instruct the model to emit, e.g.
  //    "Recommendation: Major Revision". Use the LAST such line so a stray
  //    earlier mention can't win. Strip markdown emphasis/brackets first.
  const lineRe = /^[\s>*_#-]*recommendation\s*[:\-—]\s*(.+?)\s*$/gim;
  let lineMatch: RegExpExecArray | null;
  let lastFromLine: string | null = null;
  while ((lineMatch = lineRe.exec(text)) !== null) {
    const fragment = lineMatch[1].replace(/[*_`>\[\]]/g, " ");
    const verdict = verdictFromFragment(fragment);
    if (verdict) lastFromLine = verdict;
  }
  if (lastFromLine) return lastFromLine;

  // 2. Fall back to the last-occurrence heuristic over the whole text when no
  //    explicit recommendation line is present.
  let best: { idx: number; label: string } | null = null;
  for (const p of VERDICT_PATTERNS) {
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

// Reconcile a parsed verdict with the severity of the requested revisions so
// the conclusion can never contradict the body: if there is one or more Major
// Revision, the verdict cannot be "Accept" or "Minor Revision" — upgrade it to
// "Major Revision". "Reject" is left untouched (it is already at least as
// severe), as is any verdict when there are no major revisions.
export function reconcileRecommendation(
  recommendation: string,
  majorRevisionsCount: number,
): string {
  if (majorRevisionsCount <= 0) return recommendation;
  const normalized = (recommendation || "").trim().toLowerCase();
  if (normalized === "accept" || normalized === "minor revision") {
    return "Major Revision";
  }
  return recommendation;
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

// ---------------------------------------------------------------------------
// Research Standards Verification section (H co-author audit)
// ---------------------------------------------------------------------------
// The H Research Standards Verification Agent runs a parallel publication audit
// when it is enabled as a co-author. Its findings are fed to the peer-review LLM
// as input, but the model frequently collapses them to a one-word "cleared"
// mention. To guarantee the published document always documents WHAT the H agent
// checked, HOW, and WHAT it found, we deterministically build a dedicated section
// from the audit result and append it to the review markdown before publishing.

export interface VerificationSectionInput {
  clearanceStatus: string;
  clearanceStatement: string;
  flags: Array<{ severity: string; summary: string }>;
  recommendations: string[];
}

export const VERIFICATION_SECTION_HEADING = "Research Standards Verification";

function prettyClearanceStatus(status: string): string {
  switch ((status || "").toUpperCase()) {
    case "CLEARED": return "Cleared";
    case "CLEARED_WITH_CONDITIONS": return "Cleared with conditions";
    case "NOT_CLEARED": return "Not cleared";
    default: return (status || "Unknown").replace(/_/g, " ");
  }
}

// Returns true when the given markdown already contains the deterministic
// verification section (so callers don't append it twice on republish).
export function hasVerificationSection(markdown: string): boolean {
  if (!markdown) return false;
  const re = new RegExp(`(?:^|\\n)\\s*#{1,6}\\s*${VERIFICATION_SECTION_HEADING}\\b`, "i");
  return re.test(markdown);
}

// Build a self-contained markdown section documenting the H co-author audit:
// its scope/methodology, clearance status + statement, findings by severity
// (or an explicit clean-result line), and the agent's recommendations.
export function buildVerificationSection(input: VerificationSectionInput): string {
  const clean = (s: string) => (s || "").replace(/\s+/g, " ").trim();
  const bySeverity = (sev: string) =>
    (input.flags || [])
      .filter((f) => (f.severity || "").toUpperCase() === sev)
      .map((f) => clean(f.summary))
      .filter(Boolean);

  const critical = bySeverity("CRITICAL");
  const major = bySeverity("MAJOR");
  const minor = bySeverity("MINOR");
  const totalFlags = critical.length + major.length + minor.length;

  const lines: string[] = [];
  lines.push(`## ${VERIFICATION_SECTION_HEADING}`);
  lines.push("");
  lines.push(
    "This peer review was produced together with a parallel publication audit by the H Research Standards Verification Agent (listed as co-author). The audit is independent of the assessment above and is summarised here for transparency.",
  );
  lines.push("");
  lines.push(
    "**Scope & methodology.** The verification agent examined the paper against eight research-standards categories — (A) citation fraud, (B) data fabrication, (C) selective reporting, (D) plagiarism, (E) undisclosed conflicts of interest or AI involvement, (F) replication-blocking non-disclosure, (G) scope misrepresentation, and (H) safety disclosure. Every extractable citation was independently checked — by DOI, arXiv ID, Future Science slug, or author–year — against the journal's indexed abstracts and the OpenAlex bibliographic database, and any cited URLs were resolved. Interpretive or quality concerns (e.g. novelty, writing style, anthropomorphism) are explicitly out of scope for this audit.",
  );
  lines.push("");
  lines.push(`**Clearance status:** ${prettyClearanceStatus(input.clearanceStatus)}`);
  lines.push("");
  const statement = clean(input.clearanceStatement);
  lines.push(`**Clearance statement.** ${statement || "No clearance statement was recorded by the verification agent."}`);
  lines.push("");

  lines.push("**Findings.**");
  if (totalFlags === 0) {
    lines.push("");
    lines.push(
      "No research-standards concerns were identified across the eight audited categories; the paper was cleared on every checked dimension, including independent citation and URL verification.",
    );
  } else {
    const block = (label: string, items: string[]) => {
      if (items.length === 0) return;
      lines.push("");
      lines.push(`*${label}:*`);
      for (const it of items) lines.push(`- ${it}`);
    };
    block("Critical concerns", critical);
    block("Major concerns", major);
    block("Minor concerns", minor);
  }

  const recs = (input.recommendations || []).map(clean).filter(Boolean).slice(0, 8);
  if (recs.length > 0) {
    lines.push("");
    lines.push("**Verification agent recommendations.**");
    for (const r of recs) lines.push(`- ${r}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Future Science keyword derivation
// ---------------------------------------------------------------------------
// Peer-review keywords used to be hardcoded ("peer review", "ai research",
// persona) which is useless for discovery. Derive meaningful keywords from the
// audited paper's own Future Science keywords, falling back to salient terms in
// the paper title, and only then to a minimal generic set — always satisfying
// the FS minimum of 3 keywords.

const TITLE_STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "with", "from",
  "by", "is", "are", "as", "at", "via", "using", "toward", "towards", "into",
  "over", "under", "about", "study", "studies", "analysis", "approach", "based",
  "between", "their", "this", "that", "these", "those", "than", "then", "when",
  "what", "which", "who", "how", "can", "could", "will", "would", "across",
]);

function extractTitleKeywords(title: string): string[] {
  if (!title) return [];
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4 && !TITLE_STOPWORDS.has(w));
}

export function derivePeerReviewKeywords(opts: {
  paperKeywords?: string[] | null;
  paperTitle?: string | null;
  persona: PeerReviewPersona;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const c = (raw || "").replace(/\s+/g, " ").trim();
    const key = c.toLowerCase();
    if (c.length >= 2 && c.length <= 60 && !seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  };

  // 1. The audited paper's own Future Science keywords are the best source.
  for (const k of opts.paperKeywords ?? []) {
    if (out.length >= 6) break;
    add(k);
  }

  // 2. Salient terms from the paper title fill any remaining slots.
  if (out.length < 5) {
    for (const term of extractTitleKeywords(opts.paperTitle || "")) {
      if (out.length >= 6) break;
      add(term);
    }
  }

  // 3. A category tag so the contribution is still discoverable as a review.
  add("peer review");

  // 4. Pad with a minimal generic set to satisfy the FS 3-keyword minimum.
  for (const f of ["ai research", "research standards", opts.persona]) {
    if (out.length >= 3) break;
    add(f);
  }

  return out.slice(0, 8);
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
