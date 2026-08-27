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

import {
  APP_MANAGED_SEARCH_LIMITS,
  isWebSearchBackendReady,
  type WebSearchBackend,
  type WebSearchBackendReadiness,
} from "@/lib/webSearchBackends";

export type WebSearchSupport =
  /** The model's own provider ships the search tool and runs it. */
  | "native"
  /**
   * Tomverse runs the search: a plain function tool this application executes
   * against a backend it holds the connection to.
   *
   * Its own value rather than a flavour of `native`, because every question a
   * caller asks about it has a different answer. A native search is bounded by
   * a parameter the provider honours, billed by the provider on the model's
   * invoice, cited by the provider, and -- on Gemini -- mutually exclusive with
   * function declarations. An application-managed one is bounded by a counter
   * in this process, billed by a search vendor on a separate invoice, cited
   * from tool results this code collected, and is itself a function
   * declaration. Answering "is this native?" with yes would have been wrong at
   * all four sites.
   */
  | "app-managed"
  | "search-model"
  | "unsupported"
  | "unverified";

export type WebSearchToolProvider = "openai" | "anthropic" | "google";

export type WebSearchCapability = {
  support: WebSearchSupport;
  /** Which native tool family this model would use, when support === "native". */
  provider?: WebSearchToolProvider;
  /**
   * Which backend this application runs the search against, when
   * `support === "app-managed"`.
   *
   * Not the model's provider. A Gemini model searching through Brave has
   * `provider` unset and `searchBackend: "brave"`, because nothing about the
   * search -- its ceiling, its price, its budget bucket, its failure modes --
   * belongs to Google. Keeping the model's provider out of this field is what
   * stops a Brave request being priced at Google's grounding rate.
   */
  searchBackend?: WebSearchBackend;
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
   * This is the *billable* bound, which for OpenAI is no longer the same
   * number the request carries -- see `OPENAI_SEARCH_OVERSHOOT_ALLOWANCE`.
   * Read `requestEnforcedSearchToolCalls` to build a request; read this to
   * size money.
   *
   * Undefined on a `hasAdditionalCost` capability means the worst-case cost of
   * a request cannot be computed, so the request cannot be authorized -- see
   * `nativeSearchIsDispatchable` below, which is the one place that reads it
   * as a yes/no.
   */
  maxBillableSearchQueriesPerRequest?: number;

  /**
   * The ceiling the request itself carries, where that differs from the
   * billable bound above.
   *
   * Only OpenAI has both today, and only because the two turned out not to be
   * the same number. Undefined everywhere else: Anthropic's ceiling rides on
   * the tool rather than the request, and Google has none to send.
   */
  requestEnforcedSearchToolCalls?: number;

  /**
   * The ceiling this application's own executor enforces, when
   * `support === "app-managed"`.
   *
   * A separate field from `requestEnforcedSearchToolCalls` even though both
   * are "what the request will not exceed", because they are enforced by
   * different things and only one of them can be trusted absolutely. OpenAI's
   * is a parameter sent to a provider that has been observed to overshoot it;
   * this one is a counter in this process, and the sixth call never reaches
   * the network. That is why the app-managed billable bound equals it exactly
   * and carries no overshoot allowance: there is nothing to overshoot with.
   */
  requestEnforcedSearchQueries?: number;
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
 * build a request: `NATIVE_OPENAI` declares it on the capability and the
 * request reads it back from there.
 */
export const OPENAI_MAX_SEARCH_TOOL_CALLS = 5;

/**
 * How far past `max_tool_calls` OpenAI has been seen to go, in searches.
 *
 * The reservation and the request used to be the same field, on the reasoning
 * that a ceiling the request enforces is a ceiling the budget can be sized on.
 * That reasoning was tested on 2026-08-26 and did not hold: a Luna turn sent
 * `max_tool_calls: 5` and OpenAI ran six `web_search_call` items. The whole
 * chain was checked before concluding it -- the SDK sends the parameter from
 * `providerOptions.openai.maxToolCalls`, the app is on the Responses model
 * that reads it, `buildWebSearchToolConfig` does not overwrite it, and the
 * stream emits exactly one `tool-result` per `web_search_call`, so six parts
 * were six searches (Sentry `NATIVE_SEARCH_QUERY_CEILING_BREACHED`,
 * `observedQueries: 6`).
 *
 * So the request ceiling bounds what OpenAI *starts*, not what it bills, and
 * the two numbers are now separate: five goes in the request, six is what a
 * turn may be charged for. Raising the request ceiling instead would have
 * moved the boundary rather than removed it -- at `max_tool_calls: 6` the
 * same overshoot bills seven.
 *
 * **This allowance rests on one observation.** It is not a measured bound on
 * how far OpenAI can overshoot, and nothing here can make it one; it is the
 * smallest number consistent with what was seen, chosen so a single extra
 * search stops latching the capability off. A second overshoot past *this*
 * bound is still a breach, still an incident, and still stops dispatch -- now
 * durably (see `lib/webSearchCeilingBreachStore.ts`). If that fires, the
 * answer is not a larger allowance: it is that OpenAI's per-search cost has
 * no enforceable worst case and belongs where Google's is.
 *
 * Raising this changes the authorized worst-case spend of a searching turn,
 * which docs/policy/credit-and-cost-limits.md makes a decision rather than a
 * tuning knob. US$0.06 was approved on 2026-08-26.
 */
export const OPENAI_SEARCH_OVERSHOOT_ALLOWANCE = 1;

/**
 * What one OpenAI turn may be billed for: what the request permits, plus the
 * overshoot that has been observed past it. Derived rather than written down,
 * so the two cannot drift apart.
 */
export const OPENAI_MAX_BILLABLE_SEARCH_QUERIES =
  OPENAI_MAX_SEARCH_TOOL_CALLS + OPENAI_SEARCH_OVERSHOOT_ALLOWANCE;

/**
 * The ceiling one model may reach in one turn through an application-managed
 * backend, and the same number the executor's counter enforces.
 *
 * Re-exported from `APP_MANAGED_SEARCH_LIMITS` rather than written again here.
 * Two constants holding five is two ceilings that can drift, and drift between
 * the number the money was reserved on and the number the counter stops at is
 * only ever visible as an overspend.
 */
export const APP_MANAGED_MAX_SEARCH_QUERIES =
  APP_MANAGED_SEARCH_LIMITS.maxQueriesPerRequest;

/**
 * A model that searches through Brave, run by this application.
 *
 * `canForceExecution` is false, and not because Brave cannot be forced -- the
 * tool is an ordinary function declaration, so `toolChoice: "required"` would
 * work. It is false because forcing it would mean every turn with the switch on
 * spends a search request, including "rewrite this paragraph", and because a
 * forced tool choice is what makes the artifact tools unregisterable
 * (`nativeSearchBlocksArtifactTool`). The product asks for a search when the
 * question needs one; the system prompt says so, and the counter bounds what
 * happens if the model disagrees.
 *
 * `maxBillableSearchQueriesPerRequest` equals `requestEnforcedSearchQueries`
 * exactly. Unlike OpenAI's pair there is no allowance between them: the
 * executor refuses the sixth call before any socket is opened, so a billable
 * sixth request is not a thing a provider can decide to do.
 */
const APP_MANAGED_BRAVE: WebSearchCapability = {
  support: "app-managed",
  searchBackend: "brave",
  canForceExecution: false,
  returnsCitations: true,
  hasAdditionalCost: true,
  requestEnforcedSearchQueries: APP_MANAGED_MAX_SEARCH_QUERIES,
  maxBillableSearchQueriesPerRequest: APP_MANAGED_MAX_SEARCH_QUERIES,
};

const NATIVE_OPENAI: WebSearchCapability = {
  support: "native",
  provider: "openai",
  canForceExecution: true,
  returnsCitations: true,
  hasAdditionalCost: true,
  // `openai.tools.webSearch({})` takes no ceiling of its own; the Responses
  // API request does. `max_tool_calls` bounds how many built-in tool calls
  // one Response may *make*, and the installed @ai-sdk/openai sends
  // `providerOptions.openai.maxToolCalls` straight through to it -- but a
  // turn has been billed for one more than it permitted, so the money is
  // sized on the larger of the two. See `OPENAI_SEARCH_OVERSHOOT_ALLOWANCE`.
  requestEnforcedSearchToolCalls: OPENAI_MAX_SEARCH_TOOL_CALLS,
  maxBillableSearchQueriesPerRequest: OPENAI_MAX_BILLABLE_SEARCH_QUERIES,
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

/**
 * Google's own Search grounding, which no model in the catalogue uses.
 *
 * Kept, exported and covered by tests rather than deleted, because it is the
 * record of a decision that has to stay decided. Grounding takes no cap at all
 * -- not on the tool, not on the request -- so a Gemini turn's search cost has
 * no worst case to reserve, and `nativeSearchIsDispatchable` refuses it. That
 * refusal is the reason the Google models search through an application-managed
 * backend instead.
 *
 * Deleting it would leave nothing to fail when somebody, reasonably, tries to
 * switch Google back onto its native tool: they would write a fresh capability,
 * and the fresh one would not carry this comment. `tests/webSearchDispatchability`
 * asserts that this exact record stays undispatchable, so the attempt fails in
 * CI rather than in an invoice.
 */
export const NATIVE_GOOGLE_GROUNDING: WebSearchCapability = {
  support: "native",
  provider: "google",
  canForceExecution: false,
  returnsCitations: true,
  hasAdditionalCost: true,
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

  // Google -- every active model searches through the application-managed
  // backend, not through Google's own grounding. The exact model pages do
  // confirm Search grounding for all of them, and that is not the question:
  // grounding bills per query and offers no parameter to bound the count, so
  // its worst case cannot be reserved and `NATIVE_GOOGLE_GROUNDING` above
  // stays undispatchable. The application-managed path has a ceiling this
  // process enforces, so it has a worst case, so it can be paid for.
  "gemini-3-7-flash": APP_MANAGED_BRAVE,
  "gemini-3-6-flash": APP_MANAGED_BRAVE,
  "gemini-3-5-flash": APP_MANAGED_BRAVE,
  "gemini-3-1-pro": APP_MANAGED_BRAVE,
  // Stable Tomverse ID; upstream apiModel is gemini-3.5-flash-lite.
  "gemini-2-5-flash": APP_MANAGED_BRAVE,
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

/** Everything the dispatchability questions below read off a capability. */
export type DispatchableWebSearchCapability = Pick<
  WebSearchCapability,
  | "support"
  | "searchBackend"
  | "hasAdditionalCost"
  | "maxBillableSearchQueriesPerRequest"
  | "requestEnforcedSearchQueries"
>;

/**
 * Whether the *register* declares a usable application-managed search, before
 * anybody asks whether this deployment can reach the backend.
 *
 * Split from the readiness question because they fail for different reasons and
 * only one of them is a defect. A capability with no backend, no ceiling, or a
 * billable bound smaller than the ceiling the executor enforces is a register
 * that contradicts itself -- there is no environment in which it becomes
 * correct. A backend with no API key is a deployment that has not been
 * configured yet, which is an operations fact and changes without a release.
 *
 * The last clause is the one worth stating out loud: the billable bound must be
 * at least what the executor will actually run. If it were smaller, every turn
 * that used its full allowance would settle above its own authorization, and
 * the ceiling-breach latch would fire on a turn that did exactly what it was
 * told.
 */
export const appManagedSearchIsDeclared = (
  capability: DispatchableWebSearchCapability
) => {
  if (capability.support !== "app-managed") return false;
  if (!capability.searchBackend) return false;
  const enforced = capability.requestEnforcedSearchQueries ?? 0;
  const billable = capability.maxBillableSearchQueriesPerRequest ?? 0;
  return enforced > 0 && billable >= enforced;
};

/**
 * Whether an application-managed search can run *here*.
 *
 * The register plus the running deployment. `readiness` is resolved on the
 * server from the secrets and budget this process actually holds, and handed to
 * client surfaces as data -- a client that derived it from a public environment
 * variable would be a client that can see whether the key is set.
 *
 * There is no default. An absent readiness map is not ready, which is the only
 * safe direction: a composer that promises a search the deployment cannot run
 * produces exactly the failure the dispatchability rule was written for, one
 * layer over.
 */
export const appManagedSearchIsDispatchable = (
  capability: DispatchableWebSearchCapability,
  readiness: WebSearchBackendReadiness
) =>
  appManagedSearchIsDeclared(capability) &&
  isWebSearchBackendReady(readiness, capability.searchBackend);

/**
 * Whether this model can search on this request, by any of the three routes.
 *
 * A `search-model` searches inside its ordinary completion at no separate
 * per-query charge, so there is no ceiling for it to declare and nothing to
 * refuse -- it is dispatchable whenever it is selected.
 *
 * `readiness` is required rather than optional, and that is the point of the
 * signature. An optional parameter defaulting to "assume reachable" would let
 * any call site that forgot it quietly answer yes for a backend this
 * deployment has no key for, and the forgetting would be invisible. Making it
 * required turns every such site into a compile error instead.
 */
export const webSearchIsDispatchable = (
  capability: DispatchableWebSearchCapability,
  readiness: WebSearchBackendReadiness
) =>
  capability.support === "search-model" ||
  nativeSearchIsDispatchable(capability) ||
  appManagedSearchIsDispatchable(capability, readiness);

/** The same question, for a caller that holds a model id rather than a capability. */
export const modelWebSearchIsDispatchable = (
  modelId: string,
  readiness: WebSearchBackendReadiness
) => webSearchIsDispatchable(getWebSearchCapability(modelId), readiness);

/**
 * The ceiling this turn's application-managed executor must enforce, if any.
 *
 * Read off the capability rather than off `APP_MANAGED_MAX_SEARCH_QUERIES`, for
 * the same reason `openAiNativeSearchToolCallCeiling` reads the capability: the
 * number the counter stops at and the number the reservation was sized on have
 * to be one field, not two constants that happen to agree today.
 *
 * `undefined` for every turn that is not dispatching an application-managed
 * search -- including a turn with web search off, which must register no tool
 * at all.
 */
export const appManagedSearchQueryCeiling = (input: {
  capability: DispatchableWebSearchCapability;
  readiness: WebSearchBackendReadiness;
  webSearchEnabled: boolean;
}): number | undefined => {
  if (!input.webSearchEnabled) return undefined;
  if (!appManagedSearchIsDispatchable(input.capability, input.readiness)) {
    return undefined;
  }
  return input.capability.requestEnforcedSearchQueries;
};

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
    | "support"
    | "provider"
    | "hasAdditionalCost"
    | "maxBillableSearchQueriesPerRequest"
    | "requestEnforcedSearchToolCalls"
  >;
  nativeSearchEnabled: boolean;
}): number | undefined => {
  const { capability, nativeSearchEnabled } = input;
  if (!nativeSearchEnabled) return undefined;
  if (capability.provider !== "openai") return undefined;
  if (!nativeSearchIsDispatchable(capability)) return undefined;
  // The request carries what the request enforces, never the billable bound.
  // Sending the larger number would raise the ceiling OpenAI overshoots from
  // and bill one more again -- which is the reason these are two fields.
  return capability.requestEnforcedSearchToolCalls;
};
