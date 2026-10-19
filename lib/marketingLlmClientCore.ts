/**
 * The marketing generator's LLM client (S3 plan §5, S3e1). Runs in the
 * generator service, which holds the LLM key and no database credential.
 *
 * One call is one ledger row, and the order is the contract:
 *
 *   reserve -> (give up? release) -> dispatch -> provider, exactly once,
 *   only on a first-consumption receipt -> settle with what came back,
 *   or unknown when nothing usable did.
 *
 * - **No retries, anywhere.** The provider is attempted once per receipt: a
 *   429, a 503, a dropped connection or a timeout is an unknown outcome, and a
 *   chat completion has no idempotency key, so a second attempt could be a
 *   second charge. The ledger counts a dispatched call at its reservation
 *   whatever happens next.
 * - **Release only before dispatch.** Once a dispatch receipt exists the app
 *   cannot tell "called" from "not called", so the call is reported unknown
 *   even when the provider was never reached -- a replayed receipt included.
 * - **An unknown budget answer stops the call.** If the app's answer to a
 *   budget action is lost, the client does not guess what was recorded and
 *   does not send another action; the ledger's expiry closes the row
 *   (docs/policy/marketing-automation.md §5; agent foundation rule 7).
 * - **The request is the allowlist.** `model`, `messages`,
 *   `max_completion_tokens` (the pin's output cap), the ledger's service tier,
 *   `store: false`, `stream: false` -- nothing else, and the tier is the one the
 *   reservation's config snapshot records.
 * - **Web search is one more allowlist.** A call given `webSearch` goes to the
 *   Responses API with one `web_search` tool limited to the given domains and
 *   `max_tool_calls` set to the pin's search cap, which the reservation priced;
 *   its answer comes back with the URLs the provider cited.
 *
 * Imports only node built-ins and the ledger's own core, so the service can
 * load it with `--experimental-strip-types` from a clone of this repository.
 */

import { randomUUID } from "node:crypto";

import {
  MARKETING_LLM_ADAPTER_PROFILE,
  MARKETING_LLM_ADAPTER_VERSION,
  MARKETING_LLM_WEB_SEARCH_PROFILE,
  MARKETING_LLM_SERVICE_TIER,
  marketingLlmAdapterConfigDigest,
  marketingLlmBudgetSignature,
  marketingLlmConfigSnapshot,
  type MarketingLlmPricePin,
  type MarketingLlmPurpose,
} from "./marketingLlmBudgetCore.ts";

/** Where a chat completion is sent: OpenAI, the dedicated-key provider of policy v4 (O14). */
export const MARKETING_LLM_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

export type MarketingLlmMessage = { readonly role: "system" | "user"; readonly content: string };

/** The provider request body: the allowlist of S3 plan §2, and nothing else. */
export function marketingLlmRequestBody(
  pin: MarketingLlmPricePin,
  messages: readonly MarketingLlmMessage[],
): Record<string, unknown> {
  return {
    model: pin.model,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    max_completion_tokens: pin.maxOutputTokens,
    service_tier: MARKETING_LLM_SERVICE_TIER,
    store: false,
    stream: false,
  };
}

/** Where a web-search call is sent: the Responses API, which runs the search tool. */
export const MARKETING_LLM_RESPONSES_URL = "https://api.openai.com/v1/responses";

/**
 * The provider request body for a web-search call: the system message as
 * instructions, the user message as input, one search tool limited to the
 * competitor's domains, and the search cap the reservation priced. No other
 * tool, no stored response, no stream. It asks for the search's sources
 * (`web_search_call.action.sources`): a JSON-only answer often carries no
 * inline `url_citation`, so the pages the search actually returned are what a
 * fact's source is checked against.
 */
export function marketingLlmWebSearchRequestBody(
  pin: MarketingLlmPricePin,
  messages: readonly MarketingLlmMessage[],
  allowedDomains: readonly string[],
): Record<string, unknown> {
  return {
    model: pin.model,
    instructions: messages.filter((message) => message.role === "system").map((message) => message.content).join("\n"),
    input: messages.filter((message) => message.role === "user").map((message) => message.content).join("\n"),
    tools: [
      {
        type: "web_search",
        filters: { allowed_domains: [...allowedDomains] },
        search_context_size: "low",
        user_location: { type: "approximate" },
      },
    ],
    include: ["web_search_call.action.sources"],
    max_tool_calls: pin.maxWebSearchCalls,
    max_output_tokens: pin.maxOutputTokens,
    service_tier: MARKETING_LLM_SERVICE_TIER,
    store: false,
    stream: false,
  };
}

