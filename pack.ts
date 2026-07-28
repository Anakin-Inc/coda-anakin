// Coda Pack for Anakin (https://anakin.io) — web scraping and mapping,
// AI-powered search, multi-stage agentic research, Wire's cross-site
// action catalog, website change monitoring, AI-visibility comparison, and
// saved browser session management. Covers 19 of Anakin's 21 REST API
// capabilities as Coda formulas; the two left out (ai-visibility-search and
// the AI browser-task endpoint) are documented, not silently dropped — see
// the "Deliberately not covered" comment block near the bottom of this file
// and README.md's "Scope" section.
//
// Structure and syntax verified against the real @codahq/packs-sdk docs and
// the coda/packs-examples reference packs (examples/dictionary/pack.ts,
// examples/github/pack.ts) — see SUBMIT.md for exactly what was checked and
// where. Nothing here is guessed API surface: every field name and endpoint
// shape below was read directly from Anakin's own MCP server source
// (anakin-mcp/src/client.ts and anakin-mcp/src/tools/*.ts), not inferred
// from endpoint names or assumed from convention.

import * as coda from "@codahq/packs-sdk";

export const pack = coda.newPack();

// A Pack may register exactly one root network domain by default (see the
// "Network domains" section of the fetcher guide) — the fetcher can then
// reach that domain and all its subdomains, which covers both
// `api.anakin.io` and `anakin.io` (used for the auth instructions link).
pack.addNetworkDomain("anakin.io");

const BASE_URL = "https://api.anakin.io/v1";

// Auth: Anakin uses a static per-account API key sent as `X-API-Key`, no
// prefix. This is exactly the CustomHeaderToken shape from the SDK's
// authentication guide (`headerName`, no `tokenPrefix`).
pack.setUserAuthentication({
  type: coda.AuthenticationType.CustomHeaderToken,
  headerName: "X-API-Key",
  instructionsUrl: "https://anakin.io/dashboard",
});

// ─── Polling ─────────────────────────────────────────────────────────────
//
// Several of the endpoints covered here — url-scraper, agentic-search, map,
// crawl, and Wire's task/job pair — are async: submit a job, then poll a
// second endpoint until it reaches a terminal `status` of "completed" or
// "failed". `/search`, and every plain metadata/list/delete endpoint added
// below (Wire discovery, monitor list/changes, sessions, AI-visibility
// sources, etc.), are synchronous and need no polling.
//
// Coda formulas do NOT have a first-class mechanism for this. The SDK's own
// docs describe a "continuation" pattern for exactly this problem
// (sync-tables/index.md, "Long-running syncs" section), but it is scoped to
// `addSyncTable` — the platform re-invokes the sync formula, feeding back a
// `context.sync.continuation` object, across multiple executions. A plain
// `addFormula`/`isAction` formula (which is the right shape for these three
// operations — see the isAction note below) has no such re-invocation
// mechanism: execute() runs once, start to finish, or it doesn't run again.
//
// The one documented constraint on that single execution: Coda's own maker
// community confirms (a moderator answer, not the SDK guides, since the
// guides don't state it) "the Packs runtime does have a maximum execution
// time (currently around 60 seconds, but subject to change)" and a formula
// that exceeds it "could be canceled abruptly" with no error surfaced. See
// SUBMIT.md for the exact source.
//
// Given that ceiling and no continuation option for formulas, this Pack
// polls in a loop inside execute() with a deadline safely under 60s, and
// throws a clear, actionable UserVisibleError if the job is still running
// when the deadline hits — instead of letting Coda's runtime kill the
// request silently. The user can just re-run the formula; Anakin's job
// keeps running server-side regardless of whether the Pack is still polling
// it, so a re-run against the same job type will pick up a fresh (likely
// now-complete) result. A sync-table-based redesign using the real
// continuation mechanism would remove this ceiling entirely — noted as
// follow-on work in README.md rather than built speculatively here.
const POLL_INTERVAL_MS = 2000;
const POLL_DEADLINE_MS = 45000; // Comfortably under the ~60s formula ceiling.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollJob(
  context: coda.ExecutionContext,
  resourcePath: string,
  jobId: string,
): Promise<any> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let job: any;
  while (true) {
    const response = await context.fetcher.fetch({
      method: "GET",
      url: `${BASE_URL}${resourcePath}/${jobId}`,
    });
    job = response.body;
    if (job.status === "completed" || job.status === "failed") {
      return job;
    }
    if (Date.now() >= deadline) {
      throw new coda.UserVisibleError(
        `Anakin job ${jobId} is still "${job.status ?? "processing"}" after ` +
          `${Math.round(POLL_DEADLINE_MS / 1000)}s. Coda formulas are capped ` +
          `at roughly 60s of execution, so this Pack can't keep waiting. ` +
          `Anakin keeps working on the job in the background — wait a few ` +
          `seconds and run the formula again.`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function assertJobSucceeded(job: any, verb: string): void {
  if (job.status === "failed") {
    throw new coda.UserVisibleError(
      `Anakin ${verb} job failed: ${job.error ?? "unknown error"}`,
    );
  }
}

// Wire job failures carry a structured `error` object ({code, message,
// details, connect_url} — see client.ts's `WireJobError`), not a plain
// string like the other job types, so it gets its own assertion that
// extracts a human-readable reason the same way client.ts's own
// `pollWireJob` does (`job.error?.message ?? job.error?.code ?? 'unknown'`).
function assertWireJobSucceeded(job: any, actionId: string): void {
  if (job.status === "failed") {
    const reason = job.error?.message ?? job.error?.code ?? "unknown error";
    throw new coda.UserVisibleError(
      `Anakin Wire action "${actionId}" failed: ${reason}`,
    );
  }
}

// Small helper for GET endpoints that take optional query parameters —
// same technique as (not copied from) client.ts's own `withQuery`.
function withQuery(
  path: string,
  params: Record<string, string | number | undefined>,
): string {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== "",
  );
  if (entries.length === 0) return path;
  const qs = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return `${path}?${qs}`;
}

// Parse a formula parameter that's documented as a JSON-encoded string
// (Coda formulas have no arbitrary-object parameter type — see the
// AgenticSearch `schema` parameter above and SUBMIT.md's "Objects" note).
function parseJsonParam(value: string | undefined, paramName: string): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch (e: any) {
    throw new coda.UserVisibleError(
      `The ${paramName} parameter must be valid JSON: ${e.message}`,
    );
  }
}

// Monitors carry an `alertWebhookSecret` (an HMAC signing secret) in their
// API response. Anakin's own MCP server never lets that reach a model
// (src/tools/monitor.ts's `redactSecrets`) — a secret that lands in a Coda
// doc is just as exposed (visible to every doc viewer, kept in Coda's
// revision history), so every monitor-family formula below redacts it the
// same way before returning. The real value stays retrievable only from the
// Anakin dashboard.
const MONITOR_SECRET_KEYS = new Set(["alertWebhookSecret"]);
const MONITOR_SECRET_REDACTED = "[redacted — view in the Anakin dashboard]";
function redactMonitorSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactMonitorSecrets);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = MONITOR_SECRET_KEYS.has(k) && v ? MONITOR_SECRET_REDACTED : redactMonitorSecrets(v);
    }
    return out;
  }
  return value;
}

