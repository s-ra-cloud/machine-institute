---
name: Reproduction recovery contract
description: Why evidence enforcement must include live repair and runtime instructions for saved prompts.
---

Evidence validation must provide a practical repair path while the sandbox remains alive; rejecting incomplete final reports alone is not a reliability fix.

Persist remote sandbox identity immediately on allocation, independently of background stdout and phase checkpoints.

**Why:** A workspace restart destroyed the runner and its output log while its Modal sandbox stayed active. The surviving extraction checkpoint did not identify the remote allocation; cleanup required matching the sole active reproduction sandbox to the uploaded paper.

**How to apply:** Do not infer sandbox termination from a lost background task. Preserve reservations, inspect remote state and establish ownership before cleanup. Never automatically replay an interrupted command whose completion is unknown. This is a recovery requirement, not a claim that current checkpoints support resumption.

Live reproduction-and-repair work must use exactly the website's normal workflow, including Modal GPU execution and judging, not a separate extraction-only or compatibility procedure.

**Why:** The user explicitly rejected an alternative runner because the goal is to fix the usual process. “Not reproduced” is a valid scientific outcome; software fixes must not force a passing result.

**How to apply:** Exercise the existing website orchestration and distinguish infrastructure/software failures from scientific non-reproduction. Obtain separate approval for model and Modal spending limits; do not substitute CPU-only or simulated execution.

The user's objective is: “i just want to fix bugs until reports work completely.” Do not substitute partial-report handling for that goal.

**Why:** The user clarified this when offered partial reports after budget exhaustion.

**How to apply:** Continue repairing blockers to complete assessment, independent judging and final reporting. Respect the approved spending caps and distinguish offline end-to-end tests from a completed live reproduction.

Share scientifically compatible experiment planning and execution across claims, but never merge their source identities, evidence assessments, or verdicts.

**Why:** The user approved refactoring the website's shared workflow after repeated per-claim planning exhausted the global allowance before judging. This approval does not justify silently caching experiments or extending qP authorization.

**How to apply:** Require explicit per-claim measurements under the same method and materials, preserve individual revision paths, and keep suitability/adaptation scope binding for every grouped claim. Unrelated claims remain separate. Offline grouped-report tests do not establish live-model reliability.

Shared execution must explicitly account for every grouped measurement before handing off to assessment, using captured command evidence or an honest missing-measurement limitation.

**Why:** A live grouped run executed only part of its promised measurements, so siblings individually returned to planning and exhausted the global allowance despite sharing a plan. Requiring another manual transcription at the shared handoff then caused refusal loops even after successful execution.

**How to apply:** Put all measurements in execution context and preserve each claim's handoff separately, using original successful execution IDs or explicit limitations, not duplicate quotes. Rerun references must identify a planned source execution, not a command reprinting supplied values. Exact quotes belong to assessment. Coverage is not a scientific verdict; assessment and independent judging must still reject unsupported measurements and copied precomputed summaries.

Validate raw-input eligibility and inspection when accepting a raw-data re-derivation plan, rather than first discovering missing provenance at result recording.

**Why:** A live plan named only a Python source file and guessed at raw artifacts; execution became a model rerun, triggering method changes and repeated assessment repairs until the global allowance ran out.

**How to apply:** Use the same supported-input format rule in planning and final evidence validation. Preserve original file-read IDs and paths through grouped plans and assessment. File eligibility and inspection do not establish that supplied values are raw observations; independent scientific judgment remains required.

Provide an explicit verbatim-copy operation for compound measurement text rather than relying only on repeated instructions about literal substring matching.

**Why:** A live experiment completed, but assessment repeatedly failed literal-value validation for a multi-metric claim until its allowance expired. Stronger wording alone did not recover.

**How to apply:** Copy only on an explicit request, reject conflicting supplied values, and keep exact-output provenance, method validation and independent judging unchanged. Copying an excerpt is formatting, not scientific verification.

Explicit-copy tool schemas must require the source excerpt and state its size bound; a copy flag must never imply automatic evidence retrieval.

**Why:** A live assessment repeatedly requested copying an invalid excerpt until its stage budget expired. The generic error did not distinguish missing/blank input from excessive length, so the retained trace cannot establish which occurred.

