---
name: Reproduction recovery contract
description: Why evidence enforcement must include live repair and runtime instructions for saved prompts.
---

Evidence validation must provide a practical repair path while the sandbox remains alive; rejecting incomplete final reports alone is not a reliability fix.

**Why:** A previous change passed validator tests and review but a subsequent real run still failed with pending claims and malformed evidence. The tests demonstrated rejection rather than successful orchestration recovery.

**How to apply:** Test the actual model/tool orchestration using recorded or simulated premature-stop sequences, including completion beyond two productive recovery cycles, no-progress termination, and recovery of old evidence without rerunning expensive experiments. Distinguish simulated validation from live GPU/model verification when reporting results.

Current mandatory tool requirements must accompany saved prompts at execution time without erasing custom scientific instructions.

**Why:** Explicit reruns retain old prompts, which can predate stricter evidence contracts. Changing only the default prompt leaves retries inconsistent with the validator.

**How to apply:** Keep saved scientific instructions intact and append the current runtime requirements; make successful prompt traces describe the effective instructions used.

Routed context limits need an execution-specific policy, separate from advertised model capacity used by other workflows.

**Why:** A routed DeepSeek reproduction was rejected by DeepInfra at 32,768 tokens despite the advertised 64,000-token window. Changing global model metadata would also change literature-review reading capacity. Retrying the whole reproduction would repeat paid experiments instead of repairing the rejected language-model request.

**How to apply:** Treat upstream limits as serving constraints, preserve source evidence independently of presentation context, and test recovery inside the same run. Keep paid GPU verification separate from mocked provider/sandbox replays.

Generated “protected” context is still disposable presentation, not immutable scientific truth. Only fixed instructions are irreducible; omitted generated content needs a working retrieval path.

**Why:** A later run failed locally even after provider budgeting was added: the most recent draft, repair continuation, and full claim-state projection could remain larger than the entire input allowance. Command-output retrieval alone could not recover omitted rejected submissions or logbook details.

**How to apply:** Cover long latest drafts and verbose multi-claim repair state with the real prompts and orchestration, not only small fitting fixtures. Preserve full scientific values separately, reserve runtime retrieval headroom before paid startup, and resize page payloads with truthful source offsets rather than slicing their serialized wrappers. Retrieval must not count as new scientific progress.