// ─── Schemas ─────────────────────────────────────────────────────────────
//
// Field names below (jobId, generatedJson, durationMs, etc.) are the wire
// shapes read directly from anakin-py's src/anakin/client.py and
// src/anakin/models.py — the reference SDK implementation for this same
// API — not guessed from the endpoint names.

const ScrapeResultSchema = coda.makeObjectSchema({
  properties: {
    id: {type: coda.ValueType.String, required: true},
    url: {type: coda.ValueType.String, required: true},
    status: {type: coda.ValueType.String, required: true},
    cached: {type: coda.ValueType.Boolean},
    durationMs: {type: coda.ValueType.Number},
    markdown: {type: coda.ValueType.String},
    // `generatedJson` is only populated when `generateJson: true` is passed,
    // and its shape is caller/site-defined (AI-extracted structured data),
    // so it's modeled as a passthrough object rather than a fixed schema.
    generatedJson: {
      type: coda.ValueType.Object,
      properties: {},
      includeUnknownProperties: true,
    },
    error: {type: coda.ValueType.String},
  },
  displayProperty: "url",
  idProperty: "id",
});

const SearchResultItemSchema = coda.makeObjectSchema({
  properties: {
    url: {type: coda.ValueType.String, required: true},
    title: {type: coda.ValueType.String},
    snippet: {type: coda.ValueType.String},
    date: {type: coda.ValueType.String},
    lastUpdated: {type: coda.ValueType.String},
  },
  displayProperty: "title",
});

const SearchResultSchema = coda.makeObjectSchema({
  properties: {
    id: {type: coda.ValueType.String, required: true},
    results: {
      type: coda.ValueType.Array,
      items: SearchResultItemSchema,
      required: true,
    },
  },
  displayProperty: "id",
  idProperty: "id",
});

const AgenticSearchResultSchema = coda.makeObjectSchema({
  properties: {
    id: {type: coda.ValueType.String, required: true},
    status: {type: coda.ValueType.String, required: true},
    cached: {type: coda.ValueType.Boolean},
    durationMs: {type: coda.ValueType.Number},
    summary: {type: coda.ValueType.String},
    // `structuredData` shape follows the caller-supplied `schema` parameter
    // (or is model-decided when no schema is given), so — same as
    // `generatedJson` above — it's a passthrough object, not a fixed schema.
    structuredData: {
      type: coda.ValueType.Object,
      properties: {},
      includeUnknownProperties: true,
    },
    error: {type: coda.ValueType.String},
  },
  displayProperty: "id",
  idProperty: "id",
});

// `map` and `crawl` responses (MapResult / CrawlResult in client.ts) are
// fully typed there, field-for-field, so — like the three schemas above —
// they get a real Coda object schema rather than a JSON passthrough string.
const MapResultSchema = coda.makeObjectSchema({
  properties: {
    id: {type: coda.ValueType.String, required: true},
    url: {type: coda.ValueType.String, required: true},
    status: {type: coda.ValueType.String},
    links: {type: coda.ValueType.Array, items: {type: coda.ValueType.String}},
    totalLinks: {type: coda.ValueType.Number},
    externalLinks: {type: coda.ValueType.Array, items: {type: coda.ValueType.String}},
    totalExternalLinks: {type: coda.ValueType.Number},
    durationMs: {type: coda.ValueType.Number},
    error: {type: coda.ValueType.String},
  },
  displayProperty: "url",
  idProperty: "id",
});

const CrawlPageSchema = coda.makeObjectSchema({
  properties: {
    url: {type: coda.ValueType.String, required: true},
    status: {type: coda.ValueType.String, required: true},
    markdown: {type: coda.ValueType.String},
    html: {type: coda.ValueType.String},
    durationMs: {type: coda.ValueType.Number},
    error: {type: coda.ValueType.String},
  },
  displayProperty: "url",
});

const CrawlResultSchema = coda.makeObjectSchema({
  properties: {
    id: {type: coda.ValueType.String, required: true},
    url: {type: coda.ValueType.String, required: true},
    status: {type: coda.ValueType.String},
    totalPages: {type: coda.ValueType.Number},
    completedPages: {type: coda.ValueType.Number},
    pages: {type: coda.ValueType.Array, items: CrawlPageSchema},
    durationMs: {type: coda.ValueType.Number},
    error: {type: coda.ValueType.String},
  },
  displayProperty: "url",
  idProperty: "id",
});

// Everything else added below (Wire's catalog/discovery/identities/login/
// build, all four monitor endpoints, AI-visibility sources, and the session
// tools) has a response shape that Anakin's own reference client
// (anakin-mcp/src/client.ts) itself types as `Promise<unknown>` or
// `Promise<Record<string, unknown>>` — i.e. genuinely not part of a
// documented, field-level contract anywhere this Pack can verify against.
// Rather than fabricate a Coda object schema for those and risk silently
// wrong field names (explicitly out of bounds for this task), those
// formulas return the raw JSON response as a string; wrap the result in
// Coda's `ParseJSON()` to pull out specific fields. `wire_read_action` /
// `wire_write_action` follow the same rule for the same reason — their
// `WireJobStatus` type in client.ts carries a `[key: string]: unknown`
// index signature, the source's own admission that the shape can vary by
// action.

