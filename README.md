# coda-anakin

Coda Pack for [Anakin](https://anakin.io) — web scraping, AI-powered search,
and multi-stage agentic research over hundreds of popular sites.

## What's covered

Three action formulas, matching the same baseline every other single-purpose
Anakin integration built this session covers:

- **`ScrapeUrl(url, [country], [useBrowser], [generateJson], [forceFresh],
  [sessionId], [sessionName])`** — submits `POST /v1/url-scraper`, then polls
  `GET /v1/url-scraper/:jobId` until the job completes or fails. Returns
  markdown (and structured JSON, if `generateJson` was set).
- **`Search(prompt, [limit])`** — calls `POST /v1/search`. Synchronous, no
  polling. Costs 3 credits per call.
- **`AgenticSearch(prompt, [useBrowser], [schema])`** — submits
  `POST /v1/agentic-search`, then polls `GET /v1/agentic-search/:jobId`.
  Returns an AI-generated summary plus structured data. Costs 10 credits.
  `schema` (an optional JSON Schema) is passed as a JSON-encoded string
  parameter and parsed before being forwarded — Coda formulas can't accept
  arbitrary objects as parameters (confirmed in the SDK's parameters guide,
  "Objects" section), so this is the only real option for a caller-supplied
  schema.

All three are declared with `isAction: true` rather than as plain
calculation formulas — see the comment block above the formula definitions
in `pack.ts` for why (short version: action formulas are documented as
"never cached or automatically recalculated," which matters when every call
spends real Anakin credits).

## Install

```sh
npm install
```

Installs the real `@codahq/packs-sdk` (currently `1.17.0` on npm) plus
TypeScript and the `packs` CLI it bundles.

## Auth

Anakin uses a static API key sent as the `X-API-Key` header — modeled with
`pack.setUserAuthentication({ type: coda.AuthenticationType.CustomHeaderToken,
headerName: "X-API-Key" })`. Get a free key at
[anakin.io/dashboard](https://anakin.io/dashboard) — 300 credits, no card
required.

## Limitation: polling vs. Coda's execution ceiling

`ScrapeUrl` and `AgenticSearch` are async on Anakin's side (submit, then
poll). Coda formulas don't have Fivetran/Kubeflow-style incremental state or
a generic "resume me later" mechanism — that pattern (`continuation`) exists
in the real SDK, but only for `addSyncTable`, not `addFormula`/`isAction`
formulas (confirmed in `docs/guides/blocks/sync-tables/index.md`, "Long-running
syncs" section). A single formula execution runs once, and per a moderator
answer in Coda's own maker community (not stated in the SDK guides
themselves), "the Packs runtime does have a maximum execution time
(currently around 60 seconds, but subject to change)," after which the
formula "could be canceled abruptly" with no error surfaced.

Given that, this Pack polls inside `execute()` on a 2s interval with a 45s
internal deadline — comfortably under the ~60s ceiling — and throws a clear
`UserVisibleError` if the job is still running when the deadline hits,
telling the user to re-run the formula. Anakin keeps the job running
server-side regardless of whether the Pack is still polling it. A properly
unbounded version of this Pack would model `ScrapeUrl`/`AgenticSearch` as
sync tables using the real continuation mechanism instead — that's a bigger
rebuild (sync tables have a different shape, results land in a table rather
than a formula return value) and is noted here as follow-on work, not built
speculatively for this submission.

## Precedent

Coda's own Pack gallery already has near-identical scraping/search-API
wrappers — [ParseHub](https://coda.io/packs/parsehub-11938) (run a project,
get run data, no sync table — "all projects have a very unique data
structure") and [Scrapestack](https://coda.io/packs/scrapestack-21235)
(single-URL HTML scrape into a string) — confirming this shape of Pack
(auth + a handful of action formulas around a scraping/search API, no sync
table) is an accepted, precedented pattern on the platform, not a novel one.
Nothing from either was copied; they were checked only to confirm the shape
that gallery reviewers already accept.

## Steps (needs the account owner)

1. `npx packs register` — one-time device auth against a real Coda account
   to get an API token for the CLI.
2. `npx packs create pack.ts --name "Anakin" --description "..."` —
   registers a new, empty Pack on Coda's servers.
3. `npx packs auth pack.ts` — stores a real Anakin API key locally so
   `packs execute` can make live calls (see SUBMIT.md — this needs an
   interactive terminal, which this sandbox doesn't have).
4. `npx packs upload pack.ts --notes "Initial version."` — builds and
   uploads the Pack.
5. Submit for the public gallery via the Pack Studio's **Listing** tab
   (branding, category, changing from private to public) — a manual step in
   the UI, not a CLI command.
