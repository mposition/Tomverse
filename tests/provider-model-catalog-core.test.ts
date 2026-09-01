import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_DISABLE_REASON,
  catalogNextCursor,
  isLikelyChatModelId,
  missingConfirmationRuns,
  parseProviderCatalogResponse,
  planCatalogReconciliation,
  providerCatalogHttpFailure,
  providerCatalogUrl,
  PROVIDER_CATALOG_KEY_REJECTED,
} from "../lib/providerModelCatalogCore.ts";
import {
  AI_PROVIDERS,
  PROVIDER_API_CONFIGURATION,
  PROVIDER_API_KEY_ENV_NAMES,
} from "../lib/modelRegistryShared.ts";

test("parses OpenAI-compatible model lists and excludes non-chat products", () => {
  assert.deepEqual(
    parseProviderCatalogResponse("openai", {
      data: [
        { id: "gpt-5.5", owned_by: "openai" },
        { id: "text-embedding-4-large", owned_by: "openai" },
        { id: "whisper-2", owned_by: "openai" },
      ],
    }).map((model) => model.id),
    ["gpt-5.5"]
  );
});

test("treats provider aliases as available model IDs", () => {
  const models = parseProviderCatalogResponse("xai", {
    models: [{ id: "grok-4.5-20260701", aliases: ["grok-4.5"] }],
  });
  assert.deepEqual(
    models.map((model) => model.id),
    ["grok-4.5-20260701", "grok-4.5"]
  );
  assert.equal(models[1].metadata.aliasOf, "grok-4.5-20260701");
});

test("uses Gemini base model IDs and only keeps generateContent models", () => {
  const models = parseProviderCatalogResponse("google", {
    models: [
      {
        name: "models/gemini-3.5-flash-001",
        baseModelId: "gemini-3.5-flash",
        displayName: "Gemini 3.5 Flash",
        supportedGenerationMethods: ["generateContent"],
        stage: "STABLE",
      },
      {
        name: "models/gemini-embedding-002",
        supportedGenerationMethods: ["embedContent"],
      },
    ],
  });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "gemini-3.5-flash");
  assert.equal(models[0].displayName, "Gemini 3.5 Flash");
});

test("preserves the exact 2026-08-01 provider API model strings", () => {
  const openaiCompatible = [
    ["openai", "gpt-5.6-sol"],
    ["xai", "grok-4.3"],
    ["deepseek", "deepseek-v4-flash"],
    ["mistral", "mistral-medium-3-5"],
  ] as const;

  for (const [provider, apiModel] of openaiCompatible) {
    const response =
      provider === "mistral"
        ? [{ id: apiModel, capabilities: { completion_chat: true } }]
        : { data: [{ id: apiModel }] };
    const parsed = parseProviderCatalogResponse(provider, response);
    assert.equal(parsed.some((entry) => entry.id === apiModel), true, provider);
  }

  const google = parseProviderCatalogResponse("google", {
    models: [
      {
        name: "models/gemini-3.6-flash",
        baseModelId: "gemini-3.6-flash",
        supportedGenerationMethods: ["generateContent"],
      },
      {
        name: "models/gemini-3.5-flash-lite",
        baseModelId: "gemini-3.5-flash-lite",
        supportedGenerationMethods: ["generateContent"],
      },
    ],
  });
  assert.deepEqual(
    google.map((entry) => entry.id),
    ["gemini-3.6-flash", "gemini-3.5-flash-lite"]
  );
});

test("marks explicit legacy and archived lifecycle states unavailable", () => {
  const google = parseProviderCatalogResponse("google", {
    models: [
      {
        name: "models/gemini-old",
        supportedGenerationMethods: ["generateContent"],
        stage: "LEGACY",
      },
    ],
  });
  const mistral = parseProviderCatalogResponse("mistral", [
    {
      id: "mistral-old",
      archived: true,
      capabilities: { completion_chat: true },
    },
  ]);
  assert.deepEqual(
    [google[0].lifecycle, google[0].available, mistral[0].lifecycle],
    ["legacy", false, "archived"]
  );
});

test("supports provider pagination cursors without accepting arbitrary values", () => {
  assert.equal(catalogNextCursor("google", { nextPageToken: "page-2" }), "page-2");
  assert.equal(
    catalogNextCursor("anthropic", { has_more: true, last_id: "claude-last" }),
    "claude-last"
  );
  assert.equal(
    catalogNextCursor("anthropic", { has_more: false, last_id: "ignored" }),
    null
  );
});