// ─── Formulas ────────────────────────────────────────────────────────────
//
// isAction rule, applied consistently across all sixteen formulas added in
// this revision as well as the original three: `isAction: true` for any
// formula that (a) spends real Anakin credits, (b) mutates state on
// Anakin's side (creates/pauses/deletes a monitor, deletes a session, signs
// in, requests a new Wire action build), or (c) both. Per the SDK's own
// docs (guides/blocks/formulas.md, "Caching" + "Recalculation" sections;
// guides/blocks/actions.md, "Caching & recalculation" section) calculation
// formulas are cached but can still be silently recalculated by the
// platform "periodically for other reasons including routine maintenance."
// Action formulas are documented as "never cached or automatically
// recalculated" and only run on explicit button press / automation trigger
// / manual formula re-run — the only safe default for a metered API.
//
// The converse also holds deliberately: formulas that only ever GET static
// or account-scoped metadata with no side effect and no confirmed cost —
// Wire's catalog/discovery/identities, monitor list/changes, AI-visibility
// sources, session list — are left as plain calculation formulas. Coda
// silently recalculating one of those just means slightly-stale read data
// re-fetched for free, the same tradeoff the SDK's own reference Packs
// (examples/github/pack.ts's "GetIssue") accept for read endpoints; forcing
// isAction on every single formula would just make read-only lookups
// require a manual button press for no safety benefit.
//
// One inference, not a confirmed fact, worth flagging explicitly: `map` and
// `crawl` are marked isAction on the assumption that they're billed like
// `url-scraper` (same resource class — proxied/browser-rendered page
// fetches) — neither anakin-mcp's tool descriptions nor client.ts state a
// credit cost for either the way they do for `wire_read_action` ("credit
// cost" in discovery), `monitor_create` ("2 credits/check"), or
// `ai_visibility_search` ("billed per source"). If they turn out to be
// free, isAction is still the more conservative, defensible default for a
// multi-page site fetch hitting Anakin's proxy infrastructure — just not
// provably required by a credit cost the way the other nine are.

pack.addFormula({
  name: "ScrapeUrl",
  description:
    "Scrape a URL with Anakin and return clean markdown (and, optionally, " +
    "AI-extracted structured JSON). Submits the scrape job and polls until " +
    "it completes or fails.",
  isAction: true,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "url",
      description: "The full URL of the page to scrape.",
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "country",
      description: "Proxy country code, e.g. us, gb, de. Defaults to us.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Boolean,
      name: "useBrowser",
      description: "Use a headless browser — best for JS-heavy sites. Defaults to false.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Boolean,
      name: "generateJson",
      description: "AI-extract structured JSON from the page content in addition to markdown. Defaults to false.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Boolean,
      name: "forceFresh",
      description: "Bypass the cache and force a fresh extraction. Defaults to false.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "sessionId",
      description: "Reuse a previously saved browser session (see Anakin's session dashboard) instead of a fresh anonymous browser context.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "sessionName",
      description: "Same as sessionId, but looked up by name instead of ID.",
      optional: true,
    }),
  ],
  resultType: coda.ValueType.Object,
  schema: ScrapeResultSchema,
  execute: async function (
    [url, country = "us", useBrowser = false, generateJson = false, forceFresh = false, sessionId, sessionName],
    context,
  ) {
    const body: Record<string, unknown> = {
      url,
      country,
      useBrowser,
      generateJson,
      forceFresh,
    };
    if (sessionId) body.sessionId = sessionId;
    if (sessionName) body.sessionName = sessionName;

    const submitted = await context.fetcher.fetch({
      method: "POST",
      url: `${BASE_URL}/url-scraper`,
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    });
    const jobId = submitted.body.jobId;
    if (!jobId) {
      throw new coda.UserVisibleError(
        "Anakin's scrape submission response did not include a jobId — " +
          "this usually means an API/Pack version mismatch.",
      );
    }

    const job = await pollJob(context, "/url-scraper", jobId);
    assertJobSucceeded(job, "scrape");
    return job;
  },
});

pack.addFormula({
  name: "Search",
  description:
    "AI-powered web search with citations. Synchronous — returns directly, " +
    "no polling. Costs 3 credits per call.",
  isAction: true,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "prompt",
      description: "The search query or question.",
    }),
    coda.makeParameter({
      type: coda.ParameterType.Number,
      name: "limit",
      description: "Maximum number of results to return. Defaults to 5.",
      optional: true,
    }),
  ],
  resultType: coda.ValueType.Object,
  schema: SearchResultSchema,
  execute: async function ([prompt, limit = 5], context) {
    const response = await context.fetcher.fetch({
      method: "POST",
      url: `${BASE_URL}/search`,
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({prompt, limit}),
    });
    return response.body;
  },
});

pack.addFormula({
  name: "AgenticSearch",
  description:
    "Run Anakin's multi-stage AI research pipeline: search, scrape " +
    "citations, and extract structured data. Submits the job and polls " +
    "until it completes or fails. Costs 10 credits.",
  isAction: true,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "prompt",
      description: "The research question or topic.",
    }),
    coda.makeParameter({
      type: coda.ParameterType.Boolean,
      name: "useBrowser",
      description: "Use a headless browser when scraping citation pages. Defaults to true.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "schema",
      description:
        "Optional JSON Schema (as a JSON string) describing the structured " +
        "data to extract, e.g. {\"type\":\"object\",\"properties\":{...}}. " +
        "Coda formulas can't accept arbitrary objects as parameters, so " +
        "pass it JSON-encoded; it's parsed and forwarded as-is.",
      optional: true,
    }),
  ],
  resultType: coda.ValueType.Object,
  schema: AgenticSearchResultSchema,
  execute: async function ([prompt, useBrowser = true, schema], context) {
    const body: Record<string, unknown> = {prompt, useBrowser};
    if (schema) {
      try {
        body.schema = JSON.parse(schema);
      } catch (e: any) {
        throw new coda.UserVisibleError(
          `The schema parameter must be valid JSON: ${e.message}`,
        );
      }
    }

    const submitted = await context.fetcher.fetch({
      method: "POST",
      url: `${BASE_URL}/agentic-search`,
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    });
    const jobId = submitted.body.jobId;
    if (!jobId) {
      throw new coda.UserVisibleError(
        "Anakin's agentic-search submission response did not include a " +
          "jobId — this usually means an API/Pack version mismatch.",
      );
    }

    const job = await pollJob(context, "/agentic-search", jobId);
    assertJobSucceeded(job, "agentic-search");
    // Flatten `generatedJson.summary` / `generatedJson.structured_data`
    // (see anakin-py's AgenticSearchData model) up to the top level so the
    // Coda-side schema stays flat and easy to reference in formulas.
    return {
      id: job.id,
      status: job.status,
      cached: job.cached,
      durationMs: job.durationMs,
      summary: job.generatedJson?.summary,
      structuredData: job.generatedJson?.structured_data,
      error: job.error,
    };
  },
});

