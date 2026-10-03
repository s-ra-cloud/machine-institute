# Reproduction controller and validation

## Default flow

Public creation and retry routes use the stage controller, not the historical
open-ended reproduction loop. Saved scientific instructions remain in force;
the application owns workflow transitions and source bookkeeping.

1. Canonical paper text becomes overlapping, Unicode-safe packets with SHA-256
   identities and UTF-16 offsets. Results-like headings only prioritize packets;
   they are not evidence of scientific meaning.
2. Native `submit_claims` calls supply exact quotations. At most six packets,
   three submission attempts per packet and twelve accepted claims are permitted.
   The cap applies before registration. Valid siblings survive rejected candidates;
   retries never duplicate accepted claims. Optional metadata must be quoted or
   explicitly omitted by the model, never inferred. Later packet validation
   exhaustion retains prior valid claims for planning; zero accepted claims,
   persistence/provider failures and deadline exhaustion still fail before GPU
   allocation. Coverage, failed packet ranges and unprocessed packet counts are
   disclosed in checkpoints and prominently in the report. This bounded sample
   is not an exhaustive review, even when all scheduled packets were attempted.
3. Each accepted claim receives a material-grounded plan, an execution stage,
   and evidence assessment. Planning allows 12 calls, execution 30, assessment
   8, and at most two plan revisions per claim. These allowances never override
   the shared 100-call budget or two-hour deadline.
4. qP suitability, planned adaptations, sealed execution, dependency provenance
   and original-result comparability restrictions still apply.
   Each protected stage packet carries the complete authorized qP assessment,
   including exact adaptation paths, reasons and intended changes—not only the
   clipped judge summary.
5. Accepted claim state produces the logbook deterministically. Independent
   judging remains separate; unavailable judging never grants a verified verdict.
   Failed runs retain an explicitly incomplete report and cannot publish it.

The actual fitted request is checked for the complete current claim/plan packet.
If that packet cannot fit, the stage fails rather than silently working without it.
The source and command evidence store remains separate from the model transcript.
For a rerun, the cited successful standalone planned entrypoint must itself
produce the exact measurement excerpt and reproduced value. Evidence cannot be
assembled from a failed script plus a successful CSV display, or from an unrelated
successful command. Shell chains are not accepted as standalone entrypoint
evidence. Downstream measurement processing must use an appropriately validated
method rather than borrowing an earlier script's execution status.

## Persistence and interruption semantics

The existing private diagnostic table stores bounded checkpoints containing
controller state, plan/claim metadata, output hashes and a sanitized partial
logbook. It does not store credentials, command text or full raw command outputs.
Large output hashes are metadata, **not a claim that the output can be restored
after a process restart**. Full raw evidence is retained within the active session;
qP also keeps its existing content-addressed provenance.

Before every scientific command dispatch, a durable checkpoint records that its
completion is unknown. If saving fails, the command does not launch. Once output
is observed, another checkpoint updates the state. An interruption between those
writes remains ambiguous; the system does not automatically replay the command.
This release does not resume interrupted sandboxes or hydrate a live session from
those metadata-only checkpoints.

Failure exports retain initial milestones and first validation/provider failures
alongside the bounded recent-event tail. Private checkpoint data remains behind
the existing administrator-only diagnostics endpoint. Only the application-built,
credential-redacted incomplete logbook is exposed on a failed public detail page.

## Offline verification versus model reliability

`reproduction-controller.test.ts` covers deterministic transitions, budgets,
unknown command completion, canonical Unicode provenance and report construction.
`reproduction-pipeline-integration.test.ts` exercises the default entry point using
native mocked provider responses that follow stage contracts, not global turn
numbers. It covers P and qP, malformed extraction, CSV displays, wrong claims,
late same-batch calls, failed persistence and unavailable judging.

The four historical integration suites explicitly use `runLegacyBaseline` for
offline before/after comparison. They are **not acceptance evidence for the new
controller**. Lower-level validator, isolation and context-fitting tests remain.

No mocked test measures whether a real selected model chooses useful actions.
No live model or GPU validation was performed for this implementation.

## Opt-in compatibility benchmark

The following prints instructions without making model requests:

    npx tsx script/reproduction-compatibility.ts

Only after separately approving model API spending:

    npx tsx script/reproduction-compatibility.ts --approve-model-charges --model <exact-managed-model-id> --repetitions 3

This uses the real selected model with synthetic tool outputs, a two-minute
deadline and 24-call allowance per sample. It creates no sandbox, runs no shell
commands and never publishes. The reusable probe also accepts an explicitly
supplied BYOK model configuration; do not put credentials in command arguments,
files, test reports or source control.

The result includes per-sample failures, stage reach rates and overall success
rate. Actual monetary costs are not returned by the adapter and must be checked
against provider billing. Repeated success here is a compatibility signal, not
proof of scientific reproduction. A real dataset/GPU evaluation requires its own
approval.

## Rollout and rollback

The new controller is the public default. No HTTP parameter enables the legacy
controller. Keep the historical baseline strictly for offline comparisons.
If rollback is necessary, use a project checkpoint from before this change; do
not silently switch models or route a failed paid run through the old loop.