test("requires at least two successful missing scans before likely deprecation", () => {
  assert.equal(missingConfirmationRuns(undefined), 2);
  assert.equal(missingConfirmationRuns("1"), 2);
  assert.equal(missingConfirmationRuns("4"), 4);
  assert.equal(missingConfirmationRuns("99"), 2);
  assert.equal(isLikelyChatModelId("groq", "whisper-large-v3"), false);
  assert.equal(isLikelyChatModelId("groq", "llama-4-scout"), true);
});

// Reconciliation planning. The scenario these are written against is the real
// one: groq's llama-4-scout went missing from successful catalog scans on
// 2026-07-21, reached seven consecutive misses, and stayed enabled and
// user-selectable for six days because nothing consumed that signal.

const groqRegistry = [
  { id: "llama-3-1", apiModel: "llama-3.1-8b-instant", enabled: true, operationalReason: null },
  { id: "llama-3-3", apiModel: "llama-3.3-70b-versatile", enabled: true, operationalReason: null },
  { id: "llama-4-scout", apiModel: "meta-llama/llama-4-scout-17b-16e-instruct", enabled: true, operationalReason: null },
];

const groqCheck = (overrides = {}) => ({
  provider: "groq" as const,
  status: "checked" as const,
  missing: [],
  mapped: [],
  ...overrides,
});

test("plans a disable once a model clears the confirmation threshold", () => {
  const plan = planCatalogReconciliation({
    check: groqCheck({
      missing: [
        {
          modelId: "llama-4-scout",
          apiModel: "meta-llama/llama-4-scout-17b-16e-instruct",
          consecutiveMissing: 7,
        },
      ],
      mapped: ["llama-3-1", "llama-3-3"],
    }),
    registry: groqRegistry,
    confirmationRuns: 3,
  });
  assert.deepEqual(
    plan.disable.map((item) => item.modelId),
    ["llama-4-scout"]
  );
  assert.deepEqual(plan.hold, []);
  assert.deepEqual(plan.restore, []);
});

test("leaves a model alone until the confirmation threshold is reached", () => {
  const plan = planCatalogReconciliation({
    check: groqCheck({
      missing: [
        {
          modelId: "llama-4-scout",
          apiModel: "meta-llama/llama-4-scout-17b-16e-instruct",
          consecutiveMissing: 2,
        },
      ],
    }),
    registry: groqRegistry,
    confirmationRuns: 3,
  });
  assert.deepEqual(plan.disable, []);
});

test("acts on nothing when the provider check did not complete", () => {
  for (const status of ["failed", "skipped"] as const) {
    const plan = planCatalogReconciliation({
      check: groqCheck({
        status,
        missing: [
          {
            modelId: "llama-4-scout",
            apiModel: "meta-llama/llama-4-scout-17b-16e-instruct",
            consecutiveMissing: 99,
          },
        ],
      }),
      registry: groqRegistry,
      confirmationRuns: 3,
    });
    assert.deepEqual(plan.disable, [], `${status} must not disable anything`);
  }
});

test("refuses to disable a provider's entire enabled lineup in one run", () => {
  // Indistinguishable from a truncated catalog response, and only one of the
  // two readings should take a whole provider offline.
  const plan = planCatalogReconciliation({
    check: groqCheck({
      missing: groqRegistry.map((row) => ({
        modelId: row.id,
        apiModel: row.apiModel,
        consecutiveMissing: 9,
      })),
    }),
    registry: groqRegistry,
    confirmationRuns: 3,
  });
  assert.deepEqual(plan.disable, []);
  assert.equal(plan.hold.length, 1);
  assert.equal(plan.hold[0].reason, "would_disable_every_enabled_model");
  assert.deepEqual(plan.hold[0].modelIds.sort(), ["llama-3-1", "llama-3-3", "llama-4-scout"]);
});

test("restores only what this automation disabled", () => {
  const plan = planCatalogReconciliation({
    check: groqCheck({ mapped: ["llama-3-1", "llama-4-scout"] }),
    registry: [
      {
        id: "llama-3-1",
        apiModel: "llama-3.1-8b-instant",
        enabled: false,
        operationalReason: "Disabled by an operator pending a billing review.",
      },
      {
        id: "llama-4-scout",
        apiModel: "meta-llama/llama-4-scout-17b-16e-instruct",
        enabled: false,
        operationalReason: `${AUTO_DISABLE_REASON} Missing from 7 consecutive scans.`,
      },
    ],
    confirmationRuns: 3,
  });
  assert.deepEqual(
    plan.restore.map((item) => item.modelId),
    ["llama-4-scout"]
  );
});

