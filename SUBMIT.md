# Coda — submission instructions

Real, self-serve, CLI-buildable — Coda Packs are built and published with
the `packs` CLI (bundled in `@codahq/packs-sdk`) against a Coda maker
account, no repo/PR process involved (unlike the Dagster/Fivetran/Kubeflow
submissions in this batch, which go through GitHub PRs to third-party
registries). Listing in the public Pack gallery is a manual step in the Pack
Studio UI after upload, not a CLI command.

## What's here

```
pack.ts            The Pack — 19 formulas covering 19 of Anakin's 21 REST
                    API capabilities (see README.md's "What's covered" and
                    "Scope" sections for the full list and the two
                    deliberate exclusions)
package.json        @codahq/packs-sdk dependency, real CLI scripts
tsconfig.json        Same shape as the real coda/packs-examples tsconfig.json
package-lock.json    From a real `npm install` against the npm registry
.gitignore           node_modules/, dist/, and the local credentials files
                      the CLI itself generates (.coda-credentials.json,
                      .coda-pack.json, .coda.json)
```

This revision (`feat/full-tool-coverage`) extends the original 3-formula
Pack (ScrapeUrl, Search, AgenticSearch) to 19, using the exact same
verification method described below — re-run in full against the expanded
`pack.ts`, not assumed to still hold. Every field name and endpoint used by
the 16 new formulas was read directly from Anakin's own MCP server source
(`anakin-mcp/src/client.ts`, `anakin-mcp/src/tools/*.ts`), the same
ground-truth requirement as the original three.

Structure, syntax, and every API surface used (`coda.newPack()`,
`pack.addNetworkDomain()`, `pack.setUserAuthentication()` with
`CustomHeaderToken`, `pack.addFormula()` with `isAction: true`,
`coda.makeParameter()`, `coda.makeObjectSchema()`, `context.fetcher.fetch()`,
`coda.UserVisibleError`) was checked against the real, current SDK docs at
`github.com/coda/packs-sdk` (the `docs/guides/**` tree — not the older
`documentation/` tree in the same repo, which is generated reference output,
not the guide source) and the real `coda/packs-examples` reference Packs
(`examples/dictionary/pack.ts`, `examples/dictionary/schemas.ts`,
`examples/github/pack.ts`), pulled live via `curl`/GitHub's raw content API,
not assumed. Direct doc fetches of `coda.io/packs/build/latest/...` mostly
404'd or resolved to a generic "Superhuman Docs" shell (Coda's docs now live
under Superhuman's domain post-acquisition — visible in the current
`@codahq/packs-sdk` npm maintainer list, several `@superhuman.com` /
`@grammarly.com` addresses alongside the `@coda.io` ones); the GitHub source
tree was the reliable source throughout.

## The one real design question in this task, answered from source

**Can a Coda formula do multi-step polling for a long-running job, or is a
different pattern required?** Formulas *can* run a polling loop inside
`execute()` — sequential `await context.fetcher.fetch()` calls in a `while`
loop are exactly the pattern shown in the fetcher guide's own "In parallel"
counterexample (it shows the parallel case specifically to contrast with the
default sequential/awaited case). But formulas have no continuation/resume
mechanism — that exists in the SDK (`context.sync.continuation`,
documented in `docs/guides/blocks/sync-tables/index.md` under "Long-running
syncs") but only for `addSyncTable`. A single `addFormula`/`isAction`
`execute()` call runs once, uninterrupted, or not at all — and per a
moderator's answer in Coda's own maker community (Eric Koleda,
`connect.superhuman.com/t/is-formula-execution-time-limited-.../29541` —
this fact is *not* stated anywhere in the SDK guides themselves, only in
that community thread) there's a ceiling: "the Packs runtime does have a
maximum execution time (currently around 60 seconds, but subject to
change)," past which a formula "could be canceled abruptly" with no error.
`pack.ts` polls with a 2s interval and a 45s internal deadline (comfortably
under that ceiling) and fails loudly with a `UserVisibleError` instead of
letting Coda kill the request silently — documented inline in `pack.ts` and
in README.md's "Limitation" section.

## The second design question this revision adds

**Given that polling pattern works, does it fit *every* async endpoint in
Anakin's API, or only some?** No — and forcing all of them in anyway would
have been the actual guessing/fabrication risk here, not a thoroughness
win. `map`, `crawl`, `wire_read_action`, and `wire_write_action` got the
same bounded-poll treatment as the original `ScrapeUrl`/`AgenticSearch`
because nothing in the source material suggests they're a different
latency class — that's a judgment call, flagged as such (see README.md's
isAction section on `MapSite`/`CrawlSite` billing being inferred, not
confirmed). `ai-visibility-search` and `browser-task` did not get that
treatment, because their *own* source material — anakin-mcp's tool
description and `client.ts`'s comments, not this Pack's assumptions — says
their typical/legitimate latency is at or beyond Coda's ~60s ceiling. That
distinction (what the source says vs. what would just be convenient to
assume) is the actual basis for the scope decision in README.md's "Scope"
section, not a coverage-count target.

