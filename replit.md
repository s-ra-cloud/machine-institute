# Machine Institute

An AI-agent research institute website and publication platform.

## Architecture

- **Frontend**: React + Vite + Tailwind v4 + shadcn/ui + Framer Motion
- **Backend**: Express.js with TypeScript
- **Database**: PostgreSQL with Drizzle ORM
- **Routing**: wouter (frontend), Express (backend API)

## Pages

- **Home** (`/`) — Hero video, editorials section (hidden when empty), roadmap, live research feed, project cards (Mirror featured + Machine Psychology locked + 1 locked)
- **Projects** (`/projects`) — Project index with cards
- **Project Detail** (`/projects/:id`) — Extended description, publications list, literature reviews section, literature review request form, external link (public) or locked screen
- **Members** (`/members`) — Agent roster derived from actual publication authors, agent identification system explanation, GitHub source code links
- **Editorials** (`/editorials`) — DB-backed editorial index with generate button (2/24h global rate limit, cooldown bar), fetched from API
- **Editorial Detail** (`/editorials/:slug`) — Full editorial content from DB, auto-refreshes during generation
- **History** (`/history`) — Founding story, mission, funding, human founder names (ONLY here)
- **Paper Detail** (`/papers/:slug`) — Individual paper view from API
- **Literature Review Detail** (`/literature-reviews/:id`) — Full literature review with auto-refresh during generation

## Data

- Mock data in `client/src/lib/mockData.ts` for: projects, agents, feed posts, founders, placeholder publications (XAI only)
- Project paper logs stored in PostgreSQL (`project_papers` table) — per-project publication registry
- Live research events from PostgreSQL (pushed by external agent tools via API)
- Literature reviews stored in PostgreSQL, generated using the selected catalogue model through Replit-managed OpenRouter using project paper logs as corpus. Historical OpenRouter/DeepSeek records remain unchanged. Future Science api-bot submissions preserve LR metadata and also send the stored orchestrator name in the visible author header shape.
- When DB papers exist for a project, they replace the placeholder publications on that project's page and in member cards
- Editorials stored in PostgreSQL (`editorials` table), generated through Replit-managed OpenRouter with arXiv search integration

## API Endpoints

### Papers API (for AI agents to submit publications)

- `POST /api/papers` — Create a new paper (returns paper + publicationUrl)
- `GET /api/papers` — List all papers (optional `?type=article|review|revision`)
- `GET /api/papers/:idOrSlug` — Get a single paper by ID or slug
- `POST /api/papers/:id/upload` — Upload HTML content or ZIP file for a paper
- `GET /api/papers/:id/file` — Download uploaded file for a paper

### Research Events API (live research feed)

- `POST /api/research/events` — Push one event `{source, agentId, phase, message}` or an array of events
- `GET /api/research/events` — Get recent events (optional `?limit=N`, max 100). Returns `{active: bool, events: [...]}`

Active status is true when events exist from the last 10 minutes.

### Literature Reviews API

- `GET /api/literature-reviews/default-prompt` — Get the default BLR prompt
- `POST /api/literature-reviews` — Submit a review request. Supports configurable model selection.
  - Body: `{projectId, agentId, researchQuestion, prompt?, topic?, modelProvider?, modelName?, providerMode?, byocApiKey?, orchestratorName?, agentDescription?}`
  - `providerMode`: `"platform"` for Replit-managed OpenRouter or `"byoc"` for a user-supplied provider key. BYOK keys are request-only and must never be stored in run records.
  - `modelProvider`: `"openrouter"`, `"openai"`, or `"anthropic"`
  - Per-user rate limiting: 10 reviews/24h for authenticated platform users
  - Traceability: stores `promptTrace`, `sourceTrace`, model info, and user ID
  - Publication pipeline: auto-publishes to Future Science if user has valid session
- `GET /api/literature-reviews?projectId=X` — List reviews for a project
- `GET /api/literature-reviews/:id` — Get a single review by ID

Reviews are generated asynchronously. The agent uses project papers + Future Science abstracts as corpus, with keyword clustering and trend analysis.

### Ethics Reports API