**How to apply:** Align schema requirements with runtime validation, report the specific shape or length failure without exposing full arguments, and test missing, blank and oversized excerpt recovery separately. Never manufacture a measurement to repair formatting.

Stage-controlled planning needs its own recovery instructions, not the legacy finalization handoff.

**Why:** A live run retained twelve claims but exhausted planning on README/list repeats. The legacy handoff requests result recording, which is not permitted during planning; restoring that callback alone would just stop earlier.

**How to apply:** Keep repair within the current stage allowance, preserve inspected references and exact claim identity through compaction, and test a successful planning-to-execution replay as well as bounded failure. Never treat more browsing as scientific progress.

Method-change recovery must preserve the assessment's intended method and reason across fresh planning transcripts; it must not merely tell the model to revise.

**Why:** A live run repeatedly selected the same full-rerun plan while attempting to report raw-data re-derivation after execution failures. The empty revision handoff lost the decision that motivated replanning.

**How to apply:** Treat a requested method change as an explicit workflow decision, not a scientific verdict. Preserve evidence and original source identity, require a matching plan, and test that a failed experiment can reach judging and complete reporting with an honestly limited outcome.

Verbal planning-repair hints alone are not evidence of live recovery.

**Why:** A paid DeepSeek run on the real Modal workflow used every planning call on reads/retrievals despite receiving the repair instruction, never committing a plan. Reserve transition capacity structurally rather than merely repeating stronger wording.

**How to apply:** Preserve qP suitability before plan submission and model ownership of scientific arguments. A required transition tool is not permission to fabricate a plan or a scientific result. Verify improvements with the same real workflow, not only cooperative mocked turns.

Treat extraction output-token exhaustion separately from absent scientific claims.

Execution needs stage-specific recovery too; successful planning is not evidence that experiments run.

**Why:** A subsequent real run accepted a grounded plan but spent its whole execution allowance browsing, while legacy hints requested result recording that the execution stage does not expose.

**How to apply:** Do not inject legacy final-logbook/result-recording instructions into execution. Bound browsing while retaining a choice between performing analysis and requesting assessment/revision; never force an invented command or verdict.

Keep immutable stage handoffs limited to required scientific state and compact evidence references.

**Why:** A live run reached a valid plan but failed before execution because duplicate read excerpts in the protected stage packet could not be compacted below the local input allowance.

**How to apply:** Preserve the exact claim, plan, qP authorization and original evidence IDs. Retrieve full evidence on demand rather than protecting multiple large copies in every stage's initial packet.

Do not treat any successful shell call as progress or rely on pre-execution evidence references after compaction.

Do not silently cache scientific executions. Repeating a successful planned command should first prompt evidence retrieval or an explicit reason for a fresh execution.

**Why:** Live runs repeated successful analyses across claims, but identical commands can also represent legitimate independent replicates or changed inputs. Automatic reuse would risk changing the experiment.

**How to apply:** Keep original evidence IDs and let the model justify deliberate repetition. A reuse hint grants no verdict and must never be presented as a newly executed experiment.

**Why:** A live run moved past directory browsing but repeatedly ran the same grep/sed inspections; resetting navigation after every command let this continue until the execution allowance ended. The immutable stage packet also predated those commands.

**How to apply:** Compare captured outputs without transient duration text, preserve compact current command references in bounded state, and move persistent no-progress execution to assessment/revision. This is loop control, never evidence of scientific reproduction.

**Why:** A real DeepSeek retry returned length-truncated responses repeatedly for Results packets while accepting empty lists elsewhere, ending with no grounded claims. Output ceilings for reasoning models also cover reasoning, not just the visible structured answer.

**How to apply:** Preserve rejection of truncated tool calls, provision bounded structured-output headroom, and inspect packet-level finish reasons before interpreting empty extraction as a property of the paper.

**Why:** A previous change passed validator tests and review but a subsequent real run still failed with pending claims and malformed evidence. The tests demonstrated rejection rather than successful orchestration recovery.

**How to apply:** Test the actual model/tool orchestration using recorded or simulated premature-stop sequences, including completion beyond two productive recovery cycles, no-progress termination, and recovery of old evidence without rerunning expensive experiments. Distinguish simulated validation from live GPU/model verification when reporting results.