pack.addFormula({
  name: "MapSite",
  description:
    "Discover all reachable URLs under a site — internal links, external " +
    "links, and counts — without fetching page content. Useful for " +
    "understanding a domain's structure before crawling. Submits the map " +
    "job and polls until it completes or fails.",
  isAction: true,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "url",
      description: "The starting URL for discovery (typically a homepage or section root).",
    }),
    coda.makeParameter({
      type: coda.ParameterType.Number,
      name: "limit",
      description: "Maximum number of URLs to return overall. Defaults to 100.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Number,
      name: "depth",
      description: "How many link-hops from the starting URL to follow. Defaults to 2.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Number,
      name: "limitPerLevel",
      description: "Maximum URLs collected per depth level. Defaults to 100.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Boolean,
      name: "includeSubdomains",
      description: "Include URLs on subdomains of the starting host. Defaults to false.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Boolean,
      name: "includeExternalLinks",
      description: "Also collect (but do not follow) external links. Defaults to false.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Boolean,
      name: "useBrowser",
      description: "Render with a headless browser — best for JS-heavy sites. Defaults to false.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "search",
      description: "Optional keyword filter — only return URLs whose path/title matches.",
      optional: true,
    }),
  ],
  resultType: coda.ValueType.Object,
  schema: MapResultSchema,
  execute: async function (
    [
      url,
      limit = 100,
      depth = 2,
      limitPerLevel = 100,
      includeSubdomains = false,
      includeExternalLinks = false,
      useBrowser = false,
      search,
    ],
    context,
  ) {
    const body: Record<string, unknown> = {
      url,
      limit,
      depth,
      limitPerLevel,
      includeSubdomains,
      includeExternalLinks,
      useBrowser,
    };
    if (search) body.search = search;

    const submitted = await context.fetcher.fetch({
      method: "POST",
      url: `${BASE_URL}/map`,
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    });
    const jobId = submitted.body.jobId;
    if (!jobId) {
      throw new coda.UserVisibleError(
        "Anakin's map submission response did not include a jobId — this " +
          "usually means an API/Pack version mismatch.",
      );
    }

    const job = await pollJob(context, "/map", jobId);
    assertJobSucceeded(job, "map");
    return job;
  },
});

pack.addFormula({
  name: "CrawlSite",
  description:
    "Bulk-fetch markdown across a site — use for catalog ingestion or " +
    "building a site-wide RAG corpus. Submits the crawl job and polls " +
    "until it completes or fails. Large maxPages values risk exceeding " +
    "Coda's ~60s formula ceiling (see the Polling comment near the top " +
    "of this file) — keep it modest, or re-run if it times out.",
  isAction: true,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "url",
      description: "Starting URL.",
    }),
    coda.makeParameter({
      type: coda.ParameterType.Number,
      name: "maxPages",
      description: "Hard cap on pages fetched. Defaults to 10.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Number,
      name: "depth",
      description: "Link-hops from the starting URL to follow. Defaults to 1.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "country",
      description: "Two-letter proxy egress country code. Defaults to us.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.Boolean,
      name: "useBrowser",
      description: "Render each page in a headless browser — for JS-heavy/SPA sites. Defaults to false.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.StringArray,
      name: "includePatterns",
      description: "Glob/regex patterns — only URLs matching at least one are fetched.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.StringArray,
      name: "excludePatterns",
      description: "Glob/regex patterns — URLs matching any are skipped.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "sessionId",
      description: "Reuse a previously saved browser session instead of a fresh anonymous browser context.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "sessionName",
      description: "Same as sessionId, but looked up by name instead of ID.",
      optional: true,
    }),
  ],
  resultType: coda.ValueType.Object,
  schema: CrawlResultSchema,
  execute: async function (
    [url, maxPages = 10, depth = 1, country = "us", useBrowser = false, includePatterns, excludePatterns, sessionId, sessionName],
    context,
  ) {
    const body: Record<string, unknown> = {url, maxPages, depth, country, useBrowser};
    if (includePatterns && includePatterns.length > 0) body.includePatterns = includePatterns;
    if (excludePatterns && excludePatterns.length > 0) body.excludePatterns = excludePatterns;
    if (sessionId) body.sessionId = sessionId;
    if (sessionName) body.sessionName = sessionName;

    const submitted = await context.fetcher.fetch({
      method: "POST",
      url: `${BASE_URL}/crawl`,
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    });
    const jobId = submitted.body.jobId;
    if (!jobId) {
      throw new coda.UserVisibleError(
        "Anakin's crawl submission response did not include a jobId — " +
          "this usually means an API/Pack version mismatch.",
      );
    }

    const job = await pollJob(context, "/crawl", jobId);
    assertJobSucceeded(job, "crawl");
    return job;
  },
});

// ─── Wire ────────────────────────────────────────────────────────────────
//
// Wire is Anakin's catalog of pre-built automation actions across hundreds
// of sites (Amazon, Walmart, LinkedIn, Airbnb, Zillow, …). The natural
// agent loop — discover an action, run it, and only for auth-required
// actions supply a credential — maps to seven formulas here, split the
// same way anakin-mcp's own tool set splits them (see its src/tools/
// wire.ts comment): a mandatory read/write split for the two execution
// formulas, since Coda formulas have no equivalent of MCP's readOnlyHint/
// destructiveHint annotations to signal that distinction another way —
// the split itself is what lets WireReadAction stay a normal action
// formula while WireWriteAction's description calls out that it changes
// state on a third-party site.

pack.addFormula({
  name: "WireDiscover",
  description:
    "Find Wire actions for a task from a natural-language intent, e.g. " +
    '"top phones on walmart" or "a linkedin profile\'s work history". ' +
    "Returns ranked candidate actions with their action_id, type " +
    "(read/write), required/optional params, credit cost, and whether " +
    "auth is needed. Run a returned action with WireReadAction or " +
    "WireWriteAction depending on its type. Synchronous, no polling.",
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "q",
      description: "The intent in natural language.",
    }),
    coda.makeParameter({
      type: coda.ParameterType.Number,
      name: "limit",
      description: "Maximum number of candidate actions to return. Defaults to 5.",
      optional: true,
    }),
  ],
  resultType: coda.ValueType.String,
  execute: async function ([q, limit], context) {
    const response = await context.fetcher.fetch({
      method: "GET",
      url: `${BASE_URL}${withQuery("/wire/resolve", {q, limit})}`,
    });
    return JSON.stringify(response.body);
  },
});