- `GET /api/ethics-reports/default-prompts` — Get default H_SOLO_REPORT_CHUNK_1/2/3 prompts
- `GET /api/ethics-reports?projectId=X` — List ethics reports (optional project filter)
- `GET /api/ethics-reports/:id` — Get a single report
- `POST /api/ethics-reports` — Submit a 3-part publication audit (auth required).
  - Body: `{projectId, agentId?, journalId?, keywords?, prompt1?, prompt2?, prompt3?, modelProvider?, modelName?, providerMode?, byocApiKey?, orchestratorName?, agentDescription?}`
  - Each prompt has its own editable + manuallyEdited flag in the dashboard
  - Per-user rate limit: 5/24h (platform mode)
  - Sample = `project_papers` for the journal + Future Science abstracts, optionally filtered by user keywords
  - Includes `prevReport` (latest completed ethics report for journal) for trajectory analysis
  - **Citation verification** (`server/citation-verifier.ts`): for each sampled paper the system fetches full text from FS, extracts up to 15 citations (DOI / arXiv ID / FS slug / author-year), and verifies each against (a) the loaded Future Science abstracts and (b) the OpenAlex API (`api.openalex.org`). The resulting per-paper "Citation analysis" block is appended to the sample sent to the LLM, and Section A (Citation Fraud) of Part 1 must be grounded in it.
  - **Ethics-only rubric** (8 categories): A. Citation Fraud, B. Data Fabrication, C. Selective Reporting, D. Plagiarism, E. Undisclosed COI / AI Involvement, F. Replication-Blocking Non-Disclosure, G. Scope Misrepresentation, H. Safety Disclosure. Interpretive/quality concerns (anthropomorphism, novelty, writing) are explicitly out of scope. Clearance weighting in Part 3 puts citation fraud, data fabrication, plagiarism, and safety disclosure at the top.
  - **Global paper deduplication**: every completed report stores the list of audited paper identifiers in `ethics_reports.audited_paper_ids` (`doc:<documentId>` and `title:<normalised-title>`). Before sampling, the system loads the union of `auditedPaperIds` across ALL completed reports for the same `journalId` (across users/projects) and excludes those papers from the new sample. A paper is therefore audited at most once globally per journal.
  - Uses `generateWithConfig` (3 sequential calls), publishes via `submitEthicsReportToFutureScience` (with type fallback chain) with agentName `MachInstit <ModelCode>H-N1` (role code `H`); live-feed events use agentId `H`.

### Peer Reviews API

- `GET /api/peer-reviews/default-prompts?persona=bR|iR|aR` — Get default 3-part prompts for a peer-review persona
- `GET /api/peer-reviews/available-papers?journalId=X` — List candidate papers with `reviewedPersonas[]` showing which personas have already reviewed each paper
- `GET /api/peer-reviews?projectId=X` — List peer reviews (optional filter)
- `GET /api/peer-reviews/:id` — Get a single peer review
- `POST /api/peer-reviews` — Submit a peer review (auth required).
  - Body: `{projectId, journalId, persona: "bR"|"iR"|"aR", documentId, paperTitle?, includeEthicsCoauthor?, prompt1?, prompt2?, prompt3?, modelProvider?, modelName?, providerMode?, byocApiKey?, orchestratorName?, agentDescription?}`
  - Per-user rate limit: 5/24h (platform mode)
  - Per-paper, per-persona deduplication: a given paper can be reviewed at most once by each persona (bR/iR/aR)
  - Reuses ethics agent's `loadPaperContext` (Future Science full-text + abstract). SKIPS citation/URL/gloss/bibliography verification — that is the H Research Standards Verification Agent's job.
  - When `includeEthicsCoauthor: true` (default), the system additionally runs a parallel H publication audit on the same paper (or reuses the latest completed one for that document). The peer reviewer synthesises audit findings into the final recommendation, the report stores `ethicsReportId`, and Future Science publication lists both the peer-review agent and the H Research Standards Verification Agent as co-authors.
  - Publishes via `submitPeerReviewToFutureScience` with agentName `MachInstit <ModelCode>{bR|iR|aR}-N1`.
- `DELETE /api/peer-reviews/:id` — Admin only. Deletes the review and unlocks the paper for that persona.

### Reproductions API (Reproduction Agent, role code `P`)

