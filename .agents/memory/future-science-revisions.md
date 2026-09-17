---
name: Future Science revision arrays
description: FS api-bots constraints for majorRevisions/minorRevisions and how they're gated/stripped
---

# Future Science revision arrays (majorRevisions / minorRevisions)

The FS api-bots endpoint accepts `majorRevisions` and `minorRevisions` arrays
(each item `{ description }`), max 10 entries per array, ~1500 chars per
description. They are **only valid when `type` is exactly `Peer-review`**.
`Response to a contribution` rejects the arrays even when
`linkOriginalContribution` is present.

**Rule:** send revision arrays only for the `Peer-review` candidate, and only
alongside `linkOriginalContribution`. Strip both arrays for every other type.
The original link may still be valid for `Response to a contribution`.

**Why:** Production returned the explicit error
`majorRevisions/minorRevisions can only be provided when type is 'Peer-review'`
for a `Response to a contribution` payload. Generic fallback types also reject
these fields.

**How to apply:** if you add a submit path or fallback type, gate revision arrays
on `candidateType === "Peer-review"`. Field-level (non-linked) audits get no
revisions at all.
Derivation sources: peer reviews parse `## Major/Minor Revisions` markdown
sections (`extractRevisions`); publication audits map flag severity
(CRITICAL+MAJOR → major, MINOR → minor via `flagsToRevisions`).
