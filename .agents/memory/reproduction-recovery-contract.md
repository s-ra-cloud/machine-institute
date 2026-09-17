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