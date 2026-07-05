---
name: Available-papers endpoints are slow (no cache)
description: Why the peer-review / ethics "pick a paper" lists take ~30s and how the UI must handle it
---

The `/api/peer-reviews/available-papers` and `/api/ethics-reports/available-papers` endpoints
fetch the ENTIRE Future Science journal catalogue page-by-page (`fetchAbstractsAndKeywords`)
on every request, with no server-side cache. For the Mirror journal this is ~30-35s and ~175KB.

**Why:** FS paginates abstracts across many cursors; the endpoint walks all of them synchronously
per request. There is no caching layer, so each dashboard visit re-fetches the whole catalogue.

**How to apply:**
- Any UI consuming these endpoints MUST show a real loading state (spinner/progress bar) and
  distinguish loading vs. loaded-but-empty vs. error. The old code showed "Loading available
  papers…" whenever `papers.length === 0`, which made a slow/empty/errored response look frozen.
- The queryFn must `throw` on `!res.ok` so react-query's `isError` works (endpoint returns
  `{error:...}` with a 500, which otherwise silently becomes an empty list).
- If load time becomes a real complaint, the fix is a short-TTL server-side cache of the FS
  catalogue keyed by journal, not a frontend change.
