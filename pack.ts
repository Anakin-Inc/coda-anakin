// Coda Pack for Anakin (https://anakin.io) — web scraping, AI-powered
// search, and multi-stage agentic research over hundreds of popular sites.
//
// Structure and syntax verified against the real @codahq/packs-sdk docs and
// the coda/packs-examples reference packs (examples/dictionary/pack.ts,
// examples/github/pack.ts) — see SUBMIT.md for exactly what was checked and
// where. Nothing here is guessed API surface.

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
// Two of Anakin's three endpoints covered here (url-scraper, agentic-search)
// are async: submit a job, then poll a second endpoint until it reaches a
// terminal `status` of "completed" or "failed". `/search` is synchronous
// and needs no polling.
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

// ─── Formulas ────────────────────────────────────────────────────────────
//
// All three are declared with `isAction: true` rather than as plain
// calculation formulas. This is a deliberate call, not the SDK default:
// every one of these calls costs real Anakin credits, and per the SDK's own
// docs (guides/blocks/formulas.md, "Caching" + "Recalculation" sections;
// guides/blocks/actions.md, "Caching & recalculation" section) calculation
// formulas are cached but can still be silently recalculated by the
// platform "periodically for other reasons including routine maintenance."
// Action formulas are documented as "never cached or automatically
// recalculated" and only run on explicit button press / automation trigger
// / manual formula re-run — the only safe default for a metered API.

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
