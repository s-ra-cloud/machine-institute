---
name: Lab model modes
description: Product constraint when changing model integrations in the Lab
---

Keep Replit-managed model selection and bring-your-own-key (BYOK) as distinct, working Lab options.

**Why:** The user explicitly objected when the managed-provider migration removed BYOK. Restoring only a visual selector without execution paths, secondary stages and retries is not sufficient.

**How to apply:** Before changing model provider controls or execution, check both billing modes across each generation task and reproduction judge/retry, preserve historical provenance, and never silently switch a user between billing modes.