pack.addFormula({
  name: "WireCatalog",
  description:
    "Browse the Wire catalog. With no slug, lists every supported " +
    "website and its action count. Pass a slug (e.g. \"walmart\", " +
    '"amazon", "linkedin") to get that site\'s full action list with ' +
    "exact parameter schemas, each action's type, auth mode, and credit " +
    "cost. Synchronous, no polling.",
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "slug",
      description: "Catalog slug to inspect. Omit to list all catalogs.",
      optional: true,
    }),
  ],
  resultType: coda.ValueType.String,
  execute: async function ([slug], context) {
    const path = slug ? `/wire/catalog/${encodeURIComponent(slug)}` : "/wire/catalog";
    const response = await context.fetcher.fetch({
      method: "GET",
      url: `${BASE_URL}${path}`,
    });
    return JSON.stringify(response.body);
  },
});

// Shared description text + execution path for WireReadAction /
// WireWriteAction. The parameter list itself is duplicated (not factored
// into a shared function) below in each `addFormula` call: `parameters`
// needs a tuple type (`[ParamDef, ...ParamDef[]]`), which a function
// returning `ParamDef[]` doesn't produce — TypeScript widens the return
// type to a plain array, which `addFormula` then rejects.
const WIRE_ACTION_ID_DESCRIPTION =
  'The action to run (from WireDiscover / WireCatalog), e.g. "walmart.search_products".';
const WIRE_ACTION_PARAMS_DESCRIPTION =
  "The action's input parameters, JSON-encoded (e.g. " +
  '\'{"query":"laptop"}\'​) — shape depends on the action; use ' +
  "its parameter schema from WireDiscover/WireCatalog. Coda " +
  "formulas can't accept arbitrary objects as parameters, so pass " +
  "JSON text; it's parsed and forwarded as-is. Omit for actions " +
  "that take none.";
const WIRE_ACTION_CREDENTIAL_ID_DESCRIPTION =
  'Required when the action\'s auth_mode is "required"; honored ' +
  'when "optional"; ignored when "none". Get one from ' +
  "WireIdentities or WireLogin.";
const WIRE_ACTION_IDENTITY_ID_DESCRIPTION =
  "Optional identity selector — the server resolves a credential from it (alternative to credentialId).";

async function runWireAction(
  actionId: string,
  paramsJson: string | undefined,
  credentialId: string | undefined,
  identityId: string | undefined,
  context: coda.ExecutionContext,
): Promise<string> {
  const parsedParams = parseJsonParam(paramsJson, "params");
  const params = (parsedParams ?? {}) as Record<string, unknown>;
  const body: Record<string, unknown> = {action_id: actionId};
  if (Object.keys(params).length > 0) body.params = params;
  if (credentialId) body.credential_id = credentialId;
  if (identityId) body.identity_id = identityId;

  const submitted = await context.fetcher.fetch({
    method: "POST",
    url: `${BASE_URL}/wire/task`,
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body),
  });

  const jobId = submitted.body.job_id;
  if (!jobId) {
    // Sync action: terminal data came back inline, same as client.ts's
    // `wireRun` — nothing to poll.
    return JSON.stringify(submitted.body);
  }

  const job = await pollJob(context, "/wire/jobs", jobId);
  assertWireJobSucceeded(job, actionId);
  return JSON.stringify(job);
}

pack.addFormula({
  name: "WireReadAction",
  description:
    'Run a Wire READ action — one whose type is "read" (extracts data, ' +
    "does not change state on the target site): search listings, fetch " +
    "a category's products, get a product's price/specs/reviews, read a " +
    "profile, pull dashboard metrics. Discover action_ids first with " +
    "WireDiscover or WireCatalog and confirm the action's type is " +
    '"read". Submits the task and polls the job until it completes or ' +
    'fails. For state-changing actions (type "write") use ' +
    "WireWriteAction instead.",
  isAction: true,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "actionId",
      description: WIRE_ACTION_ID_DESCRIPTION,
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "params",
      description: WIRE_ACTION_PARAMS_DESCRIPTION,
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "credentialId",
      description: WIRE_ACTION_CREDENTIAL_ID_DESCRIPTION,
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "identityId",
      description: WIRE_ACTION_IDENTITY_ID_DESCRIPTION,
      optional: true,
    }),
  ],
  resultType: coda.ValueType.String,
  execute: async function ([actionId, params, credentialId, identityId], context) {
    return runWireAction(actionId, params, credentialId, identityId, context);
  },
});

pack.addFormula({
  name: "WireWriteAction",
  description:
    'Run a Wire WRITE action — one whose type is "write" (performs a ' +
    "state-changing interaction on the target site): submit a form, add " +
    "an item to a cart, post or send content, update account settings. " +
    "Discover action_ids first with WireDiscover or WireCatalog and " +
    'confirm the action\'s type is "write". Most write actions need ' +
    "auth — pass a credentialId from WireIdentities or WireLogin. " +
    "Submits the task and polls the job until it completes or fails. " +
    "This formula, unlike anakin-mcp's own wire_write_action tool, does " +
    "not apply anakin-mcp's client-side policy filter against financial/" +
    "payment actions (that filter lives in the MCP server's compliance " +
    "layer, not in Anakin's REST API) — it will run any write action the " +
    "API accepts, exactly as calling the API directly would. For " +
    'read-only extraction (type "read") use WireReadAction instead.',
  isAction: true,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "actionId",
      description: WIRE_ACTION_ID_DESCRIPTION,
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "params",
      description: WIRE_ACTION_PARAMS_DESCRIPTION,
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "credentialId",
      description: WIRE_ACTION_CREDENTIAL_ID_DESCRIPTION,
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "identityId",
      description: WIRE_ACTION_IDENTITY_ID_DESCRIPTION,
      optional: true,
    }),
  ],
  resultType: coda.ValueType.String,
  execute: async function ([actionId, params, credentialId, identityId], context) {
    return runWireAction(actionId, params, credentialId, identityId, context);
  },
});

pack.addFormula({
  name: "WireIdentities",
  description:
    "List your saved Wire identities and their credentials. An identity " +
    "is a named account on a site; each credential's id is the " +
    "credentialId you pass to WireReadAction / WireWriteAction to run " +
    'actions whose auth_mode is "required". Optionally filter by ' +
    "catalogId. Synchronous, no polling.",
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "catalogId",
      description: "Optional — restrict to identities for a single catalog.",
      optional: true,
    }),
  ],
  resultType: coda.ValueType.String,
  execute: async function ([catalogId], context) {
    const response = await context.fetcher.fetch({
      method: "GET",
      url: `${BASE_URL}${withQuery("/wire/identities", {catalog_id: catalogId})}`,
    });
    return JSON.stringify(response.body);
  },
});

