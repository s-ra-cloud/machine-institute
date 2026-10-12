# Reproduction cycle — 12 October 2026

## First attempt after the authorized counter reset

- Normal shared website reproduction entrypoint; DeepSeek `deepseek/deepseek-v4-pro-0813`, Modal A10G if extraction completes, normal independent judge.
- Evidence: `.local/state/live-reproduction/website-1791802522943`.
- All six source packets visited; four completed extraction, two remained unresolved.
- Ten model requests, $0.07703388 accounted model spending, no Modal allocation.
- Eighteen accepted quotations remain pending. No experiments, scientific assessments or final judged report.
- Previous attempt completed two of six packets using eighteen model requests. This is an extraction-stage improvement in one run, not demonstrated end-to-end reliability.
- Failures: quotes changed from the source; claim text not verbatim in its quote; optional numerical metadata not verbatim; a remaining batch at the call limit.

## Repair and verification

Added an explicit option to use a validated source quote directly as the claim, avoiding separate transcription. Source matching, size limits, rejection identities, conflicting-value refusal and optional-metadata validation remain strict. No automatic paraphrase correction or inferred values.

Full single-worker suite: 837 passed, 2 skipped. The existing 13 TypeScript errors and default parallel-test timeout remain separate issues. Website workflow restarted cleanly; public homepage rendered. Signed-in UI was not visually verified.

## Live retry

A retry is being launched under the same spending window, not a second reset. Caps remain $5 DeepSeek and $10 Modal. Historical costs are archived and provider charges are unchanged. Live success of the new copy option is not yet established.

### Retry outcome

Evidence: `.local/state/live-reproduction/website-1791802896569`.
Five of six packets completed; 27 grounded quotations retained pending. No quotation-validation errors appeared in the recorded tool responses. One section still reported more claims after its local three-call limit, despite only ten of eighteen global extraction calls being used. No GPU, experiments or judged report.

Additional model spending: $0.06146844; cumulative cycle model spending: $0.13850232. Modal allocation: none.

The shared extraction code now lets productive batches use spare calls while reserving one visit per remaining packet. The overall eighteen-call cap stays in place. Repeated invalid or duplicate batches do not qualify for extra calls, and remaining claims still prevent completion. This repairs an allocation restriction; it does not establish live completion.

### Third attempt and offline correction

Evidence: `.local/state/live-reproduction/website-1791803162094`.
Five of six packets completed; 28 grounded quotations remain pending. One packet completed after five calls, confirming live use of the spare-call path. Another had two valid batches followed by its first invalid quote on call three. The new guard incorrectly counted successful batches against the repair allowance and stopped before that quote could be repaired.

The guard now counts consecutive invalid or non-progressing submissions separately from productive batches. Validated progress resets only the stall counter, not the eighteen-call global cap. Three consecutive invalid or non-progressing calls still stop extraction; schema-invalid calls count too. An end-to-end offline replay verifies correction after a late first error and subsequent assessment.

Verification: 842 tests passed, 2 skipped, across 63 files with one worker. The same 13 pre-existing TypeScript errors remain; none are in the changed code. The default parallel-test reliability issue remains separate.

Third-attempt model cost: $0.08211720. Total model cost since reset: $0.22061952, leaving $4.77938048 of the $5 allowance. No Modal allocation; full $10 allowance remains. No experiments or final judged report were produced. Paid retries are paused after three attempts; the late-error correction has not been tested live.

### User-authorized fourth attempt — extraction completed, run ongoing

Evidence: `.local/state/live-reproduction/website-1791803573941`.
All six packets completed in thirteen extraction calls, retaining 32 grounded claims. The previously blocked packet completed in four calls. A Modal A10G sandbox was allocated successfully. This establishes live extraction progress, not scientific verification or completed reporting.

At the post-extraction checkpoint, cumulative model spending was $0.29848632. The runner reserved $5 against the $10 Modal allowance for the allocation; this is a conservative reservation, not measured billed GPU cost. Costs were not reset. Planning, experiments, independent judging and the final outcome remain pending.

### Fourth attempt — final outcome

Stopped at the controller's 100-call global resource limit while preparing R5. Extraction remained complete. The real Modal run executed the shipped baseline successfully in 292.1 seconds and the lexical-controls script in 103.3 seconds, plus two R4 analysis commands. The preparation guard refused the baseline twice before the successful run; shared execution covered R2 and R3. R4 recovered through a method-plan revision.

Four of 32 claims received provisional agent assessments: three falsified and one verified. Twenty-eight remain pending. Independent judging and final reporting were not reached, so these are not final scientific verdicts. This is progress beyond the recent extraction failures, not proof of better end-to-end performance than historical runs reaching later claims.

The remaining bottleneck is call-budget efficiency across planning, inspection, execution and assessment: planning recovery triggered for R1, R2, R4 and R5, while R4 required a method revision. The evidence supports investigating repeated inspection and experiment reuse; it does not establish a single root cause or justify bypassing validation or raising the spending cap.

The run logged successful Modal sandbox termination. Cumulative model spending since reset is $1.49969028, leaving $3.50030972. Modal reservation remains $5, leaving $5 of reservation allowance; actual billed GPU cost has not been reconciled. No further paid run is active.
