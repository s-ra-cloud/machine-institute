/**
 * Shared model-blind redaction logic for evaluation agents (peer reviewers and
 * the H Research Standards Verification Agent).
 *
 * Given the target paper's author string and detected authoring model, builds a
 * redactor that strips:
 *  - full author names ("MachInstit CS45bR-N1") and their distinctive tokens
 *    ("MachInstit", "CS45bR-N1"), case-insensitively;
 *  - the detected model label AND its common spelling variants (e.g. for
 *    "GPT-5": "GPT-5", "GPT 5", "GPT5", "gpt_5", "OpenAI GPT-5"), including
 *    optional vendor prefixes for Claude / Gemini / DeepSeek / GPT families.
 */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Vendor prefixes that may precede a model name in prose.
const VENDOR_PREFIX = "(?:(?:openai|anthropic|google|deepseek|meta|mistral)[\\s._/-]*)?";
// Separator allowed between model-name tokens and between digits: "-", " ", ".",
// "_", "/" or nothing ("GPT5", "gpt-5", "GPT 5", "Claude-Sonnet-4.5", "sonnet45").
const SEP = "[\\s._/-]*";

/**
 * Builds a case-insensitive RegExp matching common spelling variants of a model
 * label like "GPT-5", "Claude Sonnet 4.5", "DeepSeek R1", "Gemini 2.5 Pro".
 */
export function buildModelVariantPattern(label: string): RegExp {
  const tokens = label.trim().split(/[\s-]+/).filter(Boolean);
  const parts = tokens.map((tok) => {
    if (/^[\d.]+$/.test(tok)) {
      // Version token: digits joined by optional separators ("4.5" -> 4[sep]5).
      return tok.split(/\./).map(escapeRe).join(SEP);
    }
    // Mixed tokens like "GPT" / "R1" / "4o": split alpha/digit boundaries so
    // "GPT5" & "R 1" also match.
    return tok
      .split(/(?<=\d)(?=[a-z])|(?<=[a-z])(?=\d)/i)
      .map(escapeRe)
      .join(SEP);
  });
  // \b at the start; end guarded against running into more digits (so "GPT-5"
  // does not match inside "GPT-55" but does match "GPT-5's").
  return new RegExp(`\\b${VENDOR_PREFIX}${parts.join(SEP)}(?!\\d)`, "gi");
}

export interface RedactorOptions {
  /** Author string of the target paper (comma/semicolon separated). */
  authors?: string | null;
  /** Detected authoring model label of the target paper. */
  targetModel?: string | null;
}

const STOPWORDS = /^(the|and|of|for|with|from)$/i;

/**
 * Creates a redactor for model-blind mode. Replaces every occurrence of the
 * target paper's author names, name tokens, and model-name variants with
 * "[withheld]". Returns the identity function when there is nothing to redact.
 */
export function createRedactor(opts: RedactorOptions): (text: string) => string {
  const literals: string[] = [];
  if (opts.authors) {
    for (const name of opts.authors.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
      if (name.length >= 4) literals.push(name);
      for (const token of name.split(/\s+/)) {
        if (token.length >= 4 && !STOPWORDS.test(token)) literals.push(token);
      }
    }
  }
  // Longest first so full names are replaced before their tokens.
  literals.sort((a, b) => b.length - a.length);

  const patterns: RegExp[] = [];
  if (opts.targetModel) patterns.push(buildModelVariantPattern(opts.targetModel));

  if (literals.length === 0 && patterns.length === 0) return (t) => t;

  return (text: string): string => {
    let out = text;
    for (const lit of literals) {
      out = out.replace(new RegExp(escapeRe(lit), "gi"), "[withheld]");
    }
    for (const re of patterns) {
      re.lastIndex = 0;
      out = out.replace(re, "[withheld]");
    }
    return out;
  };
}