Extraction coverage is not scientific coverage: accepting a bounded set of exact quotations does not establish that every core result was selected.

**Why:** Early extraction cutoffs omitted later paper sections, while optional-field refusals left other packets unresolved. The user wants complete reports, not partial reports substituted for that goal. Earlier accepted claims must survive a failure without implying that omitted passages were assessed.

**How to apply:** Reserve bounded extraction capacity for later packets rather than stopping at an arbitrary claim count. Preserve grounded claims in checkpoints, but require every source packet to resolve before allocating a GPU. If coverage cannot fit the unchanged allowance, stop explicitly instead of launching a partial-paper run. Completion of source inspection still does not prove that the model selected every scientific claim.

Rejected extraction candidates need stable repair identities independent of their wording; structured-only stages must not request final scientific reports on exhaustion.

**Why:** A correction that changes claim text can leave the original rejection permanently outstanding when identity is derived from the text. Also, the generic loop's forced final-logbook request caused report-style prose during extraction; not every observed report was unsolicited model drift.

**How to apply:** Require explicit replacement of an outstanding rejection when wording changes; never replace accepted claims or clear unresolved rejections with an empty submission. Give the model current rejection IDs and reasons. Preserve packet-level stop reasons separately from rolling diagnostics. Stop extraction without a paid logbook request when its limits are reached, while retaining source validation and global spending bounds.

Current mandatory tool requirements must accompany saved prompts at execution time without erasing custom scientific instructions.

**Why:** Explicit reruns retain old prompts, which can predate stricter evidence contracts. Changing only the default prompt leaves retries inconsistent with the validator.

**How to apply:** Keep saved scientific instructions intact and append the current runtime requirements; make successful prompt traces describe the effective instructions used.

Routed context limits need an execution-specific policy, separate from advertised model capacity used by other workflows.

**Why:** A routed DeepSeek reproduction was rejected by DeepInfra at 32,768 tokens despite the advertised 64,000-token window. Changing global model metadata would also change literature-review reading capacity. Retrying the whole reproduction would repeat paid experiments instead of repairing the rejected language-model request.

**How to apply:** Treat upstream limits as serving constraints, preserve source evidence independently of presentation context, and test recovery inside the same run. Keep paid GPU verification separate from mocked provider/sandbox replays.

Generated “protected” context is still disposable presentation, not immutable scientific truth. Only fixed instructions are irreducible; omitted generated content needs a working retrieval path.

**Why:** A later run failed locally even after provider budgeting was added: the most recent draft, repair continuation, and full claim-state projection could remain larger than the entire input allowance. Command-output retrieval alone could not recover omitted rejected submissions or logbook details.

**How to apply:** Cover long latest drafts and verbose multi-claim repair state with the real prompts and orchestration, not only small fitting fixtures. Preserve full scientific values separately, reserve runtime retrieval headroom before paid startup, and resize page payloads with truthful source offsets rather than slicing their serialized wrappers. Retrieval must not count as new scientific progress.

Malformed-call recovery must not guess the model's intended claim or scientific values, even when only one pending claim exists.

**Why:** A stalled production attempt had working materials and GPU access but repeatedly registered the same pending claim and submitted incomplete arguments. The available trace did not establish the root cause; inferring missing arguments would conceal the failure and could execute the wrong experiment.

**How to apply:** Return exact field corrections alongside accepted claim state, reject ambiguous or truncated calls before execution, and preserve completion/validation distinctions in bounded private diagnostics. Keep these diagnostics separate from publishable reports and general HTTP response logs.

Archive verbose recovery history, but always retain a small, self-contained next-action projection alongside accepted state.

**Why:** Real runs repeatedly browsed material and retrieved archived recovery instructions, then echoed archive notices instead of executing experiments. Keeping the entire latest repair immutable previously overflowed context; replacing it entirely with a pointer removed the immediate instruction. Neither extreme is reliable.

**How to apply:** Budget the active projection within existing runtime headroom, preserve it through compaction and provider-limit reductions, and let forced-final STOP override it. Test actual outgoing requests and full orchestration recovery, not only validators. Browsing and retrieval must not reset no-progress recovery. A shell command may only inspect material; its existence alone does not prove a scientific experiment or justify a verdict. Report preparation may still retrieve archived evidence without rerunning experiments.

