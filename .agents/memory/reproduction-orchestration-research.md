---
name: Reproduction orchestration research
description: External precedents and boundaries for applying them without replacing the website's Modal workflow.
---

Prefer application-owned execution/evidence references and explicit reuse over asking the model to reconstruct bookkeeping or automatically replay expensive commands.

**Why:** Research prompted by the user found useful precedents, but none is a demonstrated drop-in solution for this website. PaperBench separates rollout, execution and grading and archives artifacts; SWE-agent records actions, observations and model queries; LangGraph distinguishes persistent graph checkpoints from stores. The AI Scientist uses prepared templates and baseline runs, not unrestricted reproduction of arbitrary papers, and its current repository advertises a custom source-code license.

**How to apply:** Borrow architectural patterns without replacing Modal or weakening independent judging. Explicitly distinguish reuse of an earlier experiment from a fresh replicate and from a claim verdict. Missing-file repair should inspect the required file or an authorized source repair before retrying, never fabricate scientific inputs. Metadata-only checkpoints are not resumable execution state. Do not claim installing an agent framework solves that gap.

References consulted:
- https://github.com/openai/frontier-evals/blob/main/project/paperbench/README.md
- https://github.com/SWE-agent/SWE-agent/blob/main/docs/usage/trajectories.md
- https://github.com/SakanaAI/AI-Scientist
- https://docs.langchain.com/oss/python/langgraph/persistence

No external project code was vendored in applying these patterns.
