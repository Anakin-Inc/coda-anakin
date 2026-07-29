# coda-anakin

Coda Pack for [Anakin](https://anakin.io) — web scraping and site mapping,
AI-powered search, multi-stage agentic research, Wire's cross-site action
catalog, website change monitoring, AI-visibility comparison, and saved
browser session management.

## What's covered

19 of Anakin's 21 REST API capabilities, as 19 formulas:

**Scraping & research**
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
- **`MapSite(url, [limit], [depth], [limitPerLevel], [includeSubdomains],
  [includeExternalLinks], [useBrowser], [search])`** — submits `POST /v1/map`,
  polls `GET /v1/map/:jobId`. Discovers a domain's URL structure without
  fetching page content.
- **`CrawlSite(url, [maxPages], [depth], [country], [useBrowser],
  [includePatterns], [excludePatterns], [sessionId], [sessionName])`** —
  submits `POST /v1/crawl`, polls `GET /v1/crawl/:jobId`. Bulk-fetches
  markdown across many pages; keep `maxPages` modest (defaults to 10) to
  stay inside Coda's polling ceiling — see "Limitation" below.

**Wire (cross-site action catalog)**
- **`WireDiscover(q, [limit])`** — `GET /v1/wire/resolve`. Natural-language
  intent → ranked candidate actions. Plain calculation formula (free,
  read-only, confirmed to need no auth against the live API — see
  "Verified" in SUBMIT.md).
- **`WireCatalog([slug])`** — `GET /v1/wire/catalog` or
  `GET /v1/wire/catalog/:slug`. Plain calculation formula (same as above —
  confirmed publicly readable against the live API without a valid key).
- **`WireIdentities([catalogId])`** — `GET /v1/wire/identities`. Your saved
  credentials for running auth-required actions. Plain calculation formula
  (read-only; account-scoped, so it does need a valid key — confirmed via a
  live 401 with an invalid one).
- **`WireReadAction(actionId, [params], [credentialId], [identityId])`** /
  **`WireWriteAction(...)`** (same signature) — both submit
  `POST /v1/wire/task {action_id, params, credential_id, identity_id}`, then
  either return an inline result or poll `GET /v1/wire/jobs/:jobId`. Split
  into two formulas — mirroring the read/write split in anakin-mcp's own
  Wire tools — so a write (state-changing) action is never confused for a
  read. `isAction: true` on both (billed; write is additionally
  state-changing). `WireWriteAction` does **not** replicate anakin-mcp's
  application-level block on financial/payment actions — that's an MCP
  compliance policy, not an Anakin API constraint, and this Pack calls the
  raw API directly.
- **`WireLogin(catalogSlug, [params], [identityName], [sourceId],
  [sourceRef])`** — `POST /v1/wire/login`. Signs in to a credentials-mode
  site and returns a `credential_id`. `isAction: true` — establishes stored,
  security-sensitive state; must never fire on silent recalculation.
- **`WireBuild(websiteUrl, goal, [catalogId], [visibility], [force])`** —
  `POST /v1/wire/build-request`. Requests a new Wire action for an
  unsupported site. `isAction: true` — billed and publishes new catalog
  state; no job endpoint to poll, so this returns the initial `"pending"`
  response only.

**Website monitoring**
- **`MonitorCreate(url, intervalMinutes, [scope], [watchMode],
  [watchFormat], [outputSchema], [aiMode], [aiGoal], [useBrowser], [country],
  [sessionId], [isActive], [expiresAt], [alertWebhookUrl], [alertEmails],
  [maxPages], [maxDepth], [includePatterns], [excludePatterns],
  [wireActionId], [wireCatalogSlug], [wireCredentialId], [wireParams],
  [wireWatchPaths])`** — `POST /v1/monitors`. `isAction: true` — creates a
  standing, billed, recurring, alert-sending resource; a silent Coda
  recalculation creating a duplicate monitor would be a genuinely bad
  failure mode, not just a wasted API call. This was flagged explicitly as
  a design question in scoping this Pack and is the clearest example of why
  the isAction rule generalizes past "costs credits" to "mutates state."
- **`MonitorList([id])`** — `GET /v1/monitors` or `GET /v1/monitors/:id`.
  Plain calculation formula, read-only.
- **`MonitorChanges(id)`** — `GET /v1/monitors/:id/changes`. Plain
  calculation formula, read-only.
- **`MonitorControl(id, action)`** — `action` is one of `pause` / `resume` /
  `run_now` / `delete`, dispatched to `POST /v1/monitors/:id/{pause,resume,
  run}` or `DELETE /v1/monitors/:id`. `isAction: true` — every verb mutates
  the monitor and `delete` is irreversible.
- Every monitor-formula response has `alertWebhookSecret` (an HMAC signing
  secret returned inline by the API) redacted before it reaches Coda,
  mirroring anakin-mcp's own `redactSecrets()` — a secret that lands in a
  Coda doc is exposed to every viewer and kept in Coda's revision history,
  same as it would be in a chat transcript.

**AI visibility & sessions**
- **`AiVisibilitySources()`** — `GET /v1/ai-visibility/sources`. Plain
  calculation formula, read-only. (`ai_visibility_search` itself is not
  covered — see "Scope" below.)
- **`SessionList([domain])`** — `GET /v1/sessions`. Plain calculation
  formula, read-only.
- **`SessionDelete(id)`** — `DELETE /v1/sessions/:id`. `isAction: true` —
  irreversible; other formulas/monitors referencing that `sessionId` lose
  authenticated access.

### Result shapes: typed schema vs. raw JSON

`ScrapeUrl`, `Search`, `AgenticSearch`, `MapSite`, and `CrawlSite` return a
real Coda object schema — their response shapes are fully typed,
field-for-field, in Anakin's own reference client (`anakin-mcp/src/
client.ts`). Every other formula above returns the raw JSON response as a
**string** (wrap in Coda's `ParseJSON()` to extract fields) — because
`client.ts` itself types those responses as `Promise<unknown>` or carries an
explicit `[key: string]: unknown` index signature. Fabricating a fixed
object schema for a shape the reference implementation doesn't commit to
risks silently wrong field names; returning the raw JSON is the honest
option given what's actually documented upstream.

### isAction rule

Extended past the original three-formula version of this Pack:
`isAction: true` when a formula (a) spends real Anakin credits, (b) mutates
state on Anakin's side, or (c) both. Plain calculation formulas are used
only for confirmed-or-obviously-free, side-effect-free, account-scoped-or-
public reads. See the comment block above the formula definitions in
`pack.ts` for the full reasoning, including the one inference that isn't a
confirmed fact: `MapSite`/`CrawlSite` are marked `isAction` on the
assumption they're billed like `url-scraper` (same resource class), since
neither anakin-mcp's tool descriptions nor `client.ts` state a credit cost
for either the way they do for the other nine.

## Scope: what's deliberately not covered

Two of Anakin's 21 REST capabilities are left out, not overlooked — full
reasoning is in the "Deliberately not covered" comment block at the end of
`pack.ts`:

- **`ai-visibility-search`** — anakin-mcp's own tool description says this
  typically completes in **1–2 minutes**, at or past Coda's ~60s formula
  ceiling on the *common* case, not just a slow tail. Unlike `ScrapeUrl`,
  there's no `cached` field on its result to make a timed-out retry cheap —
  every re-run resubmits a brand-new, full-price, multi-engine search. A
  Pack formula here would reliably time out and burn credits on retry for
  its primary use case.
- **`browser-task`** — Anakin's natural-language AI browser automation
  endpoint. `client.ts` states these are "hard-capped server-side at
  ~330s," with a 6-minute client polling budget — a fundamentally different
  latency class where the *legitimate* operating range already exceeds
  Coda's ~60s ceiling as the norm, not the exception. A bounded-poll Coda
  formula would be non-functional for real use, not occasionally slow.

Both are better fits for the sync-table + continuation redesign noted in
"Limitation" below, which has no execution-time ceiling the way a single
`addFormula` `execute()` call does.

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

`ScrapeUrl`, `AgenticSearch`, `MapSite`, `CrawlSite`, `WireReadAction`, and
`WireWriteAction` are all async on Anakin's side (submit, then poll). Coda
formulas don't have Fivetran/Kubeflow-style incremental state or a generic
"resume me later" mechanism — that pattern (`continuation`) exists in the
real SDK, but only for `addSyncTable`, not `addFormula`/`isAction` formulas
(confirmed in `docs/guides/blocks/sync-tables/index.md`, "Long-running
syncs" section). A single formula execution runs once, and per a moderator
answer in Coda's own maker community (not stated in the SDK guides
themselves), "the Packs runtime does have a maximum execution time
(currently around 60 seconds, but subject to change)," after which the
formula "could be canceled abruptly" with no error surfaced.

Given that, every one of those six formulas polls inside `execute()` on a
2s interval with a 45s internal deadline — comfortably under the ~60s
ceiling — and throws a clear `UserVisibleError` if the job is still running
when the deadline hits, telling the user to re-run the formula. Anakin
keeps the job running server-side regardless of whether the Pack is still
polling it. This is a judgment call applied consistently, not proven safe
for each endpoint individually — see "Scope" above for the two endpoints
(`ai-visibility-search`, `browser-task`) where the same reasoning instead
led to leaving the formula out entirely, because their documented/typical
latency exceeds the ceiling as the norm rather than the exception. A
properly unbounded version of this Pack would model all six as sync tables
using the real continuation mechanism instead — that's a bigger rebuild
(sync tables have a different shape, results land in a table rather than a
formula return value) and is noted here as follow-on work, not built
speculatively for this submission.

## Precedent

Coda's own Pack gallery already has near-identical scraping/search-API
wrappers — [ParseHub](https://coda.io/packs/parsehub-11938) (run a project,
get run data, no sync table — "all projects have a very unique data
structure") and [Scrapestack](https://coda.io/packs/scrapestack-21235)
(single-URL HTML scrape into a string) — confirming this shape of Pack
(auth + a set of action/calculation formulas around a scraping/search API,
no sync table) is an accepted, precedented pattern on the platform, not a
novel one.
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
