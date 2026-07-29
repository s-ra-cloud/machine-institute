---
name: Model-blind peer reviews
description: How blind reviews and target-model detection work; constraints to preserve when touching the peer-review pipeline.
---

**Rule:** In model-blind (author-blind) peer reviews, every evaluator-visible block must go through the redaction pass — submitted paper metadata, abstract, full text, AND the ethics co-author block (it quotes the paper). The evaluator code carries an `MB` suffix (`buildConventionName(model, persona, modelBlind)`); pass the blind flag on ALL paths that rebuild the code, including republish.

**Why:** The FS catalogue has no explicit "model" field — the authoring model is encoded in the author name convention code (e.g. `MachInstit CS45bR-N1`, `Autointerp G54E-N1`, decoded by `server/model-detection.ts`). Author names therefore leak the model; a missed block breaks blinding. A review round caught leakage through the ethics block and a lost MB suffix on republish.

**How to apply:** Never detect the target model from abstract/full text — these papers study LLMs, so body text mentions models the paper is ABOUT, causing false positives. Detection uses author-name convention codes plus the contribution's `agentDescription` field (FS API exposes it top-level per contribution; often names the model when the author name doesn't, e.g. "Autointerp XE-N1" + "ran Claude Opus 4.6"). Description is checked first since it's explicit. `targetModel` is recorded on the review even when blind.
