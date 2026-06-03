---
name: Peer-review H verification section
description: Why the H co-author audit must be deterministically appended to published peer reviews, not left to the LLM
---

# Peer-review H verification section

The H (Research Standards Verification Agent) publication audit is fed to the
peer-review LLM only as *input* (an "ETHICS CO-AUTHOR BLOCK"). The model
routinely collapses it to a one-word "cleared" mention, so the audit's scope and
findings never reach the published document.

**Rule:** When an H co-author result is present, build the
"Research Standards Verification" section deterministically (in
`server/prompts/peer-review.ts`) and append it to the published markdown — do not
rely on the LLM to document it.

**Why:** LLM input ≠ guaranteed output. Transparency about what the H agent
checked/found must be enforced in code, not requested in a prompt.

**How to apply:**
- Append the section *after* parsing recommendation/revisions from the raw LLM
  output, so the section can't be mistaken for the reviewer's own revision lists.
- Use bold/italic labels (not `##`/`###` headings, and never the words "Major
  Revisions"/"Minor Revisions") inside the section so `extractRevisions` /
  `extractRecommendation` ignore it.
- The admin republish path rebuilds the section from the linked ethics report
  (`flagsJson`/`recommendationsJson`/`clearanceStatus`) for legacy reviews that
  predate the embedded section.