Ground claims before accepting pending state, not only when validating final execution evidence.

**Why:** A live agent registered generic metrics without demonstrating their origin in the paper, then tried a guessed training-script path and repeatedly asserted missing materials. Validating final output alone left unsupported claims treated as authoritative during recovery.

**How to apply:** Require canonical-paper quotations backed by an actual source read and preserve the claim, original value, and provenance across repairs. Use the returned page range instead of requiring model-calculated quote offsets. Missing-material conclusions also need a source-backed requirement and inspection of supplied inventory/instructions; an absent guessed filename is not enough.

A verified quantitative Results passage does not by itself cause a model to register a claim; give the model a bounded next-action handoff tied to the original numbered read and page range.

**Why:** An observed run had a concrete Results passage, but kept browsing, tried an invalid archive ref and stopped at the repeated-read guard with no accepted claims. Earlier diagnostics were truncated, so do not infer a specific provider defect.

**How to apply:** Keep the instruction separate from canonical source/evidence, never prefill scientific values, and maintain strict validator ownership. Test both the registration and honest early-failure paths with mocked tool/model responses; a provider's tool-call-looking final text is not an executed tool call.

Distinguish provider-reported context constraints from local retry targets and output-generation caps.

**Why:** Repeated fractional reductions created a local target below the immutable instructions even though diagnostics still displayed a larger context window. Treating an ambiguous output-cap field as an input limit can produce the same failure.

**How to apply:** Use explicit total/input limits and provider token counts when available, keep unknown-limit retries bounded, and account for the protected request floor without overriding genuine provider limits. Preserve only numeric/allowlisted error metadata, never raw provider bodies. Keep source-grounding/schema additions within default-prompt preflight headroom.

Even a small retrieval feature can exceed the default small-window preflight allowance if its schema descriptions and runtime guidance repeat themselves. A targeted-read change triggered this before sandbox startup in recovery replays.

**Why:** Fixed instructions and schemas consume the headroom reserved for evidence; adding explanatory prose can make an otherwise valid tool unusable before the experiment begins.

**How to apply:** Keep descriptions concise and test default-prompt preflight plus full recovery replays when extending tools. Do not weaken context safety limits to fit redundant guidance.

Source-reading progress must be measured against the page actually visible to the model, not the full underlying file response.

**Why:** The tool loop can shorten a large response in the middle before the model sees it. Counting the declared original range as delivered falsely directs the agent past unread text, while the original full result can remain separately available for evidence validation.

**How to apply:** When adding browsing-loop detection or retrieval guidance, track the contiguous displayed prefix and preserve original source/evidence IDs independently. Compare visible content as well as paths/ranges: experiment outputs and directory listings can change at the same path. Let changed content, fresh offsets, and accepted claim changes reset browsing-stall detection, but not identical listings or cached-output retrievals.

Continuation instructions must distinguish source-file coordinates from stored-output coordinates and defer to the displayed retrieval page after context resizing.

**Why:** Stored-output wrappers shift offsets relative to the source, and request fitting may shorten a retrieved page again. Repeating the pre-fit end in active guidance can skip unseen text. Protecting all source pages as irreducible retrievals also exhausted the smaller serving window during mocked recovery.

**How to apply:** Bound complete source envelopes including metadata, keep original evidence separate, and retain compact navigation rather than making source history immutable. Leave structured retrieval envelopes intact for resizing; follow the displayed page's continuation offset.

After claim acceptance, preparation/execution guidance must dominate paging hints and carry bounded authoritative claim context.

**Why:** A later diagnostic showed accepted pending state but no execution: the agent repeatedly retrieved its claim and inventory. Paging advice still competed with execution advice; the truncated trace establishes the failure pattern, not a sole provider root cause.

**How to apply:** Keep evidence retrieval available without making it the primary task. Bind browsing recovery to the original pending identity, not aggregate completion counts; charge a bounded recovery allowance only after an outgoing request can deliver its instructions. Test multi-call batches, unrelated claim completion, strict expiry, and qP gates with mocked orchestration.

