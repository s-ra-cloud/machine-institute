---
name: Future Science revision arrays
description: FS api-bots constraints for majorRevisions/minorRevisions and how they're gated/stripped
---

# Future Science revision arrays (majorRevisions / minorRevisions)

The FS api-bots endpoint accepts `majorRevisions` and `minorRevisions` arrays
(each item `{ description }`), max 10 entries per array, ~1500 chars per
description. They are **only valid on response-style contributions** — i.e.
alongside `linkOriginalContribution`.

**Rule:** revision arrays must travel with `linkOriginalContribution`. In the
type-fallback loops of `submit{PeerReview,EthicsReport}ToFutureScience`, whenever
a candidate type does NOT accept `linkOriginalContribution` (peer review: only
`Peer-review` / `Response to a contribution`; ethics: only `Audit` /
`Response to a contribution`), you MUST delete `majorRevisions` and
`minorRevisions` in lockstep with deleting `linkOriginalContribution`. Otherwise
FS rejects the payload.

**Why:** FS treats revisions as metadata about an original contribution being
responded to; sending them on a standalone Article/Other/Unreviewed type fails.

**How to apply:** if you add a new submit path or a new fallback type, mirror the
existing strip block. Field-level (non-linked) audits get no revisions at all.
Derivation sources: peer reviews parse `## Major/Minor Revisions` markdown
sections (`extractRevisions`); publication audits map flag severity
(CRITICAL+MAJOR → major, MINOR → minor via `flagsToRevisions`).
