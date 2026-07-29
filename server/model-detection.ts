/**
 * Detects the LLM that authored a Future Science paper from its document
 * metadata. The catalogue has no explicit "model" field, but by convention the
 * model is encoded in the author name (e.g. "MachInstit CS45bR-N1",
 * "Autointerp G54E-N1") and is sometimes spelled out in the agent description.
 *
 * Detection is best-effort: returns a canonical model label, or null when the
 * metadata carries no recognizable model signal.
 */

// Explicit model-name mentions (agent descriptions, free text). Order matters:
// more specific patterns first.
const EXPLICIT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /deepseek[-/ ]?r1/i, label: "DeepSeek R1" },
  { re: /deepseek/i, label: "DeepSeek V3.2" },
  { re: /claude[-\s]?sonnet[-\s]?4[.-]?5|sonnet[-\s]?4[.-]?5/i, label: "Claude Sonnet 4.5" },
  { re: /claude[-\s]?sonnet[-\s]?4(?![.-]?\d)|sonnet[-\s]?4(?![.-]?\d)/i, label: "Claude Sonnet 4" },
  { re: /claude[-\s]?opus/i, label: "Claude Opus" },
  { re: /claude[-\s]?haiku/i, label: "Claude Haiku" },
  { re: /gpt[-\s]?5/i, label: "GPT-5" },
  { re: /gpt[-\s]?4o/i, label: "GPT-4o" },
  { re: /gpt[-\s]?4/i, label: "GPT-4" },
];

// Convention-code initials embedded in agent author names. Matched against the
// code token of names like "MachInstit CS45bR-N1" or "Autointerp G54E-N1".
// Longest/most specific first so e.g. CS45 wins over CS4, G54 over G5.
const CODE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /^DSR1/, label: "DeepSeek R1" },
  { re: /^DS\d*/, label: "DeepSeek V3.2" },
  { re: /^CS45/, label: "Claude Sonnet 4.5" },
  { re: /^CS46/, label: "Claude Sonnet 4.6" },
  { re: /^CS4/, label: "Claude Sonnet 4" },
  { re: /^CO/, label: "Claude Opus" },
  { re: /^CH/, label: "Claude Haiku" },
  { re: /^G5/, label: "GPT-5" },
  { re: /^G4O/i, label: "GPT-4o" },
  { re: /^G4/, label: "GPT-4" },
];

/**
 * Extracts the configuration-code token from an agent author name.
 * "MachInstit CS45bR-N1" -> "CS45bR-N1"; "Autointerp G54E-N1" -> "G54E-N1".
 */
function extractCodeToken(authorName: string): string | null {
  const tokens = authorName.trim().split(/\s+/);
  // The code token is the one containing digits and/or a -N suffix, in ALL-CAPS-ish form.
  for (const t of tokens) {
    if (/^[A-Z]{1,4}\d/.test(t)) return t;
  }
  return null;
}

export function detectAuthoringModel(
  authorName?: string | null,
  agentDescription?: string | null,
): string | null {
  // 1) Agent description often spells the model out explicitly.
  if (agentDescription) {
    for (const { re, label } of EXPLICIT_PATTERNS) {
      if (re.test(agentDescription)) return label;
    }
  }
  // 2) Decode the convention code from the author name(s).
  if (authorName) {
    // Author strings may contain several names ("A, B"); test each.
    for (const single of authorName.split(/[,;]/)) {
      const code = extractCodeToken(single);
      if (code) {
        for (const { re, label } of CODE_PATTERNS) {
          if (re.test(code)) return label;
        }
      }
      // Some author names embed explicit model words too.
      for (const { re, label } of EXPLICIT_PATTERNS) {
        if (re.test(single)) return label;
      }
    }
  }
  return null;
}
