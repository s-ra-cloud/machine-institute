---
name: Questioning execution provenance
description: Why qP uses a stricter execution interface than P
---

Keep qP's execution authorization separate from P's scientific methodology. Do not relax assessment gating by classifying arbitrary shell text as setup.

**Why:** Shell text can hide scientific execution or unrecorded edits. Adaptation provenance must describe the source actually launched, not merely a prior working-copy snapshot. A successful adapted experiment does not establish the original paper's result.

**How to apply:** Extend explicit setup operations or supported versioned entrypoints when needed; preserve evidence-grounded assessment and recorded changes before execution. Any expansion of executable commands needs bypass tests and provenance checks, without changing historical P behavior.

Treat immutable entrypoints alone as insufficient isolation.

**Why:** Writable dependency directories can inject sitecustomize or imported helpers after source snapshots are recorded. Dropping the process UID does not remove inherited environment credentials, parent-process visibility, or network exfiltration.

**How to apply:** Keep qP provisioning secret-free, dependency/runtime manifests immutable, and execution environments explicitly allowlisted. Preserve filesystem/process/network isolation and real adversarial subprocess tests; fail closed when the sandbox cannot provide the isolation boundary.

Budget provenance across the entire run, not only each tool response.

**Why:** Repeating an unchanged material corpus in every execution snapshot multiplies permitted input size by the tool budget, then multiplies it again in reports and API responses. This can fail after expensive scientific execution.

**How to apply:** Deduplicate content by hash, preserve execution-version references, check escaped persisted byte size before accepting new content, and keep bulk evidence out of collection queries and report bodies. Test near-limit material size with repeated executions.