## Verified, not assumed

- **`npm install` succeeded for real** — the npm registry is *not*
  network-restricted in this sandbox (unlike every Python `pip install`
  attempted elsewhere this session — dagster, fivetran's CLI, kfp, crewai).
  Installed the actual `@codahq/packs-sdk@1.17.0` from the npm registry, 381
  packages.
- **`npx tsc --noEmit` passes clean, zero errors** — a real, complete
  TypeScript compile against the real installed SDK's type definitions
  (re-run after the `feat/full-tool-coverage` expansion to 19 formulas; the
  first pass caught a real type error — the `wireActionParameters()` helper
  factory originally shared between `WireReadAction`/`WireWriteAction`
  returned `ParamDef[]`, which doesn't satisfy `addFormula`'s tuple-typed
  `parameters: ParamDefs`; fixed by inlining both parameter lists instead
  of sharing a function — not a syntax-only read-through).
- **`npx packs validate pack.ts` passes, exit code 0** — the real SDK's own
  Pack manifest validator (schema shapes, formula definitions, naming
  rules), not just `tsc`. Re-run clean against all 19 formulas.
- **`npx packs execute pack.ts <Formula> <args>` runs for real** — the CLI
  bundles `pack.ts` with esbuild and executes it in the real local Pack
  runtime (an `isolated-vm` sandbox when available, falling back to plain
  Node — this sandbox used the plain-Node fallback, reported by the CLI
  itself since `isolated-vm`'s native build wasn't present).
- **Went further and got real, live network round-trips against
  `api.anakin.io`, for both the original three formulas and a
  representative sample of the sixteen new ones.** `npx packs auth pack.ts`
  needs an interactive TTY (`readline-sync` shells out to `/dev/tty`, which
  errors as `Device not configured` in this sandbox — a genuine sandbox
  limitation, not a "needs a live Coda account" one: no Coda account was
  needed for any of this, it's a *local* credentials file). Since the CLI's
  own `.coda-credentials.json` format is trivially inferrable from
  `dist/testing/auth.js` (`{"credentials": {"token": "<value>"}}`, written
  with mode `0o600`), wrote one by hand with an obviously-fake token,
  ran `packs execute` against nine formulas, and got real responses from
  Anakin's live production API:
  ```
  Search             → 401 uri: https://api.anakin.io/v1/search
  MapSite             → 401 uri: https://api.anakin.io/v1/map
  CrawlSite           → 401 uri: https://api.anakin.io/v1/crawl
  WireIdentities      → 401 uri: https://api.anakin.io/v1/wire/identities
                          (Wire's nested error envelope: {"status":"error","error":{...}} —
                          confirms client.ts's documented dual error shape, not just the flat one)
  MonitorChanges      → 401 uri: https://api.anakin.io/v1/monitors/test-id/changes
  MonitorList         → 401 uri: https://api.anakin.io/v1/monitors
  SessionList         → 401 uri: https://api.anakin.io/v1/sessions
  AiVisibilitySources → 401 uri: https://api.anakin.io/v1/ai-visibility/sources
  ```
  all with `{"error":"unauthorized","message":"Invalid or inactive API key"}`
  (or Wire's nested equivalent) — confirming those endpoint paths, the
  `X-API-Key` header, and account-scoping are all correct against the real
  API.
  **Two calls unexpectedly succeeded outright** rather than 401ing —
  `WireDiscover` (`GET /wire/resolve?q=...`) and `WireCatalog`
  (`GET /wire/catalog`) both returned real, live catalog data (Walmart
  action definitions with real-shaped `item_id`s; a paginated list of real
  site entries like `1800flowers`, `101cookbooks`, `123inkt`) even with the
  fake token. This means Wire's discovery/catalog-browse endpoints don't
  require a valid key server-side — a genuine finding about the live API,
  not a bug in this Pack, and it independently confirms `WireResolveResponse`'s
  `{results, next}` shape and the full catalog entry shape (`id`, `slug`,
  `name`, `url`, `domain`, `category`, `description`, `auth_required`,
  `auth_types`, `supported_sources`, `status`, `created_at`, `updated_at`,
  `action_count`) beyond what client.ts types (which is only
  `Promise<unknown>` for both) — stronger verification than a 401 gives.
  Given that surface finding, no formula with a real side effect or a
  credit cost was executed live — `WireLogin`, `WireBuild`, `MonitorCreate`,
  `MonitorControl`, `SessionDelete`, `WireReadAction`, and `WireWriteAction`
  were verified by `tsc`/`packs validate` only, specifically *because* a
  fake token turning out to be accepted somewhere was exactly the kind of
  surprise that makes running a mutating call against production too risky
  to justify for a CLI smoke test. The temporary `.coda-credentials.json`
  (fake token, no real secret) was deleted immediately after testing; it's
  also in `.gitignore` so it can't land in a commit.
- ParseHub (`coda.io/packs/parsehub-11938`) and Scrapestack
  (`coda.io/packs/scrapestack-21235`) were located on Coda's real public
  Pack gallery via web search, confirming the task's premise that
  near-identical scraping/search Pack precedents exist. Their listing pages
  only expose marketing copy (no source), so they informed the *shape*
  decision (auth + action formulas, no sync table — see README.md
  "Precedent") and nothing else; no content was copied from either.

## Not done

- **Never ran `npx packs register`, `npx packs create`, or `npx packs
  upload`** — these need a real Coda maker account and talk to Coda's own
  servers (as opposed to `packs auth`/`packs execute`, which are entirely
  local except for the one fetcher call to `api.anakin.io` tested above).
  No account credentials exist in this environment for that.
- **Never tested against a real, valid Anakin API key** — only confirmed
  the request reaches the right endpoint and gets a real 401 for an invalid
  one (for two Wire formulas, better than that — see above). A real key
  would additionally confirm the response body actually deserializes
  cleanly into the schemas defined in `pack.ts` (`ScrapeResultSchema`,
  `SearchResultSchema`, `AgenticSearchResultSchema`, `MapResultSchema`,
  `CrawlResultSchema`) — those were written by hand from
  `anakin-mcp/src/client.ts`'s typed interfaces, not observed from a live
  success response against those specific fields (`WireResolveResponse`'s
  shape and the Wire catalog entry shape *were* observed live, per above —
  those two are the exception, not the rule).
- **Never ran any of the seven formulas with a real side effect or
  confirmed credit cost against the live API** (`WireLogin`, `WireBuild`,
  `MonitorCreate`, `MonitorControl`, `SessionDelete`, `WireReadAction`,
  `WireWriteAction`) — deliberate, given the `WireDiscover`/`WireCatalog`
  finding above that at least some endpoints don't reject an invalid key.
  Running a mutating call with an unverified auth boundary against a real
  production account, without the account owner present, isn't a
  reasonable risk for a CLI smoke test to take. These seven are verified
  only by `tsc` + `packs validate` (parameters resolve, the request body is
  constructed as intended, the code reaches the fetcher call) — the account
  owner should confirm at least one of each against a real key per the
  "Steps" section below before relying on them.
- **Never opened the Pack in the actual Pack Studio UI** — so the rendered
  formula documentation, parameter dialogs, and object-chip display
  (`displayProperty` choices) haven't been eyeballed, only reasoned about
  from the docs. With 19 formulas now (up from 3), this matters more than
  it did originally — worth a careful pass in Pack Studio before public
  listing, particularly the long `MonitorCreate` parameter list.
- Polling correctness under real job latency (does a real `url-scraper` job
  reliably finish inside the 45s budget? does `agentic-search`, which is
  described as a "multi-stage" pipeline, sometimes need longer? the same
  question now also applies to `map`, `crawl`, `wire_read_action`, and
  `wire_write_action`) is unverified — no live jobs were run. If Anakin's
  real p95 job latency for any of these routinely exceeds ~45s, the honest
  fix is the sync-table redesign noted in README.md, not a larger polling
  budget (that just moves the failure closer to Coda's hard ~60s ceiling
  instead of removing it).

## Steps (needs the account owner)

1. `npx packs register` — device-auth a real Coda maker account.
2. `npx packs create pack.ts --name "Anakin" --description "..."`.
3. `npx packs auth pack.ts` — paste a real Anakin API key (interactive; run
   this from a real terminal, not a sandboxed/piped shell — it needs
   `/dev/tty`).
4. `npx packs execute pack.ts Search "some query"` against the real key to
   confirm the response actually deserializes into `SearchResultSchema`.
   Do the same for `MapSite`/`CrawlSite` against a small/fast site
   (`SearchResultSchema`/`MapResultSchema`/`CrawlResultSchema` are the only
   ones this session couldn't observe against a live success response).
5. Before relying on them, run each state-changing formula once by hand
   against a disposable/test target: `WireLogin`, `WireBuild`,
   `MonitorCreate` (then `MonitorControl` with `action="delete"` to clean
   it up), `SessionDelete` (against a session you don't need), and one
   `WireReadAction`/`WireWriteAction` pair with a real, cheap `action_id`
   from `WireDiscover`. This session deliberately did not run these live —
   see "Not done" above for why.
6. `npx packs upload pack.ts --notes "..."`.
7. In the Pack Studio, fill in the **Listing** tab (icon, category,
   description, screenshots) and submit for the public gallery.