Separate recovery preparation, bounded analysis, and reserved finalization rather than requiring a complete scientific outcome within a single short allowance.

**Why:** A subsequent real trace reached command execution and prediction-data inspection, but the short allowance blocked its next command before recording. Execution is an opportunity to analyze, not proof of independent reproduction: a command can merely print shipped CSVs.

**How to apply:** Never renew analysis for each command or retrieval. Preserve time for evidence retrieval and record repair after experiments close, keep overall budgets authoritative, and leave unsupported claims unresolved rather than inventing a blocker or verdict.

Treat historical scripted replay tests as a baseline, not evidence of real-model workflow reliability.

Keep a bounded required-tool correction separate from earlier general premature-stop reminders.

**Why:** A provider can return ordinary prose despite explicit function tool choice. A general reminder consumed during browsing must not eliminate the first opportunity to correct a missing required stage transition.

**How to apply:** Permit one correction per required tool in a stage loop, without renewing it on browsing. Preserve deadlines, spending and tool limits, evidence validation, and unresolved status if the model still omits the call. An offline replay verifies recovery mechanics, not live-model completion reliability.

**Why:** Successive instruction and recovery fixes passed prescribed-turn mocks while live runs stalled at different workflow transitions. A successful scripted path only establishes that the application permits that sequence. Even successful assessment-to-plan revision returned to source inspection without an experiment; moving the failure to another stage is not end-to-end progress.

**How to apply:** Keep application-owned phase contracts and bookkeeping separate from scientific model decisions. Require explicitly approved repeated real-model compatibility measurements before describing operational reliability; GPU validation is a further, separate expense. Metadata-only checkpoints cannot justify claims of full evidence restoration or safe automatic command replay after interruption.

Stage-specific context protection must extend the session's protection contract, and recent completed tool batches need protection independently of older retrievals.

**Why:** Offline diagnosis reproduced a fresh command measurement disappearing entirely from the fitted request while older retrieval evidence survived. Replacing nested protection settings also dropped archiving and silently selected legacy retrieval compaction. The saved live trace omitted full outgoing requests, so this establishes a concrete defect, not a proven sole cause of the live stall.

**How to apply:** Preserve the newest batch and its paired declarations; regenerate oversized outputs as genuine numbered evidence pages. Keep the hard context bound and fail explicitly if evidence cannot safely fit. Preserve session archive callbacks when overriding stage state/instructions, and test request fitting rather than only scripted stage transitions.

Protecting a batch requires resizing every protected retrieval sibling, not just the most recent one.

**Why:** The next live run requested two evidence pages together. Both were correctly protected, but only the last was resized, creating a false irreducible-context failure.

**How to apply:** Apply bounded page regeneration across the complete protected batch using each page's canonical arguments and source offsets. Include multi-page, nonzero-offset and multibyte text cases in context-fitting tests.

Distinguish unknown routed-model limits from verified exact-model catalogue metadata.

**Why:** The selected OpenRouter model advertised a million-token window, but every reproduction stage still began at the unknown-route 32K limit. Compaction repeatedly removed inspected code before execution. This was a concrete context mismatch, not proof of the sole cause of stalled scientific execution.

**How to apply:** Resolve exact-model metadata on the normal server reproduction path, preserve conservative fallback with a visible notice when unavailable, and let provider-reported smaller limits tighten each request budget. Metadata must not come from untrusted config fields; paid-run spending caps remain independent of available context.

Reject incompatible planned-script launch formats and direct launches of unplanned material scripts before paying to execute them, rather than discovering the mismatch only when recording evidence.

**Why:** A live baseline was launched through `cd ... && python ... | tee ...`; the pipeline exit status could belong to tee, so the strict standalone-source evidence check correctly refused it. Repeated attempts to record that output cannot repair its provenance. Another live run dispatched a different material script than its accepted plan, spent fifteen minutes on it, and exhausted the global allowance without completing the report.

**How to apply:** Keep the standalone evidence check strict. Align the execution instructions and pre-dispatch guard with it, offer an explicit working directory for P instead of shell chaining, and preserve qP's sealed-snapshot working directory. A different material experiment requires a plan revision, not just rejection of its output afterward. Keep ordinary setup and evidence retrieval available. A terminated wrapper reporting zero is not a certified successful experiment.

