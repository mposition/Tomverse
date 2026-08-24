// Central registry of which exact catalog model IDs have a confirmed,
// officially-documented provider-native web search tool available through
// the installed AI SDK provider packages. Keyed by model `id`, not by
// `provider` -- two models from the same provider can have different
// verified support (e.g. gpt-5-5 is confirmed, gpt-5-4-mini is not).
//
// "native" entries were cross-checked against each provider's own tool
// documentation during implementation (OpenAI web_search on the Responses
// API, Anthropic web_search_20250305, Google "Grounding with Google
// Search") and against the AI SDK provider packages actually installed in
// this repo (@ai-sdk/openai, @ai-sdk/anthropic, @ai-sdk/google -- all at
// 4.0.8, which export openai.tools.webSearch, anthropic.tools.webSearch_20250305,
// and google.tools.googleSearch respectively). Any catalog model whose
// support could not be confirmed against those docs is deliberately left
// as "unverified" rather than assumed -- see STG web-search-native task
// notes for the exact sources checked. Groq and xAI expose separate
// provider-side search products, but this app routes them through plain
// Chat Completions without those server tools, so their models intentionally
// remain unsupported here.

export type WebSearchSupport = "native" | "search-model" | "unsupported" | "unverified";

export type WebSearchToolProvider = "openai" | "anthropic" | "google";

export type WebSearchCapability = {
  support: WebSearchSupport;
  /** Which native tool family this model would use, when support === "native". */
  provider?: WebSearchToolProvider;
  /** Anthropic's web search tool is version-pinned in its `type` string. */
  toolVersion?: string;
  /** OpenAI can force the tool via toolChoice; Anthropic/Google cannot. */
  canForceExecution: boolean;
  returnsCitations: boolean;
  hasAdditionalCost: boolean;
  /**
   * The most billable searches one request can produce, when the request
   * itself enforces it.
   *
   * Declared only where the ceiling is really imposed -- Anthropic's tool
   * takes `maxUses` and this module owns that number -- and left undefined
   * where the API offers no way to bound it. It is not an observation of what
   * providers usually do: a reservation sized on a typical value is a
   * reservation that is wrong exactly when it matters.
   *
   * Undefined on a `hasAdditionalCost` capability means the worst-case cost of
   * a request cannot be computed, so the request cannot be authorized.
   */
  maxBillableSearchQueriesPerRequest?: number;
};

/**
 * Anthropic's `web_search_20250305` ceiling, sent on every request.
 *
 * Exported so `buildWebSearchToolConfig` sends this exact number. The
 * reservation is sized on it, and a config that quietly sent a different one
 * would authorize less than the request can spend.
 */
export const ANTHROPIC_MAX_SEARCH_USES = 5;

const NATIVE_OPENAI: WebSearchCapability = {
  support: "native",
  provider: "openai",
  canForceExecution: true,
  returnsCitations: true,
  hasAdditionalCost: true,
  // `openai.tools.webSearch({})` sends no ceiling and the API documents none,
  // so the worst case is unbounded and no reservation can cover it.
};

const NATIVE_ANTHROPIC: WebSearchCapability = {
  support: "native",
  provider: "anthropic",
  toolVersion: "web_search_20250305",
  canForceExecution: false,
  returnsCitations: true,
  hasAdditionalCost: true,
  maxBillableSearchQueriesPerRequest: ANTHROPIC_MAX_SEARCH_USES,
};

const NATIVE_GOOGLE: WebSearchCapability = {
  support: "native",
  provider: "google",
  canForceExecution: false,
  returnsCitations: true,
  hasAdditionalCost: true,
  // Grounding takes no per-request cap either.
};

const SEARCH_MODEL: WebSearchCapability = {
  support: "search-model",
  canForceExecution: true,
  returnsCitations: true,
  hasAdditionalCost: false,
};

const UNVERIFIED: WebSearchCapability = {
  support: "unverified",
  canForceExecution: false,
  returnsCitations: false,
  hasAdditionalCost: false,
};

const UNSUPPORTED: WebSearchCapability = {
  support: "unsupported",
  canForceExecution: false,
  returnsCitations: false,
  hasAdditionalCost: false,
};

export const WEB_SEARCH_CAPABILITIES: Readonly<Record<string, WebSearchCapability>> = {
  // OpenAI -- confirmed supported models per platform.openai.com/docs/guides/tools-web-search:
  // gpt-5.6, gpt-5.5, gpt-4.1, gpt-4.1-mini. Catalog apiModel "gpt-5.5" matches.
  "gpt-5-6-sol": NATIVE_OPENAI,
  "gpt-5-6-terra": NATIVE_OPENAI,
  "gpt-5-6-luna": NATIVE_OPENAI,
  "gpt-5-5": NATIVE_OPENAI,
  "gpt-5-5-thinking": NATIVE_OPENAI,
  // apiModel "gpt-5.4-mini" is not in the confirmed-supported list above.
  "gpt-5-4-mini": UNVERIFIED,

  // Anthropic -- web_search_20250305 is GA and enabled per-organization
  // rather than narrowly model-gated; confirmed for all four current-
  // generation Claude models in this catalog.
  "claude-fable-5": NATIVE_ANTHROPIC,
  "claude-opus-4-8": NATIVE_ANTHROPIC,
  "claude-sonnet-5": NATIVE_ANTHROPIC,
  "claude-haiku-4-5": NATIVE_ANTHROPIC,

  // Google -- exact model pages confirm Search grounding for both July 2026
  // stable releases as well as the existing 3.5 Flash / 3.1 Pro entries.
  "gemini-3-7-flash": NATIVE_GOOGLE,
  "gemini-3-6-flash": NATIVE_GOOGLE,
  "gemini-3-5-flash": NATIVE_GOOGLE,
  "gemini-3-1-pro": NATIVE_GOOGLE,
  // Stable Tomverse ID; upstream apiModel is gemini-3.5-flash-lite.
  "gemini-2-5-flash": NATIVE_GOOGLE,
  // Disabled in the catalog; left out entirely (falls through to unsupported
  // via the lookup fallback) since it can't be selected today anyway.

  // Perplexity search-capable chat models search unconditionally as part of
  // normal completion -- no AI SDK tool involved, unchanged by this feature.
  "perplexity/sonar": SEARCH_MODEL,
  "perplexity/sonar-pro": SEARCH_MODEL,
  "perplexity/sonar-reasoning-pro": SEARCH_MODEL,
  // sonar-deep-research is handled entirely by the separate Deep Research
  // flow and never reaches the "always" web-search-mode code path.
};

export const getWebSearchCapability = (modelId: string): WebSearchCapability =>
  WEB_SEARCH_CAPABILITIES[modelId] ?? UNSUPPORTED;
