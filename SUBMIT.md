# Coda — submission instructions

Real, self-serve, CLI-buildable — Coda Packs are built and published with
the `packs` CLI (bundled in `@codahq/packs-sdk`) against a Coda maker
account, no repo/PR process involved (unlike the Dagster/Fivetran/Kubeflow
submissions in this batch, which go through GitHub PRs to third-party
registries). Listing in the public Pack gallery is a manual step in the Pack
Studio UI after upload, not a CLI command.

## What's here

```
pack.ts            The Pack — ScrapeUrl, Search, AgenticSearch formulas
package.json        @codahq/packs-sdk dependency, real CLI scripts
tsconfig.json        Same shape as the real coda/packs-examples tsconfig.json
package-lock.json    From a real `npm install` against the npm registry
.gitignore           node_modules/, dist/, and the local credentials files
                      the CLI itself generates (.coda-credentials.json,
                      .coda-pack.json, .coda.json)
```

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

## Verified, not assumed

- **`npm install` succeeded for real** — the npm registry is *not*
  network-restricted in this sandbox (unlike every Python `pip install`
  attempted elsewhere this session — dagster, fivetran's CLI, kfp, crewai).
  Installed the actual `@codahq/packs-sdk@1.17.0` from the npm registry, 381
  packages.
- **`npx tsc --noEmit` passes clean, zero errors** — a real, complete
  TypeScript compile against the real installed SDK's type definitions, not
  a syntax-only read-through.
- **`npx packs validate pack.ts` passes, exit code 0** — the real SDK's own
  Pack manifest validator (schema shapes, formula definitions, naming
  rules), not just `tsc`.
- **`npx packs execute pack.ts <Formula> <args>` runs for real, for all
  three formulas** — the CLI bundles `pack.ts` with esbuild and executes it
  in the real local Pack runtime (an `isolated-vm` sandbox when available,
  falling back to plain Node — this sandbox used the plain-Node fallback,
  reported by the CLI itself since `isolated-vm`'s native build wasn't
  present). All three formulas resolved their parameters correctly and
  reached the fetcher call.
- **Went further and got a real, live network round-trip against
  `api.anakin.io`.** `npx packs auth pack.ts` needs an interactive TTY
  (`readline-sync` shells out to `/dev/tty`, which errored as
  `Device not configured` in this sandbox — a genuine sandbox limitation,
  not a "needs a live Coda account" one: no Coda account was needed for any
  of this, it's a *local* credentials file). Since the CLI's own
  `.coda-credentials.json` format is trivially inferrable from
  `dist/testing/auth.js` (`{"credentials": {"token": "<value>"}}`, written
  with mode `0o600`), wrote one by hand with an obviously-fake token,
  re-ran `packs execute`, and got a real response from Anakin's live
  production API for all three formulas:
  ```
  StatusCodeError: 401 - {"error":"unauthorized","message":"Invalid or inactive API key"}
    uri: 'https://api.anakin.io/v1/search'       (Search)
    uri: 'https://api.anakin.io/v1/url-scraper'  (ScrapeUrl)
    uri: 'https://api.anakin.io/v1/agentic-search' (AgenticSearch)
  ```
  Confirms the endpoint paths, the `X-API-Key` header, and the request
  body shape (`{"prompt":"test query","limit":5}` for `Search`, logged in
  full in the CLI's error output) are all correct against the real,
  live Anakin API — not just internally self-consistent. The temporary
  `.coda-credentials.json` (fake token, no real secret) was deleted after
  this test; it's also in `.gitignore` so it can't land in a commit.
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
  one. A real key would additionally confirm the response body actually
  deserializes cleanly into the schemas defined in `pack.ts`
  (`ScrapeResultSchema`, `SearchResultSchema`, `AgenticSearchResultSchema`)
  — those were written by hand from `anakin-py`'s `client.py`/`models.py`
  field names, not observed from a live success response.
- **Never opened the Pack in the actual Pack Studio UI** — so the rendered
  formula documentation, parameter dialogs, and object-chip display
  (`displayProperty` choices) haven't been eyeballed, only reasoned about
  from the docs.
- Polling correctness under real job latency (does a real `url-scraper` job
  reliably finish inside the 45s budget? does `agentic-search`, which is
  described as a "multi-stage" pipeline, sometimes need longer?) is
  unverified — no live jobs were run. If Anakin's real p95 job latency for
  either endpoint routinely exceeds ~45s, the honest fix is the sync-table
  redesign noted in README.md, not a larger polling budget (that just moves
  the failure closer to Coda's hard ~60s ceiling instead of removing it).

## Steps (needs the account owner)

1. `npx packs register` — device-auth a real Coda maker account.
2. `npx packs create pack.ts --name "Anakin" --description "..."`.
3. `npx packs auth pack.ts` — paste a real Anakin API key (interactive; run
   this from a real terminal, not a sandboxed/piped shell — it needs
   `/dev/tty`).
4. `npx packs execute pack.ts Search "some query"` against the real key to
   confirm the response actually deserializes into `SearchResultSchema` —
   the one thing this session couldn't check.
5. `npx packs upload pack.ts --notes "Initial version."`.
6. In the Pack Studio, fill in the **Listing** tab (icon, category,
   description, screenshots) and submit for the public gallery.
