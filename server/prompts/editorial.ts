// Substantive editorial abstract building.
//
// Editorials used to publish a boilerplate abstract: just the first ~200
// characters of the body (a hook paragraph), or the literal fallback "An
// editorial on <topic>", plus a hardcoded keyword list. A reader scanning that
// learned nothing about the editorial's actual thesis. Mirroring the peer-review
// approach, we now ask the model for a clearly-delimited leading summary,
// parse it out to build a real abstract, and fall back deterministically to the
// editorial's own opening prose when no summary section is present.

// Injected into the editorial prompt so the model emits a parseable, leading
// summary we can lift into the published abstract. The summary section is
// stripped from the displayed body (see stripEditorialSummarySection) so the
// rendered editorial keeps its flowing-prose style.
export const EDITORIAL_SUMMARY_INSTRUCTION = `Immediately after the title, add a section "## In Brief" of 3–4 sentences that states the editorial's central thesis, the key research developments it synthesizes, and its main forward-looking conclusion. This is a standalone summary of the whole editorial — not the opening hook. Do not include citations or markdown links in it. After this section, continue with the editorial body as instructed.`;

const SUMMARY_HEADINGS = [
  "in\\s+brief",
  "editorial\\s+summary",
  "summary",
  "tl;?dr",
  "in\\s+short",
  "overview",
  "abstract",
];

// Collapse a markdown section into a single line of prose: drop list markers and
// heading hashes, strip bold/italic markers and inline links, collapse space.
function sectionToProse(section: string): string {
  return (section || "")
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
        .trim(),
    )
    .filter((l) => l.length > 0)
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function summaryHeadingRegex(heading: string): RegExp {
  return new RegExp(
    `(?:^|\\n)\\s*#{1,6}\\s*(?:\\*\\*)?\\s*${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n\\s*#{1,6}\\s|$)`,
    "i",
  );
}

// Pull the editorial's leading summary out of the generated markdown. Returns
// null when no recognisable, non-trivial summary section is found.
export function extractEditorialSummary(editorialText: string): string | null {
  const text = editorialText || "";
  for (const heading of SUMMARY_HEADINGS) {
    const m = text.match(summaryHeadingRegex(heading));
    if (m) {
      const prose = sectionToProse(m[1]);
      if (prose.length >= 40) return prose;
    }
  }
  return null;
}

// Remove the leading summary section from the markdown so the displayed
// editorial keeps its flowing-prose style (the summary lives in the abstract /
// excerpt metadata instead). Only the first matching summary section is removed.
export function stripEditorialSummarySection(editorialText: string): string {
  let text = editorialText || "";
  for (const heading of SUMMARY_HEADINGS) {
    const re = summaryHeadingRegex(heading);
    if (re.test(text)) {
      text = text.replace(re, "\n").replace(/\n{3,}/g, "\n\n").trim();
      break;
    }
  }
  return text;
}

// Pull the first few substantive prose paragraphs out of an editorial body for
// the deterministic abstract fallback. Skips headings, list markers, and very
// short lines; strips inline markdown.
function leadingProse(bodyText: string, maxChars: number): string {
  const paragraphs: string[] = [];
  let collected = 0;
  for (const block of (bodyText || "").split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^##\s*references/i.test(trimmed)) break;
    const prose = sectionToProse(trimmed);
    if (prose.length < 40) continue;
    paragraphs.push(prose);
    collected += prose.length;
    if (collected >= maxChars) break;
  }
  return paragraphs.join(" ").replace(/\s+/g, " ").trim();
}

const ABSTRACT_MAX = 1200;

export interface EditorialAbstractInput {
  title?: string | null;
  // Substantive summary parsed from the editorial's "## In Brief" section.
  summary?: string | null;
  // The editorial body, used for the deterministic fallback only.
  bodyText?: string | null;
}

// Build the published editorial abstract: prefer the parsed summary; otherwise
// fall back deterministically to the editorial's own opening prose. Always
// concise, substantive, and non-empty.
export function buildEditorialAbstract(input: EditorialAbstractInput): string {
  const clean = (s: string) => (s || "").replace(/\s+/g, " ").trim();

  let abstract = clean(input.summary || "");
  if (!abstract) {
    abstract = leadingProse(input.bodyText || "", ABSTRACT_MAX);
  }
  if (!abstract) {
    const title = clean(input.title || "");
    abstract = title
      ? `Editorial: ${title}.`
      : "An editorial synthesizing current AI research trends across the institute's publication corpus.";
  }

  if (abstract.length > ABSTRACT_MAX) {
    abstract = abstract.slice(0, ABSTRACT_MAX - 1).trimEnd() + "…";
  }
  return abstract;
}

// ---------------------------------------------------------------------------
// Future Science keyword derivation
// ---------------------------------------------------------------------------
// Editorials used to publish a hardcoded keyword list ("editorial", "AI
// research", "automated science") which is useless for discovery. Derive
// salient terms from the editorial's own title and body, keep an "editorial"
// category tag, and always satisfy the FS 3-keyword minimum.

const TITLE_STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "with", "from",
  "by", "is", "are", "as", "at", "via", "using", "toward", "towards", "into",
  "over", "under", "about", "study", "studies", "analysis", "approach", "based",
  "between", "their", "this", "that", "these", "those", "than", "then", "when",
  "what", "which", "who", "how", "can", "could", "will", "would", "across",
  "why", "now", "new", "more", "most", "such", "its", "have", "has", "but",
  "not", "they", "them", "our", "we", "you", "your", "it", "be", "been",
  // Structural / section words that carry no topical signal.
  "references", "introduction", "conclusion", "abstract", "editorial",
  "summary", "brief", "paper", "papers", "title",
]);

function extractSalientTerms(text: string, limit: number): string[] {
  if (!text) return [];
  const counts = new Map<string, number>();
  for (const raw of text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)) {
    const w = raw.trim();
    if (w.length < 5 || TITLE_STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

export function deriveEditorialKeywords(opts: {
  title?: string | null;
  bodyText?: string | null;
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

  // 1. Salient terms from the title are the strongest signal.
  for (const term of extractSalientTerms(opts.title || "", 4)) {
    if (out.length >= 5) break;
    add(term);
  }
  // 2. Frequent terms from the body fill remaining slots.
  if (out.length < 6) {
    for (const term of extractSalientTerms(opts.bodyText || "", 8)) {
      if (out.length >= 6) break;
      add(term);
    }
  }
  // 3. A category tag so the contribution is discoverable as an editorial.
  add("editorial");
  // 4. Pad with a minimal generic set to satisfy the FS 3-keyword minimum.
  for (const f of ["AI research", "automated science"]) {
    if (out.length >= 3) break;
    add(f);
  }

  return out.slice(0, 8);
}