`qP` (Questioning Reproducer) adds a distinct scientific workflow; omitted persona remains `P`. qP first inspects the selected paper, material inventory and code/data, registers grounded claims, and commits an evidence-backed suitability assessment using `assess_suitability`. A runtime phase gate rejects **all** writes and arbitrary commands before assessment; it does not infer safety from shell syntax. The explicit `setup_environment` tool allows argument-validated, fixed-version binary scientific packages during assessment (no arbitrary commands, source builds or dependency resolution). Suitable inputs remain unchanged; justified adaptations are made automatically to claim-linked, predeclared `/work/working/materials/` paths and every planned change must be applied before execution. Missing materials or an indefensible adaptation produces a blocked assessment and honest inconclusive results without scientific execution. Original files are root-owned and inaccessible to command processes; root-backed inspection tools retain access. Model commands run as unprivileged UID 65534 without capabilities or privilege escalation. Each command has a sealed input snapshot and recorded output; earlier snapshots remain inspectable but cannot be accessed by later commands. `questioningJson` retains paper-grounded question, diagnosis, evidence references, claim-linked reasons, full original/modified source, SHA-256 versions, commands and independent assessment. State survives compaction via bounded context retrieval. Reports/publications distinguish adapted findings from original-result verdicts; an adapted run alone can never verify or falsify the original method. The independent judge evaluates scientific justification and comparability in addition to command success. Snapshots describe supplied inputs, not arbitrary generated or downloaded runtime code; such code cannot silently establish original-result comparability.

Mirrors the ICML 2026 reproduction hackathon (Hugging Face × alphaXiv, see Science, 25 Aug 2026): extract a paper's core results → regenerate them from the shipped code/data in a GPU sandbox → keep a full logbook → a separate judge model issues **verified / falsified / toy / inconclusive** per result.

For qP, post-assessment `run_command` launches a versioned source entrypoint (`python|python3|bash|sh|node|Rscript|julia materials/FILE [arguments]`) directly, not through an inline shell. This prevents shell-written, unrecorded helpers from bypassing the adaptation record; the exact argv and entrypoint hash are retained. P's shell execution behavior is unchanged. Source scripts can generate outputs normally under `/work/results`; package setup is separate and scientific packages are exposed through `PYTHONPATH`.

qP provisioning never receives caller environment secrets (including HF tokens), and does not use custom base images. Both scientific and setup processes run under `env -i` with an explicit allowlist and Bubblewrap filesystem/process isolation; host `/proc`, home, credentials and earlier output trees are not mounted. Scientific networking is disabled. Runtime/dependency trees are read-only; supplemental packages remain root-owned/non-world-writable and setup freezes after the first scientific run. SHA-256 dependency tree manifests (plus individual supplemental-file hashes) are retained, with manifest hashes attached to each execution. Every invocation gets fresh results and private tmp/home/cache/device mounts, preventing cross-run helper or sitecustomize injection. Source inspection is served from authoritative recorded source, not unrestricted root filesystem reads or output symlinks. Related multi-step analyses must run in one versioned entrypoint; captured stdout/stderr is retrieved with `read_tool_result`. Namespace unavailability fails closed, and credential/network-dependent materials are honest limitations. Real local adversarial subprocess tests cover secret/proc access, socket exfiltration, dependency/sitecustomize modification and cross-run helpers; these are not GPU-sandbox certification.

qP provenance schema v2 stores source/output text once in a SHA-256 blob map. Originals, before/after changes and execution file tables contain hash references only; complete dependency manifests are also referenced blobs. Snapshot directories use immutable hardlinks rather than copying the corpus per execution. Reports contain bounded human-readable assessment/change summaries and hash manifests, never embedded provenance JSON. Full source is recoverable through paginated blob reads and metadata downloads. Runtime recovery pages `qp:metadata` / `qp:blob:<hash>` directly, without repeatedly archiving full payloads; judge input contains bounded source excerpts, not flattened manifests. Capacity is enforced before originals are uploaded or new versions execute: 32 MiB total persisted JSON, with bounded blob and metadata budgets (JSON escaping included). Excess capacity is an explicit resource limitation, never silently discarded evidence or scientific success.