Persist local spending-stop reasons before passing through provider SDK error handling.

**Why:** A live run ended before its next request was recorded, but the surfaced error told the user to check their provider key. Generic provider-error sanitization can hide locally thrown budget errors, so that wording alone cannot establish a credential problem or prove which guard fired.

**How to apply:** Record the local cap decision independently before dispatch, keep ordinary provider failures distinct, and never retroactively assert a precise stop cause from a generic historical error.

Validate execution provenance and numerical evidence against the same successful execution, and carry exact authorization contracts across fresh stage transcripts.

**Why:** Independent checks can accidentally join a failed planned script with successful CSV-display evidence. Likewise, a summary suitable for judging can omit the exact adaptation paths and instructions needed for execution.

**How to apply:** Test mixed failed/successful evidence, not only individually invalid calls. Test qP stage handoffs with arbitrary authorized changes recovered exclusively from the application packet, never supplied to the execution mock through fixture state.

Keep assessment repair fields available without reopening extraction-owned source identity.

**Why:** Missing-material validation can demand a material label that extraction did not supply. Hiding that assessment field makes a legitimate correction impossible. Separately, repeated bookkeeping-file failures have been misclassified as missing scientific material.

**How to apply:** Allow a required-material label to be supplied against the immutable verified source quote and inspected inventory. Do not relax grounding or fabricate labels for runtime files. Refusals should distinguish repairable execution failures and point to plan revision instead of encouraging repeated blocker submissions.

Repeated unsupported missing-material submissions need a controller-owned transition, not only stronger refusal prose.

**Why:** A successful live baseline recovery requested a revision and inspected the bookkeeping dependency; a subsequent run never requested revision and spent its assessment allowance resubmitting the same invalid blocker. Merely having a recovery tool available was insufficient.

**How to apply:** After two consecutive missing-material validation rejections within assessment, restrict the next action to a bounded plan revision. Preserve scientific validation, immutable qP authorization, revision limits, and global budgets. Never infer repair content or auto-create missing data. Test both a justified repair sequence and refusal to follow the transition; the latter must remain unresolved without a new execution.

Pre-dispatch refusals must never supersede the last actual execution for recovery checks.

**Why:** A retry guard's own refusal can hide the original traceback when stored under the same command tool name. Checking only the newest command record then lets the next unchanged retry through.

**How to apply:** Distinguish tool invocation from actual execution when selecting failure history. Test repeated refusals, not just one, and scope source-repair evidence to the entrypoint being retried rather than unrelated scripts in its plan.

Preparation checks must not silently invent bookkeeping files or classify scientific inputs by filename.

**Why:** The shipped baseline performs a read-modify-write of confidence history after GPU computation; a missing file wastes that computation. Isolating its exact function established that an object works and a list does not, but that does not establish a universal schema or permission to initialize other inputs.

**How to apply:** Use narrowly recognized source patterns to require inspection before dispatch, preserve qP authorization, and leave initialization or source repair evidence-backed and explicit. Test the extracted shipped function with standard-library dependencies in a temporary directory, never by importing its model-loading entrypoint. This is preparation validation, not scientific reproduction or proof of complete dependency coverage.

Exact-copy extraction should be explicit rather than silently repairing a model's paraphrase.

**Why:** A live run followed the structured tool contract but spent its repair allowance reconciling separately transcribed claims, quotes and optional numerical metadata. Stable rejection IDs helped repair some candidates but did not prevent new transcription errors.

**How to apply:** Let the model explicitly select a verbatim quote as the claim, while retaining literal source matching, size bounds, rejection identities and conflicting-value refusal. Do not silently normalize Markdown or punctuation, infer numerical metadata, or interpret successful extraction as scientific reproduction.

Extraction's bounded global allowance should support productive continuation rather than strand spare calls behind fixed per-packet quotas.

**Why:** After quotation errors disappeared, a live packet still honestly reported more claims at its local limit while the global extraction allowance had eight unused calls. The whole run stopped before experiments despite five completed packets.