pack.addFormula({
  name: "WireLogin",
  description:
    "Sign in to a credentials-mode Wire site and get a credentialId " +
    "usable immediately with WireReadAction / WireWriteAction. Provide " +
    "the catalog slug and login params (the fields that catalog's login " +
    "schema defines, e.g. email/password — see WireCatalog's " +
    "login_input_schema). The password is never stored by Anakin, only " +
    "the encrypted session — it does still pass through this formula " +
    "call as plain text in the request body, the same as any " +
    "credential-bearing POST made from a Coda formula. Only needed for " +
    'actions whose auth_mode is "required" on catalogs that support ' +
    "password sign-in; cookie-based sites use the Anakin dashboard " +
    "connect flow instead, which this Pack cannot drive.",
  isAction: true,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "catalogSlug",
      description: 'The catalog to sign in to, e.g. "neb".',
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "params",
      description:
        "Login fields defined by the catalog (e.g. " +
        '\'{"email":"...","password":"..."}\'), JSON-encoded. Use ' +
        "WireCatalog's login_input_schema to learn the field names.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "identityName",
      description: "Optional name for the identity. Derived from params in password mode; required when using a 1Password locator.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "sourceId",
      description: "Optional 1Password identity-source ID (alternative to params).",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "sourceRef",
      description: "Optional 1Password item locator, JSON-encoded ({vault_id, item_id, fields}) — use with sourceId instead of params.",
      optional: true,
    }),
  ],
  resultType: coda.ValueType.String,
  execute: async function ([catalogSlug, params, identityName, sourceId, sourceRef], context) {
    const body: Record<string, unknown> = {catalog_slug: catalogSlug};
    const parsedParams = parseJsonParam(params, "params");
    if (parsedParams !== undefined) body.params = parsedParams;
    if (identityName) body.identity_name = identityName;
    if (sourceId) body.source_id = sourceId;
    const parsedSourceRef = parseJsonParam(sourceRef, "sourceRef");
    if (parsedSourceRef !== undefined) body.source_ref = parsedSourceRef;

    const response = await context.fetcher.fetch({
      method: "POST",
      url: `${BASE_URL}/wire/login`,
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    });
    return JSON.stringify(response.body);
  },
});

pack.addFormula({
  name: "WireBuild",
  description:
    "Request a brand-new Wire action for a website that isn't in the " +
    "catalog yet. Describe the site (websiteUrl) and what the action " +
    "should do or extract (goal); Wire generates and auto-tests a " +
    'scraper, then publishes it. Returns immediately with a "pending" ' +
    "status — the build itself runs asynchronously server-side with no " +
    "job endpoint this Pack can poll, so this formula does not wait for " +
    "it to finish. Charges credits, refunded automatically if the build " +
    "fails. Only use after WireDiscover / WireCatalog confirm no " +
    "existing action covers the site.",
  isAction: true,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "websiteUrl",
      description: "The site to build an action for. The domain is extracted automatically.",
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "goal",
      description: "Natural-language description of what the action should do or extract. Be specific.",
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "catalogId",
      description: "Optional — attach to an existing catalog instead of creating one.",
      optional: true,
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "visibility",
      description: "Action visibility. Defaults to private.",
      optional: true,
      autocomplete: ["private", "public"],
    }),
    coda.makeParameter({
      type: coda.ParameterType.Boolean,
      name: "force",
      description: "Build even if similar actions already exist for the domain (otherwise rejected with ACTION_EXISTS). Defaults to false.",
      optional: true,
    }),
  ],
  resultType: coda.ValueType.String,
  execute: async function ([websiteUrl, goal, catalogId, visibility, force = false], context) {
    const body: Record<string, unknown> = {website_url: websiteUrl, goal};
    if (catalogId) body.catalog_id = catalogId;
    if (visibility === "private" || visibility === "public") body.visibility = visibility;
    body.force = force;

    const response = await context.fetcher.fetch({
      method: "POST",
      url: `${BASE_URL}/wire/build-request`,
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    });
    return JSON.stringify(response.body);
  },
});

// ─── Website Monitoring ────────────────────────────────────────────────
//
// Monitors watch a URL (or a whole site, or a Wire action's JSON) on a
// schedule and record a change whenever the content differs — optionally
// alerting a webhook/email. MonitorCreate and MonitorControl mutate
// standing, billed, recurring state (see the isAction rule above) and are
// isAction; MonitorList / MonitorChanges are read-only.