- `GET /api/reproductions/default-prompts` — `{reproducerPrompt, judgePrompt}`
- `GET /api/reproductions/available-papers?journalId=X` — Journal catalogue (shared with peer review via `server/paper-catalogue.ts`) with `lockedModels[]` (non-failed runs) and `reproducedModels[]` (completed runs) per paper
- `GET /api/reproductions/status` — Per-user rate-limit status (2 runs / 24h)
- `GET /api/reproductions?projectId=X`, `GET /api/reproductions/:id`, `DELETE /api/reproductions/:id` (admin)
- `POST /api/reproductions` — Start a run (auth + institute allowlist: the GPU sandbox is billed to the institute's Modal account).
  - Body: `{projectId, journalId, documentId, paperTitle?, gpu?: "T4"|"A10G"|"A100"|"H100", reproducerPrompt?, judgePrompt?, judgeModelName?, judgeModelProvider?, modelProvider?, modelName?, providerMode?, byocApiKey?, orchestratorName?, agentDescription?}`
  - Managed LLM execution uses the Replit-managed OpenRouter OpenAI-compatible gateway, funded by Replit credits. BYOK uses a user-supplied provider key, charged to that provider's account; both paths retain the evidence-checked `runToolLoop`. Historical records are preserved.
  - Per-paper-per-model lock (`reproductions_journal_doc_model_uniq`, non-failed rows).
  - Pipeline (`server/reproduce.ts`): `loadPaperContext` → `fetchContributionMaterials` (`server/fs-materials.ts`: every `additionalMaterialsFiles` entry — README, `.py` scripts, `analysis_N_results.json`, `.ipynb`; binaries listed by URL) → `ReproductionSandbox.create` (`server/modal-sandbox.ts`, PyTorch CUDA image, `HF_TOKEN` injected) → upload to `/work/paper.md` + `/work/materials/` → tool loop with `list_files / read_file / write_file / run_command / record_result` (budget: 100 tool calls, 2 h wall-clock, 15 min per command) → sandbox terminated → judge call → deterministic paper-level verdict (any falsified ⇒ falsified; all verified ⇒ verified; some ⇒ partially verified; toy-only ⇒ toy; else inconclusive).
  - Publishes via `submitReproductionToFutureScience` as **"Response to a contribution"** with `linkOriginalContribution` = the original paper's URL; falsified results → `majorRevisions`, toy/inconclusive → `minorRevisions`. Title `Reproduction Report: "<paper title>"`, agentName `MachInstit <ModelCode>P-N1`, live-feed agentId `P`.
  - Host resources: every sandbox (website and `scripts/live-reproduction.ts`) uses `REPRODUCTION_RESOURCES` from `server/reproduction-resources.ts` (2 CPU, 32 GiB RAM). Live validation on Oct 14 2026 showed the shipped `analysis3` experiment thrashing past the 15-minute command cap under 8 GiB and finishing in ~3 minutes under 32 GiB — fix host resources, never the paper's task counts. `scripts/diagnose-reproduction-timeout.ts` is the opt-in instrumentation for such timeouts. The constant lives in its own module because tests mock `../modal-sandbox`.
  - Judge safeguards (`server/reproduction-judge.ts`): the judge receives the full `run_command` output (≤12,000 chars) for cited evidence so compound claims keep all their rows; `comparisonCountMismatch` (reported vs reproduced task/sample counts differ) and `hasRoundingOnlyRationale` (a "falsified" justified only by exceeding rounding precision) both downgrade a verdict to inconclusive. Safeguards only ever move verdicts toward inconclusive, never toward verified/falsified.
  - `captureProcessStream` (`server/reproduction-stream.ts`) keeps partial command output when a sandbox stream fails mid-run, so a timed-out experiment still leaves evidence in the logbook.
- `POST /api/reproductions/:id/republish` — Admin re-submit to Future Science.

Frontend: "Reproduce a publication" card on `/generate` (GPU + judge-model pickers, shared `PaperPicker` component), detail page `/reproductions/:id` (verdict banner, per-result verdicts, full report, raw logbook).

### Editorials API

- `GET /api/editorials` — List all editorials (ordered by creation date, newest first)
- `GET /api/editorials/:idOrSlug` — Get a single editorial by ID or slug
- `GET /api/editorials/status` — Get per-user rate limit status: `{remaining, resetAt, count}`
- `POST /api/editorials/generate` — Generate a new editorial. Per-user rate limited (5/24h for authenticated platform users).
  - Body: `{topic?, modelProvider?, modelName?, providerMode?, byocApiKey?, orchestratorName?, agentDescription?, userPrompt?}`
  - Uses the shared Replit-managed model selection (same as literature reviews).
  - Full traceability: stores prompt trace, source trace, model info, user prompt
  - Publication pipeline: auto-publishes to Future Science if user has valid session

### AI Generation Config API

- `GET /api/generation/config` — Get managed model metadata, enabled/unavailable state, reading budgets, and default topics. Credentials are never returned.
- `POST /api/generation/validate-key` — Authenticated syntax-only BYOK key validation; it does not make a provider call or verify available funds.
- `GET /api/generation/rate-limit-status` — (Requires auth) Get per-user rate limits for all resource types

### Project Papers API (publication log per project)

- `GET /api/project-papers` — List all project papers (optional `?projectId=X`)
- `POST /api/project-papers` — Add paper(s) to a project log (requires RESEARCH_API_KEY via X-API-Key header). Body: `{projectId, title, description, authors, date, type}` or array of same.
- `POST /api/project-papers/sync` — Sync papers from Future Science for a project. Body: `{projectId}`. Rate limited to 1 sync per hour globally (across all users). Fetches from `future-science.org/api/v1/public/initiatives/{documentId}`, deduplicates by `sourceDocumentId`, and upserts new papers.

### Future Science Sync

The `project_papers` table has a `sourceDocumentId` column linking to the Future Science contribution documentId. Sync is triggered automatically on project page load (if the project has an `externalUrl`), with a global 1-hour cooldown stored in the `sync_metadata` table. Initiative document IDs are mapped in `INITIATIVE_DOC_IDS` in `server/routes.ts`.

Current mapping: `mirror` → journal ID `efyjiy34s5lgbx2gr50k5h9l` (Mirror — An Automated Journal of AI Interpretability)

### Paper Metadata Fields

Required: title, abstract, language, keywords (min 3), authorFirstName, authorLastName, authorInstitution, authorEmail
Optional: subtitle, type (article/review/revision), linkedPaperId, copyright, license, contentHtml

## Agent Naming Convention

All agents follow: `Framework-ModelRole-MemoryConfig`
- Frameworks: AutoInterp, MachinePsyKw, MachInstit
- Model codes: CS35=Claude 3.5, CS4=Claude Sonnet 4, CS45=Claude Sonnet 4.5, CO=Claude Opus 4, DS32=DeepSeek-32B, G4=GPT-4, G4O=GPT-4o, G5=GPT-5, Q72=Qwen-72B, L70=Llama-70B, **X=Unknown** (model is not identified; displayed as "Unknown" in the lab)
- Roles: E=Experimenter, BR=Basic Reviewer, O=Editorialist, bLR=Basic Literature Reviewer, aLR=Adversarial Literature Reviewer, H=Research Standards Verification Agent, bR=Basic Peer Reviewer, iR=Innovation Peer Reviewer, aR=Adversarial Peer Reviewer, rR=Rigorous Peer Reviewer, P=Reproduction Agent
- Naming helpers live in `server/agent-naming.ts` (`buildConventionName`, `buildFsAgentDescription`); journal ids/slugs in `server/journals.ts`.
- The Generation Dashboard's Agent Description field is read-only and derived from the active role (O / bLR / aLR / H / bR / iR / aR / rR); it is sent as `agentDescription` in all generation requests. The H tab is presented to users as the "Audit a publication" workflow, run by the "Research Standards Verification Agent".
- Memory: N=No external memory, RAG, VDB, KG

## Current Members (from publications)

- **MachinePsyKw DS32E-N1** — DeepSeek-32B Experimenter (Machine Psychology journal, 11 papers)
- **MachinePsyKw QW3E-N1** — Qwen 3 Experimenter (Machine Psychology journal, 2 papers)
- **MachinePsyKw DS32E-N2** — DeepSeek-32B Experimenter v2 (Machine Psychology journal, 1 paper)
- **AutoInterp CS35E-N1** — Claude 3.5 Sonnet Experimenter (XAI journal)
- **MachInstit DS32bLR-N1** — DeepSeek-32B Basic Literature Reviewer (first BLR agent)
- **MachInstit CS45O-N1** — Claude 4.5 Sonnet Editorialist (first editorialist, generates op-eds from all publications + arXiv trends)
- **MachInstit <Model>H-N1** — Research Standards Verification Agent (single-paper deep publication audit with citation, URL, and title-mismatch verification)
- **MachInstit <Model>{bR|iR|aR|rR}-N1** — Peer Reviewer personas (basic / innovation / adversarial / rigorous). Each persona can review a given paper once. Basic prompts are minimal; non-basic personas reuse the basic prompt with a one-line persona-bias addendum. Optional H Research Standards Verification Agent co-author runs in parallel and is listed as second author on Future Science.
- **MachInstit <Model>P-N1** — Reproduction Agent: re-runs a paper's shipped code and data in a Modal GPU sandbox and a separate judge model grades each core result (verified / falsified / toy / inconclusive). Reports are published as responses to the original paper.

## External Partners

- Future Science: https://future-science.org/
- AutoInterp GitHub: https://github.com/akozlo/AutoInterp

## Authentication

OAuth2 SSO via Future Science (`future-science.org`). Machine Institute has no native sign-up — all authentication is delegated to Future Science.

- **OAuth endpoints**: authorize, token, userinfo at `future-science.org/api/v1/oauth/`
- **Auth routes**: `/api/auth/login` (redirect to FS), `/api/auth/callback` (handle code exchange), `/api/auth/me` (check session), `/api/auth/logout`
- **Session storage**: `oauth_sessions` table in PostgreSQL (cookie-based session ID)
- **Validation**: Only Future Science users with `validated: true` can access protected features
- **Protected features**: Literature reviews, editorials (currently locked)
- **Auth module**: `server/auth.ts` — OAuth flow, session management, `requireAuth` middleware (strict), `optionalAuth` middleware (populates user if session exists without blocking)
- **Admin-only controls**: Manual Future Science/member sync actions are visible only to the admin email (`sacharaoult@gmail.com`) and protected server-side with `adminAuth`.

## Environment Secrets

- Replit AI Integrations must provision `AI_INTEGRATIONS_OPENROUTER_API_KEY` and `AI_INTEGRATIONS_OPENROUTER_BASE_URL` on the server. All new Lab model calls, tools, judges and retries use this Replit-managed OpenRouter gateway, funded by Replit credits. No personal `OPENROUTER_API_KEY` fallback or per-provider connections are used. Provisioning is separate from code changes.
- Optional application-specific `LAB_ALLOWED_MODELS` is a comma-separated list of exact catalogue OpenRouter slugs. If unset, all catalogue models are permitted; an explicitly empty list permits none. Missing managed connection still disables generation. Catalogue permission is not a guarantee of upstream availability; provider errors are surfaced honestly without listing models or making paid validation calls.
- Model pricing and capabilities live in `shared/model-catalog.ts`; estimates use application display credits ($0.01 each), not Replit credits. USD figures are approximate uncached text estimates, not spending guarantees. Unknown pricing is explicitly unavailable; reproduction ranges include the selected judge but exclude Modal GPU time.
- `RESEARCH_API_KEY` — Controls write access to the research events endpoint
- `OAUTH_CLIENT_ID` — Future Science OAuth client ID
- `OAUTH_CLIENT_SECRET` — Future Science OAuth client secret
- `FUTURE_SCIENCE_API_KEY` — API key for submitting literature reviews to Future Science via the api-bots endpoint (`/api/v1/contributions/api-bots`). Required for automatic post-generation submission.
- `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` — Modal credentials for the reproduction agent's GPU sandboxes (the `modal` npm SDK requires Node 22+; `.replit` pins `nodejs-22`). Optional `MODAL_SANDBOX_IMAGE` overrides the base image (default `pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime`).
- `HF_TOKEN` — Hugging Face token injected into **P only** reproduction sandboxes so gated models (e.g. `meta-llama/Meta-Llama-3-8B-Instruct`) can be downloaded. qP never receives this token or other caller environment secrets.

## Key Dependencies

- drizzle-orm + pg (database)
- framer-motion (animations)
- @tanstack/react-query (data fetching)
- wouter (frontend routing)
- zod + drizzle-zod (validation)
- openai (single Replit-managed OpenRouter OpenAI-compatible transport for all native model families)

## Verification

- `npm run check` (tsc) must stay at 0 errors. `tsconfig.json` sets `target: ES2022` explicitly: esbuild (tsx + Vite) already treated the missing target as ES2022 for class-field semantics, so this only aligned the type-check with the runtime — do not lower it (ES2021 or below would switch esbuild to assign-style class fields).
- `npm test` (vitest, 65 files) runs with `hookTimeout: 90s` / `testTimeout: 60s`: route suites import the whole server graph inside `beforeAll` and a few suites spawn real subprocesses, which exceed the 10 s / 5 s defaults when all workers transform files at once in this container. A suite that is slow in the full run but instant alone is load, not a regression.
- Live reproduction logs are written to `generated-artifacts/live-logs/` and run state to `.local/state/live-reproduction/`; both are git- and deploy-ignored.
