---
name: Future Science publishing paths
description: How Machine Institute submits to Future Science, the two distinct endpoints, and why LR publishing failed.
---

# Future Science submission architecture

There are TWO distinct ways the app publishes to Future Science, and they are NOT interchangeable:

- **Editorials** → `POST {FS_API_BASE}/contributions` with a per-user **Bearer OAuth access token**, JSON body, `language: "English"`, `status: "unrevised_manuscript"`. This path publishes reliably.
- **Literature reviews / peer reviews / ethics reports** → `POST {FS_API_BASE}/contributions/api-bots` with the **`x-api-key` header** (env `FUTURE_SCIENCE_API_KEY`) and **multipart FormData** (`data` JSON part + `file` markdown blob), `language: "en"`. The api-bots endpoint works (peer/ethics publish through it).

## FS valid contribution `type` strings (exact, authoritative)
Article, Book, Book chapter, Conference paper, Podcast, Peer-review, Response to a contribution, Response to a review, Accepted paper, Rejected paper, Retracted paper, Literature review, Revised manuscript, Unreviewed manuscript, Other.
FS rejects any other string with a 4xx. **"Audit" and "Review" are NOT accepted** (an earlier note wrongly listed "Audit" as valid) — they leaked into the ethics/LR fallback arrays and caused silent rejections (ethics reports were rejected on the first attempt as "Audit" then downgraded to "Unreviewed manuscript"; LR sent "Review" on a retry). All fallback arrays are now a subset of the list above, codified in `FS_ACCEPTED_CONTRIBUTION_TYPES` and guarded by `server/__tests__/fs-contribution-types.test.ts`. Ethics single-paper audits publish as "Response to a contribution" (with linkOriginalContribution); aggregate field ethics reports lead with "Peer-review". linkOriginalContribution + revision arrays are only valid for "Response to a contribution" and "Peer-review".

## Why LR publishing was a mystery to debug
- **Why:** deployment logs are dominated by huge cached `/api/research/events` GET-response JSON dumps, so the actual FS submission error line is effectively unretrievable via `fetch_deployment_logs`.
- **How to apply:** the LR submit now THROWS an Error carrying the real FS response body (instead of returning null with a generic message), so the true rejection reason reaches the user event and clean dev logs. If a submit path silently "returns null on failure", make it surface the FS response body before assuming a cause.
- Don't assume the `type` string is the culprit without evidence — "Literature review" is valid; an earlier guess that it was invalid was wrong.

## "Failed to upload media to Strapi" (500) = FS-side outage, not our bug
- A `500 {"error":"Failed to upload media to Strapi"}` from the api-bots endpoint is Future Science's **Strapi media/file storage step failing**. It is **type-, format-, size-, and content-independent** — verified by reproducing with md/txt/html, multiple `type` strings (incl. the valid `Peer-review`), and a 30-byte probe: ALL returned the identical 500. (NB: `Audit` was tried in that probe too but is itself an invalid type — see above — so it wasn't a clean known-good control.)
- **How to apply:** when every submission (even a tiny probe) fails this way while peer/ethics previously published fine, treat it as a transient FS outage — do NOT chase it in our code. Reproduce from workspace bash with a small node script (sandbox `process.env`/secrets are masked; bash has the real `FUTURE_SCIENCE_API_KEY`). The LR submit maps this specific error to a friendly "temporarily unavailable, try again shortly" message.

## Retry without regenerating
Admin/auth republish endpoints exist and re-run the stored submission: `POST /api/literature-reviews/:id/republish`, `POST /api/peer-reviews/:id/republish`, `POST /api/ethics-reports/:id/republish`. Use these to retry stuck records instead of spending a rate-limited generation.