pack.addFormula({
  name: "MonitorCreate",
  description:
    "Create a scheduled website monitor that checks a URL every " +
    "intervalMinutes (min 15) and records a change when the content " +
    'differs — optionally alerting a webhook or email. scope "page" ' +
    '(default) watches one URL; "site" crawls the site each run and ' +
    'tracks pages added/removed/changed; "wire" runs a Wire action ' +
    'each check and diffs its JSON. watchMode "full_page" (2 ' +
    'credits/check) compares the whole page; "specific_data" (3 ' +
    "credits/check) extracts only the fields in outputSchema with AI. " +
    "aiMode (+1 credit/check) filters out trivial noise and summarizes " +
    "real changes. Synchronous — returns the created monitor directly, " +
    "no polling. Active-monitor caps per plan: Free 5, Pro 20, Scale 100.",
  isAction: true,
  parameters: [
    coda.makeParameter({type: coda.ParameterType.String, name: "url", description: "The URL to watch (root URL for site scope; the Wire site's URL for wire scope)."}),
    coda.makeParameter({type: coda.ParameterType.Number, name: "intervalMinutes", description: "Check frequency in minutes. Minimum 15."}),
    coda.makeParameter({type: coda.ParameterType.String, name: "scope", description: "What to monitor: one page (default), a whole site, or a Wire action.", optional: true, autocomplete: ["page", "site", "wire"]}),
    coda.makeParameter({type: coda.ParameterType.String, name: "watchMode", description: "Compare the whole page (default) or only the fields in outputSchema, extracted with AI.", optional: true, autocomplete: ["full_page", "specific_data"]}),
    coda.makeParameter({type: coda.ParameterType.String, name: "watchFormat", description: "Format compared in full_page mode. Defaults to markdown.", optional: true, autocomplete: ["markdown", "html", "cleaned_html"]}),
    coda.makeParameter({type: coda.ParameterType.String, name: "outputSchema", description: "JSON Schema (JSON-encoded string) of the fields to track. Required when watchMode is specific_data.", optional: true}),
    coda.makeParameter({type: coda.ParameterType.Boolean, name: "aiMode", description: "AI meaningful-change filtering: ignores trivial noise and summarizes real changes. +1 credit/check. Defaults to false.", optional: true}),
    coda.makeParameter({type: coda.ParameterType.String, name: "aiGoal", description: "Natural-language description of which changes count as meaningful (used with aiMode).", optional: true}),
    coda.makeParameter({type: coda.ParameterType.Boolean, name: "useBrowser", description: "Render checks with a stealth headless browser. Forced true when sessionId is set. Defaults to false.", optional: true}),
    coda.makeParameter({type: coda.ParameterType.String, name: "country", description: "Two-letter proxy country code. Defaults to us.", optional: true}),
    coda.makeParameter({type: coda.ParameterType.String, name: "sessionId", description: "Saved browser-session ID for monitoring login-protected pages (see SessionList).", optional: true}),
    coda.makeParameter({type: coda.ParameterType.Boolean, name: "isActive", description: "Start running immediately. Defaults to true.", optional: true}),
    coda.makeParameter({type: coda.ParameterType.String, name: "expiresAt", description: "Optional end date (ISO 8601 timestamp or YYYY-MM-DD); the monitor auto-pauses when it passes.", optional: true}),
    coda.makeParameter({type: coda.ParameterType.String, name: "alertWebhookUrl", description: "Webhook URL that receives signed change alerts.", optional: true}),
    coda.makeParameter({type: coda.ParameterType.String, name: "alertEmails", description: "Comma-separated email recipients for change alerts.", optional: true}),
    coda.makeParameter({type: coda.ParameterType.Number, name: "maxPages", description: "Site scope: max pages crawled per run.", optional: true}),
    coda.makeParameter({type: coda.ParameterType.Number, name: "maxDepth", description: "Site scope: crawl depth (1-5). Defaults to 2.", optional: true}),
    coda.makeParameter({type: coda.ParameterType.StringArray, name: "includePatterns", description: "Site scope: glob patterns or hand-picked same-site URLs to track.", optional: true}),
    coda.makeParameter({type: coda.ParameterType.StringArray, name: "excludePatterns", description: "Site scope: glob patterns to skip.", optional: true}),
    coda.makeParameter({type: coda.ParameterType.String, name: "wireActionId", description: 'Wire scope (required there): the Wire action run each check, e.g. "amazon.search_products".', optional: true}),
    coda.makeParameter({type: coda.ParameterType.String, name: "wireCatalogSlug", description: "Wire scope: catalog slug of the Wire site.", optional: true}),
    coda.makeParameter({type: coda.ParameterType.String, name: "wireCredentialId", description: "Wire scope: credential ID when the action needs auth (see WireIdentities).", optional: true}),
    coda.makeParameter({type: coda.ParameterType.String, name: "wireParams", description: "Wire scope: parameters passed to the action each check, JSON-encoded.", optional: true}),
    coda.makeParameter({type: coda.ParameterType.StringArray, name: "wireWatchPaths", description: "Wire scope: JSON paths to diff instead of the whole response.", optional: true}),
  ],
  resultType: coda.ValueType.String,
  execute: async function (
    [
      url,
      intervalMinutes,
      scope,
      watchMode,
      watchFormat,
      outputSchema,
      aiMode,
      aiGoal,
      useBrowser,
      country,
      sessionId,
      isActive,
      expiresAt,
      alertWebhookUrl,
      alertEmails,
      maxPages,
      maxDepth,
      includePatterns,
      excludePatterns,
      wireActionId,
      wireCatalogSlug,
      wireCredentialId,
      wireParams,
      wireWatchPaths,
    ],
    context,
  ) {
    const body: Record<string, unknown> = {url, intervalMinutes};
    if (scope !== undefined) body.scope = scope;
    if (watchMode !== undefined) body.watchMode = watchMode;
    if (watchFormat !== undefined) body.watchFormat = watchFormat;
    const parsedOutputSchema = parseJsonParam(outputSchema, "outputSchema");
    if (parsedOutputSchema !== undefined) body.outputSchema = parsedOutputSchema;
    if (aiMode !== undefined) body.aiMode = aiMode;
    if (aiGoal !== undefined) body.aiGoal = aiGoal;
    if (useBrowser !== undefined) body.useBrowser = useBrowser;
    if (country !== undefined) body.country = country;
    if (sessionId !== undefined) body.sessionId = sessionId;
    if (isActive !== undefined) body.isActive = isActive;
    if (expiresAt !== undefined) body.expiresAt = expiresAt;
    if (alertWebhookUrl !== undefined) body.alertWebhookUrl = alertWebhookUrl;
    if (alertEmails !== undefined) body.alertEmails = alertEmails;
    if (maxPages !== undefined) body.maxPages = maxPages;
    if (maxDepth !== undefined) body.maxDepth = maxDepth;
    if (includePatterns && includePatterns.length > 0) body.includePatterns = includePatterns;
    if (excludePatterns && excludePatterns.length > 0) body.excludePatterns = excludePatterns;
    if (wireActionId !== undefined) body.wireActionId = wireActionId;
    if (wireCatalogSlug !== undefined) body.wireCatalogSlug = wireCatalogSlug;
    if (wireCredentialId !== undefined) body.wireCredentialId = wireCredentialId;
    const parsedWireParams = parseJsonParam(wireParams, "wireParams");
    if (parsedWireParams !== undefined) body.wireParams = parsedWireParams;
    if (wireWatchPaths && wireWatchPaths.length > 0) body.wireWatchPaths = wireWatchPaths;

    const response = await context.fetcher.fetch({
      method: "POST",
      url: `${BASE_URL}/monitors`,
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    });
    return JSON.stringify(redactMonitorSecrets(response.body));
  },
});

pack.addFormula({
  name: "MonitorList",
  description:
    "List your website monitors, or pass id to fetch one monitor's full " +
    "configuration and status (next/last check time, active state, " +
    "per-check credit cost, alert settings). Synchronous, no polling.",
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "id",
      description: "Monitor ID — fetch just this monitor instead of the full list.",
      optional: true,
    }),
  ],
  resultType: coda.ValueType.String,
  execute: async function ([id], context) {
    const path = id ? `/monitors/${encodeURIComponent(id)}` : "/monitors";
    const response = await context.fetcher.fetch({method: "GET", url: `${BASE_URL}${path}`});
    return JSON.stringify(redactMonitorSecrets(response.body));
  },
});

pack.addFormula({
  name: "MonitorChanges",
  description:
    "Get the detected changes for a monitor — each entry records when " +
    "the watched content differed from the previous check, with a diff/" +
    "summary (and the AI change summary when aiMode is on). Use " +
    "MonitorList first to find the monitor id. Synchronous, no polling.",
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "id",
      description: "The monitor ID (from MonitorList or MonitorCreate).",
    }),
  ],
  resultType: coda.ValueType.String,
  execute: async function ([id], context) {
    const response = await context.fetcher.fetch({
      method: "GET",
      url: `${BASE_URL}/monitors/${encodeURIComponent(id)}/changes`,
    });
    return JSON.stringify(redactMonitorSecrets(response.body));
  },
});

