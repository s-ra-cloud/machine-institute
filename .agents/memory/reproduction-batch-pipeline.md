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

**Live-run lessons (2026-10-13, first run of the batch pipeline, DeepSeek V4 via OpenRouter):**
- A pre-execution refusal (preparation guard) is never execution evidence; the host performs the guard's mechanical inspections and the model only decides bookkeeping-vs-scientific-input.
- DeepSeek V4 writes its claim analysis as prose instead of calling `record_results`; a stage must force its closing tool after the *first* prose answer (DeepSeek obeys a filtered tool list, not `tool_choice`), otherwise an executed experiment ends with every claim still pending and no diagnostic.
- Modal enforces per-command timeouts itself: a timed-out process returns `exit code 137` after the full allotment, not a null exit. Anything that classifies "TIMED OUT" only from a null exit code mislabels timeouts as command errors and the `timeout` blocker kind becomes unrecordable.
- Validator refusals must name the failed check (excerpt not verbatim / cited output shows no failure / wrong blocker kind, with the kinds the output supports / missing explanation words). A bare "do not match" refusal was retried verbatim 4× in one assessment.
- Proving a material is absent requires a tool output that literally says so; `read_file` of a missing path is normalized to a "File not found" line for that purpose. A listing of an existing directory can never support `missing-material`.
- Test gotcha: context protection appends each stage's `prematureStop` text to *every* request as the active instruction, so a scripted model cannot detect a nudge by that text; detect it by the presence of an assistant message instead. The loop also mutates its `messages` array in place — snapshot it in traces.
- Reasoning models spend `max_tokens` on thinking: DeepSeek V4 returned `finish_reason=length` with 8000 reasoning tokens and *no* content/tool call (sweep) and the judge's 6000-token batch budget died the same way, turning 23 graded claims into "judge batch failed → all inconclusive". A length-stop with nothing in it is a budget problem, not a prose problem: retry the same request with a larger output reserve (loop and judge both do this now) before spending any recovery nudge, and never swallow the judge error without its message.
- Assessment tolerance must match the judge's standard ("reasonable tolerance"): with "within rounding/reported precision" the model recorded 3.632 vs 3.635 as falsified. GPU/stochastic reruns differ in the third decimal; the rule now asks whether the paper's statement (sign, magnitude, significance) still holds.
- The independent judge can repeat the agent's rounding-only rationale despite reasonable-tolerance instructions. Such a rationale needs reassessment, not automatic scientific falsification or automatic verification. Near-zero sign changes with both intervals spanning zero are not evidence of a reversed effect.
- Run Python in the sandbox with `PYTHONUNBUFFERED=1`: a script killed at the timeout otherwise leaves an empty capture, so the timeout cannot be explained from evidence.

**Provider outage recovery**

Retry transient gateway failures on the identical model request with seconds-scale backoff, without replaying executed tools; apply recovery to the independent judge too. Keep deadlines and spending guards active on every attempt. Distinguish unsupported completion statuses from actual HTTP gateway outages even when the adapter assigns both status 502.

**Why:** a live run lost its sandbox and unfinished report after a provider 502 despite having two subsecond retries; subsecond rate-limit recovery is insufficient for an outage.

**How to apply:** preserve bounded retries in both tool-driven and plain generation paths; test sustained failure, eventual recovery, deadline refusal, and malformed responses separately.

**Planning completion reserves**

Recheck the stage's required tool between individual tool dispatches, including calls batched in one model response. Reserve submission and correction capacity before inspection consumes the stage allowance.

**Why:** a live planner used its whole allowance in parallel read calls; a required-tool check only at request construction could not protect the final submission slot.

**How to apply:** refuse surplus inspection without consuming the closing reserve, then request the closing tool with its declared schema. Never execute textual pseudo-tool markup as if it were a provider tool call.

**Computation completion and judging**

Full-token activation caches need substantial host RAM, not just GPU VRAM. Diagnose sudden per-prompt slowdowns with timing, retained output and stack traces before extending execution deadlines or shrinking scientific task sets.

**Why:** an isolated unchanged 72-task analysis ran prompts in ~0.1 seconds, then took 266–299 seconds per prompt as CPU caches grew under an 8-GiB resource bound. With 32 GiB, the same shipped analysis completed in 186 seconds in the live website pipeline without scientific code changes. Sufficient host RAM matters even when GPU VRAM fits the model.

For every reproduction method, establish matched samples/subsets and conditions before scientific verification or falsification. A successful shipped script may implement a different experiment. Preserve partial process output on stream errors instead of replacing it with empty text.

**Why:** a completed live report called a 72-task claim falsified using a 96-task rerun, and a killed experiment's output was unavailable. Completion alone does not establish comparison validity; missing capture must remain distinguishable from no progress.

Do not force a computation's closing submission while it still needs execution repairs. Automatically advance a successful designated computation to assessment, without treating execution success as scientific verification. Check stage completion between parallel tool dispatches.

**Why:** live derivation stages reached the round cap while a forced closing tool prevented further repairs; redundant closing requests and parallel reruns waste the shared allowance.

For raw-data re-derivation, retain the latest computation source preceding each cited execution in the judge's protected evidence, not only chronological context.

Preserve bounded command captures beyond the single agent-selected excerpt when sending evidence to the judge.

**Why:** a compound band/layer claim became inconclusive because excerpt-centered cropping hid the separate layer row despite successful execution. Context reduction must not silently erase the other measurements in a compound claim.

**Why:** matching printed metrics can come from stored summary fields instead of independent computation. A raw-looking filename and an exit-zero command cannot establish re-derivation.

**How to apply:** inspect observations, computation, and analysis identity together; summary extraction or insufficient provenance must remain inconclusive, even if every printed value matches.

**Judge reasoning budget lesson**

Treat output allowance as a per-request reasoning budget, not merely space for verdict JSON. Start with small batches, split exhausted multi-claim batches before retrying them, and leave deadline time for later batches.

**Why:** a fresh completed experiment cycle yielded no independent verdicts: a 14-claim judge exhausted 6k, 12k, and 24k responses, then its children restarted at 3k and exhausted the shared deadline. A large context window does not imply sufficient reasoning output.

**How to apply:** preserve cited evidence and conservative inconclusive outcomes; test both output exhaustion and slow requests with mocked providers before spending on another live run.

**Extraction repair guidance**

Keep rejected-candidate identities explicit when correcting a quotation. Give canonical, packet-local context when an exact shared phrase can locate it, but never automatically accept the suggested passage or clear a rejection because a different valid quotation arrived.

**Why:** a live extractor submitted shorter valid quotations without identifying the original rejection they replaced. The old rejection remained unresolved and correctly prevented GPU allocation, but generic exact-match errors did not help the model recover.

**How to apply:** corrections must still pass exact-source validation and explicitly replace the rejection; contextual hints are guidance, not evidence or automatic repairs.
