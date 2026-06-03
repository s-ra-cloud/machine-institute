// Substantive literature-review abstract fallback.
//
// A successfully generated literature review already contains a dedicated
// "## Abstract" section that routes.ts parses and publishes. But when that
// section is missing/unparseable, the old fallback published a content-free
// line ("Summary unavailable: this literature review on … was generated without
// a parseable abstract section"). This builds a sensible, non-empty abstract
// deterministically from the review's own Conclusion (or other substantive
// prose) so the published abstract still conveys real content.

const FALLBACK_SECTION_HEADINGS = [
  "conclusion",
  "conclusions",
  "comparative\\s+discussion",
  "research\\s+gaps",
  "thematic\\s+review[^\\n]*",
  "introduction",
];

// Collapse a markdown section into a single line of prose: drop list/heading
// markers, strip inline links and emphasis, collapse whitespace.
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

function grabSection(text: string, heading: string): string | null {
  const re = new RegExp(
    `(?:^|\\n)\\s*#{1,6}\\s*(?:\\*\\*)?\\s*${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n\\s*#{1,6}\\s|$)`,
    "i",
  );
  const m = text.match(re);
  if (!m) return null;
  const prose = sectionToProse(m[1]);
  return prose.length >= 40 ? prose : null;
}

const ABSTRACT_MAX = 1400;
const SECTION_MAX = 900;

// Build a deterministic, substantive abstract for a literature review when the
// model did not emit a parseable "## Abstract" section. Composes an opener
// naming the research question with the review's most informative section
// (Conclusion first, then discussion/gaps/thematic content).
export function buildLiteratureReviewFallbackAbstract(opts: {
  researchQuestion?: string | null;
  contentMarkdown?: string | null;
}): string {
  const clean = (s: string) => (s || "").replace(/\s+/g, " ").trim();
  const question = clean(opts.researchQuestion || "");
  const body = opts.contentMarkdown || "";

  let core = "";
  for (const heading of FALLBACK_SECTION_HEADINGS) {
    const section = grabSection(body, heading);
    if (section) {
      core = section;
      break;
    }
  }
  if (core.length > SECTION_MAX) {
    core = core.slice(0, SECTION_MAX - 1).trimEnd() + "…";
  }

  const opener = question
    ? `This literature review examines ${question}.`
    : "This literature review synthesizes the institute's publication corpus.";

  let abstract = core
    ? `${opener} ${core}`
    : `${opener} It surveys the relevant corpus, synthesizes the principal findings and points of convergence and tension across studies, identifies the open research gaps, and sets out the most promising directions for future work. See the full review for the detailed thematic analysis and references.`;

  abstract = abstract.replace(/\s+/g, " ").trim();
  if (abstract.length > ABSTRACT_MAX) {
    abstract = abstract.slice(0, ABSTRACT_MAX - 1).trimEnd() + "…";
  }
  return abstract;
}