pack.addFormula({
  name: "MonitorControl",
  description:
    'Control an existing website monitor: "pause" stops scheduled ' +
    'checks, "resume" restarts them (may hit the plan\'s active-monitor ' +
    'cap), "run_now" triggers an immediate out-of-schedule check ' +
    '(billed like a normal check), and "delete" permanently removes ' +
    "the monitor and its history. Use MonitorList to find the id.",
  isAction: true,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "id",
      description: "The monitor ID (from MonitorList or MonitorCreate).",
    }),
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "action",
      description: "What to do with the monitor.",
      autocomplete: ["pause", "resume", "run_now", "delete"],
    }),
  ],
  resultType: coda.ValueType.String,
  execute: async function ([id, action], context) {
    const base = `${BASE_URL}/monitors/${encodeURIComponent(id)}`;
    let response;
    switch (action) {
      case "pause":
        response = await context.fetcher.fetch({method: "POST", url: `${base}/pause`});
        break;
      case "resume":
        response = await context.fetcher.fetch({method: "POST", url: `${base}/resume`});
        break;
      case "run_now":
        response = await context.fetcher.fetch({method: "POST", url: `${base}/run`});
        break;
      case "delete":
        response = await context.fetcher.fetch({method: "DELETE", url: base});
        break;
      default:
        throw new coda.UserVisibleError(
          `Unknown monitor action "${action}" — use pause, resume, run_now, or delete.`,
        );
    }
    return JSON.stringify(redactMonitorSecrets(response.body ?? {}));
  },
});

// ─── AI Visibility ──────────────────────────────────────────────────────
//
// Only the sources lookup is covered here — see the "Deliberately not
// covered" block near the end of this file for why ai-visibility-search
// itself is excluded.

pack.addFormula({
  name: "AiVisibilitySources",
  description:
    "List the AI answer engines available to Anakin's ai-visibility-" +
    "search endpoint (not itself exposed by this Pack — see README.md) " +
    "— each with its slug and display label. Synchronous, no polling.",
  parameters: [],
  resultType: coda.ValueType.String,
  execute: async function ([], context) {
    const response = await context.fetcher.fetch({
      method: "GET",
      url: `${BASE_URL}/ai-visibility/sources`,
    });
    return JSON.stringify(response.body);
  },
});

// ─── Browser Sessions ───────────────────────────────────────────────────
//
// Saved browser sessions are encrypted login states created via the
// Anakin dashboard, then reused for authenticated work — passed as
// sessionId to ScrapeUrl / CrawlSite / MonitorCreate. Creating one is an
// interactive noVNC flow the user completes themselves (2FA/captchas
// included) and has no REST endpoint to call from a Pack formula; only
// discovery (list) and cleanup (delete) are exposed here, matching
// anakin-mcp's own session tool set exactly.

pack.addFormula({
  name: "SessionList",
  description:
    "List your saved browser sessions. Each session's id is what you " +
    "pass as sessionId to ScrapeUrl, CrawlSite, or MonitorCreate to work " +
    "with login-protected pages. Optionally filter by website domain. " +
    "Synchronous, no polling.",
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "domain",
      description: 'Filter to sessions for one website domain, e.g. "amazon.com".',
      optional: true,
    }),
  ],
  resultType: coda.ValueType.String,
  execute: async function ([domain], context) {
    const response = await context.fetcher.fetch({
      method: "GET",
      url: `${BASE_URL}${withQuery("/sessions", {domain})}`,
    });
    return JSON.stringify(response.body);
  },
});

pack.addFormula({
  name: "SessionDelete",
  description:
    "Permanently delete a saved browser session and its encrypted login " +
    "data. Irreversible — logging in again requires the Anakin " +
    "dashboard, and any monitor or formula call referencing this " +
    "sessionId loses authenticated access. Find ids with SessionList.",
  isAction: true,
  parameters: [
    coda.makeParameter({
      type: coda.ParameterType.String,
      name: "id",
      description: "The session ID to delete (from SessionList).",
    }),
  ],
  resultType: coda.ValueType.String,
  execute: async function ([id], context) {
    const response = await context.fetcher.fetch({
      method: "DELETE",
      url: `${BASE_URL}/sessions/${encodeURIComponent(id)}`,
    });
    return JSON.stringify(response.body ?? {deleted: true, id});
  },
});

// ─── Deliberately not covered ───────────────────────────────────────────
//
// Two of Anakin's 21 REST capabilities are left out of this Pack, not
// overlooked:
//
// ai-visibility-search (POST /ai-visibility/search, poll GET
// /ai-visibility/search/:search_id) — the fan-out-to-multiple-AI-engines
// endpoint. anakin-mcp's own tool description for it states completion is
// "typically within 1–2 minutes" — i.e. AT OR PAST Coda's ~60s formula
// ceiling on the *common* case, not just a slow tail the way a
// single-page ScrapeUrl or a targeted WireReadAction might occasionally
// run long. Unlike ScrapeUrl, there's no `cached` field on
// AIVisibilitySearch (client.ts) to make a timed-out re-run cheap and
// fast the way a second ScrapeUrl call against the same URL is — every
// re-run here resubmits a brand-new, full-price, multi-engine search.
// Shipping it with the same bounded-poll pattern as the other async
// formulas in this file would mean a formula that reliably times out and
// burns credits on retry for its primary use case, not an occasional edge
// case. Excluded.
//
// browser-task (POST /ai/evaluate, poll GET /ai/jobs/:id) — Anakin's
// natural-language AI browser automation endpoint. Not named in this
// task's ground-truth endpoint list, but present in anakin-mcp's own
// source (client.ts's `browserTask`, tools/browser-task.ts) as one of the
// 21 capabilities, so it's addressed here rather than silently skipped.
// client.ts's own comment states browser tasks are "hard-capped
// server-side at ~330s" and its polling budget is 6 minutes — a
// fundamentally different latency class than every other endpoint in
// this file, where the legitimate operating range (30s–330s) exceeds
// Coda's ~60s ceiling as the *norm*, not the exception. A bounded-poll
// Coda formula would be non-functional for real use, not just
// occasionally slow. Excluded.
//
// Both are better fits for the sync-table + continuation redesign already
// flagged as follow-on work in README.md's "Limitation" section — that
// mechanism has no execution-time ceiling the way a single addFormula
// `execute()` call does.