**How to apply:** Reserve visits to unprocessed packets and retain the global cap. Count consecutive invalid or non-progressing submissions separately from productive batches; otherwise a first late error gets no repair opportunity. Validated progress resets the stall counter, never the global allowance. Never mark a packet complete while it reports remaining claims.

Required-tool requests may return no tool calls even when the provider accepts forced tool choice.

**Why:** A live extraction packet returned output-length exhaustion followed by an empty stop; treating forced choice as a guarantee stranded an otherwise mostly extracted paper before GPU allocation.

**How to apply:** Use small-batch correction guidance with a hard missing-call retry ceiling independent of the tool-call count. Keep failures unresolved after the ceiling, preserve packet coverage and validation, and do not assume an empty response means no claims remain. Do not increase general-stage retries merely because extraction needs this recovery.

Increasing this ceiling alone did not resolve repeated live failures on the same packet, even with small-batch guidance. If this recurs, investigate packet-specific input and response handling rather than assume another reminder fixes the cause; passing mocked recovery tests establishes control flow, not model compliance.

Offline comparison found that the archived packet also succeeded in earlier runs, verified against source-envelope hashes. A missing response excerpt does not prove an empty raw provider response: structural fields and reasoning-presence indicators were not retained. Diagnose with allowlisted metadata rather than logging raw reasoning or assuming deterministic bad source content. Failed-packet offsets alone do not prove its text is unchanged.

Structural diagnostics should report unknown usage as unknown, not zero, and identify whether they describe pre- or post-adapter responses.

**Why:** The repeated missing-call failures could not be explained from excerpts alone. Retaining entire provider responses would expose reasoning and potentially sensitive payloads without being necessary to distinguish structural failure modes.

**How to apply:** Keep counts, presence flags and enumerated types allowlisted at collection as well as generation. Do not infer a provider-side cause from normalized metadata or compensate for missing evidence by raising retry ceilings. Test absent and malformed response shapes without paid calls.

Reasoning presence does not mean all missing output or all billed completion tokens are reasoning.

**Why:** Instrumented live responses reported null content and absent tool calls, with reasoning metadata present but reasoning token counts much smaller than total completion counts. This occurred on multiple packets, not just the originally suspected passage.

**How to apply:** Distinguish response-contract failures from schema/quotation rejections. Report measured token categories without inventing what unavailable output contained; investigate provider compatibility and request contracts before another identical retry.

OpenRouter tool contracts should fail on unsupported routing rather than silently degrade; advertised tool support is not a guarantee of valid model output.

**Why:** Official routing documentation allows unsupported parameters to be ignored under default routing, while instrumented reproduction attempts received no usable tool calls despite forced tool choice. This is a compatibility risk, not proof of the failure's root cause.

**How to apply:** Preserve the exact requested model, billing mode and provider preferences when requiring parameter support. Do not add silent alternate-model or relaxed-parameter fallbacks. Keep the schema's claim-or-explicit-copy requirement aligned with local validation; retain independent canonical source checks.

Live testing with required parameter-compatible routing still produced missing tool output, despite valid submissions elsewhere. Do not treat this flag or a stricter submission schema as a demonstrated cure for absent calls. They address distinct contract risks; absent output needs independent diagnosis.

New command output must not replenish execution browsing merely because it differs from previous output.

**Why:** The index-enabled live run reduced identical reads but still exhausted its global limit while fresh grep output repeatedly renewed navigation. Text novelty is not scientific progress.

**How to apply:** Keep browsing bounded across commands without classifying shell syntax as scientific execution. Explicit successful writes may reopen repair inspection; phase changes provide fresh stage allowances. Existing-script registration should recommend a small inspection of the generated path rather than full source retranscription; registration never overrides plan or qP checks.

Cross-stage navigation indexes describe captured evidence, never the current filesystem or proven measurement coverage.

**Why:** Repeated source inspection consumed most post-extraction calls in a live run. Reducing those repeats is useful, but a page hash cannot detect subsequent command-side mutations, and planned measurements are not observed results.

**How to apply:** Retain original retrieval identities, distinguish changed captures, bound navigation size and keep fresh reads available. Experiment handoffs aid discovery only: scientific suitability, qP authorization, explicit reuse and per-claim verdict checks remain mandatory.