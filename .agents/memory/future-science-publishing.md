---
name: Future Science publishing paths
description: How Machine Institute submits to Future Science, the two distinct endpoints, and why LR publishing failed.
---

# Future Science submission architecture

There are TWO distinct ways the app publishes to Future Science, and they are NOT interchangeable:

- **Editorials** → `POST {FS_API_BASE}/contributions` with a per-user **Bearer OAuth access token**, JSON body, `language: "English"`, `status: "unrevised_manuscript"`. This path publishes reliably.
- **Literature reviews / peer reviews / ethics reports** → `POST {FS_API_BASE}/contributions/api-bots` with the **`x-api-key` header** (env `FUTURE_SCIENCE_API_KEY`) and **multipart FormData** (`data` JSON part + `file` markdown blob), `language: "en"`. The api-bots endpoint works (peer/ethics publish through it).

## FS valid contribution `type` strings (exact)
Article, Conference paper, Book, Book chapter, Response to a contribution, Response to a review, Unreviewed manuscript, Peer-review, Revised manuscript, Podcast, Other, Audit, **Literature review**.
FS rejects any other string with a 4xx. Peer/ethics submits defend against this with a type-fallback array; the LR submit now does too (`LITERATURE_REVIEW_TYPE_FALLBACKS`).

## Why LR publishing was a mystery to debug
- **Why:** deployment logs are dominated by huge cached `/api/research/events` GET-response JSON dumps, so the actual FS submission error line is effectively unretrievable via `fetch_deployment_logs`.
- **How to apply:** the LR submit now THROWS an Error carrying the real FS response body (instead of returning null with a generic message), so the true rejection reason reaches the user event and clean dev logs. If a submit path silently "returns null on failure", make it surface the FS response body before assuming a cause.
- Don't assume the `type` string is the culprit without evidence — "Literature review" is valid; an earlier guess that it was invalid was wrong.

## Retry without regenerating
Admin/auth republish endpoints exist and re-run the stored submission: `POST /api/literature-reviews/:id/republish`, `POST /api/peer-reviews/:id/republish`, `POST /api/ethics-reports/:id/republish`. Use these to retry stuck records instead of spending a rate-limited generation.