/** One budget action's answer as the route gives it. */
export type MarketingLlmBudgetAnswer = { readonly httpStatus: number; readonly body: Record<string, unknown> };

/**
 * Send one budget action. Throws when no answer came back -- a lost answer is
 * an unknown outcome, which the client treats as a stop.
 */
export type MarketingLlmBudgetPort = (
  action: "reserve" | "dispatch" | "settle" | "unknown" | "release",
  fields: Record<string, unknown>,
) => Promise<MarketingLlmBudgetAnswer>;

/**
 * A budget port over HTTP to the app's `POST /api/internal/marketing-llm-budget`,
 * each request signed with the budget HMAC over its action, deadline and every
 * field (`marketingLlmBudgetSignature`), as the route verifies it.
 */
export function marketingLlmBudgetHttpPort(input: {
  readonly appUrl: string;
  readonly secret: string;
  readonly deadlineAt: string;
  readonly fetch: typeof fetch;
  /** Aborts a budget request that hangs, which the client then treats as a lost answer. */
  readonly signal?: AbortSignal;
}): MarketingLlmBudgetPort {
  const endpoint = new URL("/api/internal/marketing-llm-budget", input.appUrl);
  return async (action, fields) => {
    const signature = marketingLlmBudgetSignature(input.secret, { action, deadlineAt: input.deadlineAt, fields });
    const response = await input.fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${input.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ action, deadlineAt: input.deadlineAt, ...fields, signature }),
      signal: input.signal,
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (body === null || typeof body !== "object") throw new Error(`budget ${action}: no readable answer`);
    return { httpStatus: response.status, body };
  };
}

export type MarketingLlmCallOutcome =
  /** The app refused the action; nothing was sent to the provider. */
  | { readonly status: "refused"; readonly stage: "reserve" | "dispatch"; readonly code: string }
  /** Given up before dispatch, and the reservation released. */
  | { readonly status: "released"; readonly callId: string }
  /** The provider answered and the ledger settled it: the answer may be used. */
  | {
      readonly status: "answered";
      readonly callId: string;
      readonly requestKey: string;
      readonly content: string;
      /** The URLs the provider cited in a web-search answer; empty for a text call. */
      readonly citations: readonly string[];
      /** Always `settled`: any other ledger state comes back as `retained`. */
      readonly ledgerState: "settled";
    }
  /**
   * The provider answered, but the ledger closed the call as anything other
   * than `settled` (`unknown_retained`: tokens over the reservation, another
   * model, another tier). The cost is not what the pin says, so the answer is
   * not returned and the caller stops: an unconfirmed result is not used
   * (agent foundation rule 7).
   */
  | {
      readonly status: "retained";
      readonly callId: string;
      readonly requestKey: string;
      readonly ledgerState: string;
    }
  /** Nothing usable came back; the call is recorded as unknown at its reservation. */
  | { readonly status: "unknown"; readonly callId: string; readonly requestKey: string }
  /**
   * A budget answer was lost or the ledger had already closed the call, so the
   * client stopped without guessing. `content` is the provider's answer when
   * it came back before the stop; it cannot be submitted until the ledger
   * closes the call.
   */
  | {
      readonly status: "stopped";
      readonly stage: "reserve" | "release" | "dispatch" | "settle" | "unknown";
      readonly callId: string | null;
      readonly requestKey: string;
      readonly content?: string;
    };

type ProviderAnswer = {
  readonly content: string;
  readonly citations: readonly string[];
  readonly model: string;
  readonly serviceTier: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
};

