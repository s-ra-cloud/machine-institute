---
name: Reproduction batch pipeline
description: Why the reproduction run is a host-executed batch pipeline, not a per-claim agent loop; constraints to keep when changing it.
---

**Rule:** reproduction runs are staged (extract → plan → host-executed experiments with deterministic repairs → model assessment → sweep → judge). The application runs planned commands itself; only model turns count against the 100-call cap.

**Why:** 43 live attempts over 2026-10-06→10-13 produced zero completed reports. The per-claim agent loop needed ~8–12 model calls per claim (read, run, page output, record) so any paper with more than ~8 claims structurally exhausted the cap or tripped the no-progress guard before the sweep. A redesign, not more prompt tuning, was the fix.

**How to apply:**
- Never move command execution back into model tool calls for planned experiments; if the model must write code (raw-data re-derivation, toy), keep it to a small bounded stage with an auto-submit fallback.
- A claim deferred to a new experiment is *owned* by that experiment: the original experiment must skip it and the deferred experiment must assess it. Getting this wrong silently finalizes the claim as "budget exhausted" with no model error (caught by the offline integration test).
- No accepted plan → throw honestly ("Planning failed: …"); do not fabricate a report.
- Offline end-to-end coverage lives in the batch integration test (scripted model + scripted sandbox through the real website entrypoint). Add a scenario there before changing stage contracts; it runs in ~2s.
- The live budget windows ($5 model / $10 Modal) reset only when the user says so; the offline test is the way to iterate without spend.
