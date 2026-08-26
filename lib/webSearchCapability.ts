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
   * Declared only where the ceiling is really imposed, and left undefined
   * where the API offers no way to bound it. It is not an observation of what
   * providers usually do: a reservation sized on a typical value is a
   * reservation that is wrong exactly when it matters.
   *
   * Two providers impose one today, by two different parameters:
   *
   * - Anthropic's `web_search_20250305` tool takes `maxUses`, sent on the
   *   tool itself by `buildWebSearchToolConfig`.
   * - OpenAI's Responses API takes `max_tool_calls`, sent on the *request*
   *   (`providerOptions.openai.maxToolCalls`) by
   *   `getModelGenerationSettings`. It bounds the built-in tool calls one
   *   Response may make, which on a searching turn is the web searches.
   *
   * Google's Search grounding still takes neither, on the tool or on the
   * request, so it stays undefined and fails closed.
   *
   * Undefined on a `hasAdditionalCost` capability means the worst-case cost of
   * a request cannot be computed, so the request cannot be authorized -- see
   * `nativeSearchIsDispatchable` below, which is the one place that reads it
   * as a yes/no.
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

/**
 * OpenAI's `max_tool_calls` ceiling, sent on every native-search request.
 *
 * A separate constant from `ANTHROPIC_MAX_SEARCH_USES` even though it holds
 * the same number: they are different API parameters with different scopes
 * (`max_uses` bounds one tool, `max_tool_calls` bounds a Response's built-in
 * tool calls), and one provider raising or lowering its ceiling must not move
 * the other's reservation with it.
 *
 * Five because there is no other approved figure in this repository and
 * Anthropic's ceiling is the one the product has already been operating
 * under -- not because five was measured. Nothing reads this constant to
 * build a request: `NATIVE_OPENAI` declares it as the capability's ceiling
 * and both the reservation and the request read it back off the capability,
 * so the number the budget is sized on and the number the request enforces
 * are the same field rather than two copies of a literal.
 */
export const OPENAI_MAX_SEARCH_TOOL_CALLS = 5;

const NATIVE_OPENAI: WebSearchCapability = {
  support: "native",
  provider: "openai",
  canForceExecution: true,
  returnsCitations: true,
  hasAdditionalCost: true,
  // `openai.tools.webSearch({})` takes no ceiling of its own, but the
  // Responses API request does: `max_tool_calls` bounds how many built-in
  // tool calls one Response may make, and the installed @ai-sdk/openai sends
  // `providerOptions.openai.maxToolCalls` straight through to it. So the
  // worst case is bounded after all, and it is bounded by this number.
  maxBillableSearchQueriesPerRequest: OPENAI_MAX_SEARCH_TOOL_CALLS,
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
  // Grounding takes no cap at all -- not on the tool, and not on the request.
  // Unlike OpenAI's `max_tool_calls`, there is no parameter to send, so a
  // Gemini turn's search cost has no worst case to reserve and this capability
  // stays undispatchable rather than being reserved on a guess.
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

/**
 * Whether a capability can actually run a search on a request today, as
 * opposed to the provider having built one.
 *
 * These are two different facts, and reading the first off `support` alone is
 * what let a Luna turn through every gate it had. `support: "native"` says the
 * provider ships a tool this app knows how to attach; it says nothing about
 * whether the resulting request can be paid for. A paid native search is
 * authorized against its worst case, and a worst case only exists where the
 * request itself imposes a ceiling -- so a capability that charges per query
 * and declares none is a capability nothing may dispatch, however native it
 * is.
 *
 * Before this helper, every surface answered the first question and behaved as
 * though it had answered the second: the composer counted the model as
 * search-ready, the credit estimate charged the surcharge, preflight and
 * availability said the request was runnable, and only `reserveNativeSearchCost`
 * -- reached after all of them, inside the chat route -- refused. The user saw
 * a 503 on a control the product had told them, four times over, that they
 * could use.
 *
 * So it is one function, and the surfaces below all call it:
 * `webSearchComposerState`, `webSearchCredits`, `webSearchExecutionNormalizer`,
 * `chatAttemptExecution`, `routerCandidates`, `modelPickerPresentation`,
 * `ChatMessageList`, and the chat/preflight/availability routes. It is
 * deliberately *not* the reservation: `reserveNativeSearchCost` still computes
 * and refuses on its own terms, so the guardrail keeps failing closed for
 * anything that reaches it, and this helper's job is to make sure nothing the
 * guardrail would refuse was ever offered.
 *
 * What it does not know is the per-process breach latch or a missing price,
 * which are runtime facts a client cannot see. Those remain the reservation's
 * refusals, and remain reachable.
 */
export const nativeSearchIsDispatchable = (
  capability: Pick<
    WebSearchCapability,
    "support" | "hasAdditionalCost" | "maxBillableSearchQueriesPerRequest"
  >
) =>
  capability.support === "native" &&
  // A native tool that costs nothing extra has nothing to bound.
  (!capability.hasAdditionalCost ||
    (capability.maxBillableSearchQueriesPerRequest ?? 0) > 0);

/**
 * Whether this model can search on this request, by either route.
 *
 * A `search-model` searches inside its ordinary completion at no separate
 * per-query charge, so there is no ceiling for it to declare and nothing to
 * refuse -- it is dispatchable whenever it is selected.
 */
export const webSearchIsDispatchable = (
  capability: Pick<
    WebSearchCapability,
    "support" | "hasAdditionalCost" | "maxBillableSearchQueriesPerRequest"
  >
) =>
  capability.support === "search-model" || nativeSearchIsDispatchable(capability);

/** The same question, for a caller that holds a model id rather than a capability. */
export const modelWebSearchIsDispatchable = (modelId: string) =>
  webSearchIsDispatchable(getWebSearchCapability(modelId));

/**
 * The tool-call ceiling this turn's OpenAI request must carry, if any.
 *
 * Read off the capability rather than off `OPENAI_MAX_SEARCH_TOOL_CALLS`, so
 * the figure `max_tool_calls` enforces is the same field
 * `reserveNativeSearchCost` sized the reservation on. Two constants could
 * drift; one field cannot.
 *
 * `undefined` for every turn that is not dispatching OpenAI's native search --
 * including a turn with web search off, which must not send the parameter at
 * all.
 */
export const openAiNativeSearchToolCallCeiling = (input: {
  capability: Pick<
    WebSearchCapability,
    "support" | "provider" | "hasAdditionalCost" | "maxBillableSearchQueriesPerRequest"
  >;
  nativeSearchEnabled: boolean;
}): number | undefined => {
  const { capability, nativeSearchEnabled } = input;
  if (!nativeSearchEnabled) return undefined;
  if (capability.provider !== "openai") return undefined;
  if (!nativeSearchIsDispatchable(capability)) return undefined;
  return capability.maxBillableSearchQueriesPerRequest;
};