const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** The parts of a chat completion the ledger is told, or null when one is missing. */
export function readMarketingLlmProviderAnswer(body: unknown): ProviderAnswer | null {
  if (!body || typeof body !== "object") return null;
  const root = body as {
    model?: unknown;
    service_tier?: unknown;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = root.choices?.[0]?.message?.content;
  const inputTokens = root.usage?.prompt_tokens;
  const outputTokens = root.usage?.completion_tokens;
  if (
    typeof root.model !== "string" ||
    typeof root.service_tier !== "string" ||
    typeof content !== "string" ||
    !nonNegativeInteger(inputTokens) ||
    !nonNegativeInteger(outputTokens)
  ) {
    return null;
  }
  return { content, citations: [], model: root.model, serviceTier: root.service_tier, inputTokens, outputTokens };
}

/**
 * The parts of a Responses answer the ledger is told, with the URLs the
 * provider cited or its searches returned, or null when one is missing.
 */
export function readMarketingLlmWebSearchAnswer(body: unknown): ProviderAnswer | null {
  if (!body || typeof body !== "object") return null;
  const root = body as {
    model?: unknown;
    service_tier?: unknown;
    status?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
    output?: Array<{
      type?: unknown;
      content?: Array<{ type?: unknown; text?: unknown; annotations?: Array<{ type?: unknown; url?: unknown }> }>;
      action?: { type?: unknown; url?: unknown; sources?: Array<{ type?: unknown; url?: unknown }> };
    }>;
  };
  const parts = (root.output ?? [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part?.type === "output_text" && typeof part.text === "string");
  const content = parts.map((part) => part.text as string).join("");
  const cited = parts
    .flatMap((part) => part.annotations ?? [])
    .filter((annotation) => annotation?.type === "url_citation" && typeof annotation.url === "string")
    .map((annotation) => annotation.url as string);
  // The pages the provider's own searches returned or opened.
  const retrieved = (root.output ?? [])
    .filter((item) => item?.type === "web_search_call" && item.action && typeof item.action === "object")
    .flatMap((item) => [
      ...(Array.isArray(item.action?.sources) ? item.action.sources : [])
        .filter((source) => source?.type === "url" && typeof source.url === "string")
        .map((source) => source.url as string),
      ...(item.action?.type === "open_page" && typeof item.action.url === "string" ? [item.action.url] : []),
    ]);
  const citations = [...new Set([...cited, ...retrieved])];
  const inputTokens = root.usage?.input_tokens;
  const outputTokens = root.usage?.output_tokens;
  if (
    root.status !== "completed" ||
    typeof root.model !== "string" ||
    typeof root.service_tier !== "string" ||
    content.length === 0 ||
    !nonNegativeInteger(inputTokens) ||
    !nonNegativeInteger(outputTokens)
  ) {
    return null;
  }
  return { content, citations, model: root.model, serviceTier: root.service_tier, inputTokens, outputTokens };
}

const ok = (answer: MarketingLlmBudgetAnswer) => answer.httpStatus === 200 && answer.body.status === "ok";
const refused = (answer: MarketingLlmBudgetAnswer) =>
  answer.httpStatus === 200 && answer.body.status === "refused" ? String(answer.body.code ?? "refused") : null;

export async function runMarketingLlmCall(
  input: {
    readonly pin: MarketingLlmPricePin;
    readonly generatorRunId: string;
    readonly purpose: MarketingLlmPurpose;
    readonly messages: readonly MarketingLlmMessage[];
    /** Run the provider's web search, limited to these domains (the web-search profile). */
    readonly webSearch?: { readonly allowedDomains: readonly string[] };
    /** A key chosen by the caller makes a resend of the same call the same reservation. */
    readonly requestKey?: string;
  },
  deps: {
    readonly budget: MarketingLlmBudgetPort;
    /** The provider transport. Called at most once per call. */
    readonly transport: typeof fetch;
    readonly apiKey: string;
    /** Asked once, between the reservation and the dispatch: false gives the call up. */
    readonly proceed?: () => boolean;
    /** Aborts the provider request; the service's supervisor is the hard bound. */
    readonly signal?: AbortSignal;
    readonly newId?: () => string;
  },
): Promise<MarketingLlmCallOutcome> {
  const newId = deps.newId ?? randomUUID;
  const requestKey = input.requestKey ?? newId();
  const adapterProfile = input.webSearch ? MARKETING_LLM_WEB_SEARCH_PROFILE : MARKETING_LLM_ADAPTER_PROFILE;
  const stop = (stage: Extract<MarketingLlmCallOutcome, { status: "stopped" }>["stage"], callId: string | null, content?: string) =>
    ({ status: "stopped", stage, callId, requestKey, ...(content === undefined ? {} : { content }) }) as const;

  // 1. Reserve.
  let reserve: MarketingLlmBudgetAnswer;
  try {
    reserve = await deps.budget("reserve", {
      requestKey,
      generatorRunId: input.generatorRunId,
      purpose: input.purpose,
      model: input.pin.model,
      adapterProfile,
    });
  } catch {
    return stop("reserve", null);
  }
  const reserveRefusal = refused(reserve);
  if (reserveRefusal !== null) return { status: "refused", stage: "reserve", code: reserveRefusal };
  if (!ok(reserve) || typeof reserve.body.callId !== "string") return stop("reserve", null);
  const callId = reserve.body.callId;

  // 2. Give up here, and only here, with a release.
  if (deps.proceed && !deps.proceed()) {
    try {
      const released = await deps.budget("release", { callId });
      return ok(released) ? { status: "released", callId } : stop("release", callId);
    } catch {
      return stop("release", callId);
    }
  }

  // 3. Dispatch: the receipt is the licence to call, once.
  const dispatchIntentId = newId();
  let dispatch: MarketingLlmBudgetAnswer;
  try {
    dispatch = await deps.budget("dispatch", {
      callId,
      requestKey,
      dispatchIntentId,
      adapterConfigDigest: marketingLlmAdapterConfigDigest(
        marketingLlmConfigSnapshot({ pin: input.pin, adapterVersion: MARKETING_LLM_ADAPTER_VERSION, adapterProfile }),
      ),
    });
  } catch {
    return stop("dispatch", callId);
  }
  const dispatchRefusal = refused(dispatch);
  if (dispatchRefusal !== null) return { status: "refused", stage: "dispatch", code: dispatchRefusal };
  if (!ok(dispatch)) return stop("dispatch", callId);

  const reportUnknown = async (): Promise<MarketingLlmCallOutcome> => {
    try {
      const unknown = await deps.budget("unknown", { callId, dispatchIntentId });
      return ok(unknown) ? { status: "unknown", callId, requestKey } : stop("unknown", callId);
    } catch {
      return stop("unknown", callId);
    }
  };

  // A replayed receipt: this client may already have called once. Not again.
  if (dispatch.body.firstConsumption !== true) return reportUnknown();

  // 4. The provider, exactly once.
  let answer: ProviderAnswer | null = null;
  try {
    const response = await deps.transport(input.webSearch ? MARKETING_LLM_RESPONSES_URL : MARKETING_LLM_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.apiKey}`,
        "content-type": "application/json",
        "openai-project": input.pin.projectId,
      },
      body: JSON.stringify(
        input.webSearch
          ? marketingLlmWebSearchRequestBody(input.pin, input.messages, input.webSearch.allowedDomains)
          : marketingLlmRequestBody(input.pin, input.messages),
      ),
      signal: deps.signal,
    });
    if (response.ok) {
      const body = await response.json().catch(() => null);
      answer = input.webSearch ? readMarketingLlmWebSearchAnswer(body) : readMarketingLlmProviderAnswer(body);
    }
  } catch {
    answer = null;
  }
  if (answer === null) return reportUnknown();

  // 5. Settle with what came back. The app decides whether it matches the pin.
  try {
    const settled = await deps.budget("settle", {
      callId,
      dispatchIntentId,
      observationId: newId(),
      reportedModel: answer.model,
      reportedServiceTier: answer.serviceTier,
      reportedInputTokens: answer.inputTokens,
      reportedOutputTokens: answer.outputTokens,
    });
    if (!ok(settled)) return stop("settle", callId, answer.content);
    const ledgerState = String(settled.body.state ?? "");
    if (ledgerState !== "settled") return { status: "retained", callId, requestKey, ledgerState };
    return { status: "answered", callId, requestKey, content: answer.content, citations: answer.citations, ledgerState: "settled" };
  } catch {
    return stop("settle", callId, answer.content);
  }
}