/**
 * The regression these guard: the catalogue path used to be derived with a
 * two-provider special case and `models` for everyone else, which is only
 * correct when the base URL already ends in the version segment. Anthropic's
 * does not, so the monitor asked `https://api.anthropic.com/models` and got a
 * 404 every scan for a month. A 404 reads as "the provider dropped this
 * endpoint" rather than "we built the wrong URL", so nothing looked wrong.
 *
 * Every provider is pinned, not just Anthropic: the next base URL added with
 * no version segment has to fail here rather than in production.
 */
test("each provider's catalogue URL is the one that provider actually serves", () => {
  assert.deepEqual(
    Object.fromEntries(
      AI_PROVIDERS.map((provider) => [
        provider,
        providerCatalogUrl(provider, null).toString(),
      ])
    ),
    {
      openai: "https://api.openai.com/v1/models",
      anthropic: "https://api.anthropic.com/v1/models?limit=1000",
      google:
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
      groq: "https://api.groq.com/openai/v1/models",
      xai: "https://api.x.ai/v1/language-models",
      deepseek: "https://api.deepseek.com/models",
      mistral: "https://api.mistral.ai/v1/models",
      moonshot: "https://api.moonshot.ai/v1/models",
      minimax: "https://api.minimax.io/anthropic/v1/models?limit=1000",
      qwen: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
      zhipu: "https://api.z.ai/api/paas/v4/models",
      perplexity: "https://api.perplexity.ai/v1/models",
    }
  );
});

test("a catalogue URL never leaves its provider's configured base URL", () => {
  for (const provider of AI_PROVIDERS) {
    const base = new URL(PROVIDER_API_CONFIGURATION[provider].baseUrl);
    const url = providerCatalogUrl(provider, "cursor-value");
    assert.equal(url.origin, base.origin, provider);
    assert.ok(url.pathname.startsWith(base.pathname.replace(/\/$/, "")), provider);
  }
});

test("only the paginating providers carry a cursor, each in its own parameter", () => {
  assert.equal(
    providerCatalogUrl("anthropic", "model_123").searchParams.get("after_id"),
    "model_123"
  );
  assert.equal(
    providerCatalogUrl("minimax", "model_123").searchParams.get("after_id"),
    "model_123"
  );
  assert.equal(
    providerCatalogUrl("google", "page_2").searchParams.get("pageToken"),
    "page_2"
  );
  // An OpenAI-compatible list is a single response; a cursor would be a
  // parameter the provider ignores at best.
  assert.equal(
    providerCatalogUrl("openai", "page_2").search,
    ""
  );
});

// A refused credential is not a catalogue failure. Perplexity's model cycle
// reported `failed (PROVIDER_MODEL_CATALOG_HTTP_401)` while every Sonar chat
// turn was failing on the same key, and the status code said none of that.

test("a rejected credential is classified apart from every other HTTP failure", () => {
  for (const status of [401, 403]) {
    const failure = providerCatalogHttpFailure("perplexity", status);
    assert.equal(failure.code, PROVIDER_CATALOG_KEY_REJECTED);
    // The status is kept in the detail: an operator checking the claim needs
    // to know which of the two it was.
    assert.match(failure.detail, new RegExp(`HTTP ${status}`));
  }
});

test("every other failing status keeps the status in its code", () => {
  // 404 in particular has to stay distinguishable: it is the shape a dropped
  // endpoint takes, and a month of them is what put `v1/models` in
  // CATALOG_PATHS.
  for (const status of [404, 429, 500, 503]) {
    assert.equal(
      providerCatalogHttpFailure("anthropic", status).code,
      `PROVIDER_MODEL_CATALOG_HTTP_${status}`
    );
  }
});

test("a rejected credential names every accepted spelling of its key", () => {
  // Same reason PROVIDER_MODEL_CATALOG_KEY_MISSING does it: an operator sent
  // to the canonical variable rotates one the deployment is not reading.
  for (const provider of AI_PROVIDERS) {
    const detail = providerCatalogHttpFailure(provider, 401).detail;
    for (const name of PROVIDER_API_KEY_ENV_NAMES[provider]) {
      assert.ok(detail.includes(name), `${provider}: ${name} is not named`);
    }
  }
});

test("a rejected credential says the provider's chat traffic is failing too", () => {
  // The whole point of the separate code. A row that only reports a failed
  // scan reads as a reporting problem, and the outage stays invisible.
  assert.match(
    providerCatalogHttpFailure("perplexity", 401).detail,
    /chat requests to this provider send the same key/i
  );
});
