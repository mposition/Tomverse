/**
 * The marketing LLM cost ledger's deterministic half: the price pins, every
 * digest the ledger stores or compares, the reservation a pin implies, the
 * monthly cap read from the environment, and the outcome a settle report maps
 * to. No I/O. docs/policy/marketing-automation.md §5 (policy v4) approved the
 * table, the dedicated OpenAI key and the US$100 monthly cap.
 *
 * The app cannot see what the generator actually sent, so the ledger counts
 * every dispatched call at its reservation -- the most a pinned model can cost
 * for one request -- and keeps reported tokens as observations only.
 */

import { createHash, createHmac } from "node:crypto";

export const MARKETING_LLM_PROVIDER = "openai";
export const MARKETING_LLM_ADAPTER_PROFILE = "text-only-v1";
export const MARKETING_LLM_SERVICE_TIER = "default";
/** The adapter release the app expects; a reservation stores it in its snapshot. */
export const MARKETING_LLM_ADAPTER_VERSION = "1";

export const MARKETING_LLM_PURPOSES = ["draft", "market_intel", "brief"] as const;
export type MarketingLlmPurpose = (typeof MARKETING_LLM_PURPOSES)[number];

export const MARKETING_LLM_CALL_STATES = [
  "reserved",
  "dispatched",
  "settled",
  "unknown_retained",
  "released",
] as const;
export type MarketingLlmCallState = (typeof MARKETING_LLM_CALL_STATES)[number];

/** Each terminal state and the reasons that may close a call into it. */
export const MARKETING_LLM_CLOSE_REASONS_BY_STATE = {
  settled: ["settled"],
  unknown_retained: [
    "tokens_over_bound",
    "model_mismatch",
    "tier_mismatch",
    "reported_unknown",
    "dispatch_expired",
  ],
  released: ["reported_undispatched", "reservation_expired"],
} as const;

export type MarketingLlmTerminalState = keyof typeof MARKETING_LLM_CLOSE_REASONS_BY_STATE;
export type MarketingLlmCloseReason =
  (typeof MARKETING_LLM_CLOSE_REASONS_BY_STATE)[MarketingLlmTerminalState][number];

export const MARKETING_LLM_CLOSE_REASONS: readonly MarketingLlmCloseReason[] = Object.values(
  MARKETING_LLM_CLOSE_REASONS_BY_STATE,
).flat();

/** Reasons whose row keeps the generator's observation; the rest carry none. */
export const MARKETING_LLM_OBSERVED_CLOSE_REASONS: readonly MarketingLlmCloseReason[] = [
  "settled",
  "tokens_over_bound",
  "model_mismatch",
  "tier_mismatch",
];

export const MARKETING_LLM_CLOSE_ACTIONS = ["settle", "unknown", "release", "expire"] as const;
export type MarketingLlmCloseAction = (typeof MARKETING_LLM_CLOSE_ACTIONS)[number];

export const MARKETING_LLM_RESERVATION_TTL_MS = 15 * 60 * 1000;
export const MARKETING_LLM_DISPATCH_TTL_MS = 60 * 60 * 1000;

/** The most the operator may set the cap to: US$100, policy v4 (D2). */
export const MARKETING_LLM_MONTHLY_CAP_CEILING_MICRO_USD = 100_000_000;

/** Row bounds the migration's CHECKs repeat; a pin outside them is unusable. */
export const MARKETING_LLM_ROW_LIMITS = {
  reservedInputTokensMax: 2_000_000,
  reservedOutputTokensMax: 100_000,
  reservedMicroUsdMax: 5_000_000,
} as const;

export type MarketingLlmPricePin = {
  /** The model id the generator sends: the chat catalog's API id. */
  model: string;
  tokenizerFamily: string;
  projectId: string;
  region: string;
  /** Every public tier name the project could be billed under, sorted. */
  tiers: string[];
  /** The provider's documented maximum input for the model. */
  contextWindowTokens: number;
  /** The highest input price across every tier and long-context band. */
  worstInputMicroUsdPerMillion: number;
  worstOutputMicroUsdPerMillion: number;
  /** This profile's `max_completion_tokens`. */
  maxOutputTokens: number;
  priceVersion: string;
  verifiedAt: string;
  /** The end of this price: the next scheduled change, or far future for a current catalog price. */
  expiresAt: string;
  source: string;
};

/**
 * OpenAI's web search tool price for reasoning models: US$10 per 1,000 calls
 * (https://developers.openai.com/api/docs/pricing, read 2026-10-19). Search
 * content tokens are billed at the model's input rate, which the reservation
 * already holds as input. Pins are derived from the chat price catalog
 * (lib/marketingLlmModelCatalog.ts, operator decision 2026-10-19: the model
 * is chosen in the Admin Console), and this is the one price that catalog
 * does not carry for every model.
 */
export const MARKETING_OPENAI_WEB_SEARCH_MICRO_USD_PER_CALL = 10_000;

/**
 * Searches OpenAI may bill past the request's `max_tool_calls`: one, as the
 * chat path records in lib/webSearchCapability.ts
 * (`OPENAI_SEARCH_OVERSHOOT_ALLOWANCE`, a five-search ceiling billed six). The
 * request still carries the pin's count; the reservation adds this. A test
 * holds the two values together.
 */
export const MARKETING_OPENAI_SEARCH_OVERSHOOT_ALLOWANCE = 1;

/** A pin whose project is the API key's own: no `openai-project` header is sent. */
export const MARKETING_LLM_KEY_SCOPED_PROJECT = "key-scoped";

/** Searches each A3 web-search call may make (`max_tool_calls`). */
export const MARKETING_LLM_WEB_SEARCH_CALLS = 3;

/** The output cap every generator request sends. */
export const MARKETING_LLM_MAX_OUTPUT_TOKENS = 8_192;

/**
 * Whether the model a provider reported is the pinned one: the same id, or a
 * dated snapshot of it (`gpt-5.4-mini` answered as `gpt-5.4-mini-2026-03-17`).
 * An alias and its snapshot are one price; anything else is a different model.
 */
export const marketingLlmReportedModelMatches = (pinned: string, reported: string): boolean =>
  reported === pinned ||
  (reported.startsWith(`${pinned}-`) && /^\d{4}-\d{2}-\d{2}$/.test(reported.slice(pinned.length + 1)));

// ---------------------------------------------------------------------------
// Canonical JSON. Keys sorted, integers only, absent values omitted, no null:
// a field that is not there is left out rather than written as null, so two
// writers never disagree about which of the two an absence is.

const canonicalValue = (value: unknown, path: string): unknown => {
  if (value === null) throw new Error(`marketing_llm_canonical_null:${path}`);
  if (Array.isArray(value)) return value.map((inner, index) => canonicalValue(inner, `${path}[${index}]`));
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`marketing_llm_canonical_number:${path}`);
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "object" && value) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, inner]) => inner !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, inner]) => [key, canonicalValue(inner, `${path}.${key}`)]),
    );
  }
  throw new Error(`marketing_llm_canonical_type:${path}`);
};

export const canonicalMarketingLlmJson = (value: unknown): string =>
  JSON.stringify(canonicalValue(value, "$"));

const digestOf = (value: unknown): string =>
  createHash("sha256").update(canonicalMarketingLlmJson(value), "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Digests. One function per row of the plan's definitions table.

export const marketingLlmPricePinDigest = (pin: MarketingLlmPricePin): string =>
  digestOf({ ...pin, domain: "marketing-llm-price-pin-v1" });

export type MarketingLlmConfigSnapshot = {
  adapterProfile: typeof MARKETING_LLM_ADAPTER_PROFILE;
  adapterVersion: string;
  serviceTier: typeof MARKETING_LLM_SERVICE_TIER;
  store: false;
  stream: false;
  maxRetries: 0;
  pin: MarketingLlmPricePin;
  pricePinDigest: string;
};

export const marketingLlmConfigSnapshot = (input: {
  pin: MarketingLlmPricePin;
  adapterVersion: string;
}): MarketingLlmConfigSnapshot => ({
  adapterProfile: MARKETING_LLM_ADAPTER_PROFILE,
  adapterVersion: input.adapterVersion,
  serviceTier: MARKETING_LLM_SERVICE_TIER,
  store: false,
  stream: false,
  maxRetries: 0,
  pin: input.pin,
  pricePinDigest: marketingLlmPricePinDigest(input.pin),
});

/** Computed from the snapshot stored on the row, never from current config. */
export const marketingLlmAdapterConfigDigest = (snapshot: MarketingLlmConfigSnapshot): string =>
  digestOf({
    domain: "marketing-llm-adapter-v1",
    adapterProfile: snapshot.adapterProfile,
    adapterVersion: snapshot.adapterVersion,
    model: snapshot.pin.model,
    maxOutputTokens: snapshot.pin.maxOutputTokens,
    serviceTier: snapshot.serviceTier,
    store: snapshot.store,
    stream: snapshot.stream,
    maxRetries: snapshot.maxRetries,
    projectId: snapshot.pin.projectId,
    region: snapshot.pin.region,
    pricePinDigest: snapshot.pricePinDigest,
  });

export type MarketingLlmReservePayload = {
  requestKey: string;
  generatorRunId: string;
  purpose: MarketingLlmPurpose;
  model: string;
  adapterProfile: string;
};

/** The reserve body alone, so a replay is judged before any config is read. */
export const marketingLlmReservePayloadDigest = (payload: MarketingLlmReservePayload): string =>
  digestOf({
    domain: "marketing-llm-reserve-payload-v1",
    requestKey: payload.requestKey,
    generatorRunId: payload.generatorRunId,
    purpose: payload.purpose,
    model: payload.model,
    adapterProfile: payload.adapterProfile,
  });

export const marketingLlmRequestDigest = (input: {
  reservePayloadDigest: string;
  configSnapshot: MarketingLlmConfigSnapshot;
}): string =>
  digestOf({
    domain: "marketing-llm-reserve-v1",
    reservePayloadDigest: input.reservePayloadDigest,
    configSnapshot: input.configSnapshot,
  });

export const marketingLlmDispatchDigest = (input: {
  callId: string;
  requestKey: string;
  dispatchIntentId: string;
  adapterConfigDigest: string;
}): string =>
  digestOf({
    domain: "marketing-llm-dispatch-v1",
    callId: input.callId,
    requestKey: input.requestKey,
    dispatchIntentId: input.dispatchIntentId,
    adapterConfigDigest: input.adapterConfigDigest,
  });

export type MarketingLlmObservation = {
  observationId: string;
  reportedModel: string;
  reportedServiceTier: string;
  reportedInputTokens: number;
  reportedOutputTokens: number;
};

export type MarketingLlmClose = {
  callId: string;
  requestKey: string;
  action: MarketingLlmCloseAction;
  terminalState: MarketingLlmTerminalState;
  reason: MarketingLlmCloseReason;
  dispatchIntentId?: string;
  observation?: MarketingLlmObservation;
};

export const marketingLlmCloseDigest = (close: MarketingLlmClose): string =>
  digestOf({
    domain: "marketing-llm-close-v1",
    callId: close.callId,
    requestKey: close.requestKey,
    action: close.action,
    terminalState: close.terminalState,
    reason: close.reason,
    dispatchIntentId: close.dispatchIntentId,
    ...close.observation,
  });

export const marketingLlmConsumerDigest = (submissionDigest: string): string =>
  digestOf({ domain: "marketing-llm-consumer-v1", submissionDigest });

/**
 * The generator's signature over one budget request. `fields` is the action's
 * whole strict body less the signature; deadlineAt is signed with it so a
 * captured request cannot be replayed with a later deadline.
 */
export const marketingLlmBudgetSignature = (
  secret: string,
  input: { action: string; deadlineAt: string; fields: Record<string, unknown> },
): string =>
  createHmac("sha256", secret)
    .update(
      canonicalMarketingLlmJson({
        ...input.fields,
        domain: "marketing-llm-budget-v1",
        action: input.action,
        deadlineAt: input.deadlineAt,
      }),
      "utf8",
    )
    .digest("hex");

// ---------------------------------------------------------------------------
// Pins, reservations and the cap.

export type MarketingLlmReservation = {
  reservedInputTokens: number;
  reservedOutputTokens: number;
  reservedMicroUsd: number;
};

/**
 * The most one request can cost: the whole context window at the worst input
 * price plus the profile's output cap at the worst output price, rounded up.
 * BigInt so no product of two large integers loses a digit before the ceiling.
 */
export const marketingLlmReservation = (pin: MarketingLlmPricePin): MarketingLlmReservation => {
  const input = BigInt(pin.contextWindowTokens) * BigInt(pin.worstInputMicroUsdPerMillion);
  const output = BigInt(pin.maxOutputTokens) * BigInt(pin.worstOutputMicroUsdPerMillion);
  const million = BigInt(1_000_000);
  const total = input + output;
  const ceiling = (total + million - BigInt(1)) / million;
  return {
    reservedInputTokens: pin.contextWindowTokens,
    reservedOutputTokens: pin.maxOutputTokens,
    reservedMicroUsd: Number(ceiling),
  };
};

const PIN_TEXT = /^[A-Za-z0-9._:/-]{1,128}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** Every reason a pin cannot be used, empty when it can. */
export const marketingLlmPinProblems = (pin: MarketingLlmPricePin): string[] => {
  const problems: string[] = [];
  for (const field of ["model", "tokenizerFamily", "projectId", "region", "priceVersion"] as const) {
    if (!PIN_TEXT.test(pin[field])) problems.push(`${field}_format`);
  }
  if (!/^https:\/\/\S{1,500}$/.test(pin.source)) problems.push("source_format");
  if (
    pin.tiers.length === 0 ||
    pin.tiers.some((tier) => !/^[a-z_]{1,32}$/.test(tier)) ||
    pin.tiers.some((tier, index) => index > 0 && pin.tiers[index - 1] >= tier)
  ) {
    problems.push("tiers_format");
  }
  if (!pin.tiers.includes(MARKETING_LLM_SERVICE_TIER)) problems.push("default_tier_missing");
  for (const field of [
    "contextWindowTokens",
    "worstInputMicroUsdPerMillion",
    "worstOutputMicroUsdPerMillion",
    "maxOutputTokens",
  ] as const) {
    if (!Number.isSafeInteger(pin[field]) || pin[field] < 1) problems.push(`${field}_range`);
  }
  if (problems.length > 0) return problems;
  if (!ISO_INSTANT.test(pin.verifiedAt) || !ISO_INSTANT.test(pin.expiresAt)) {
    return [...problems, "instant_format"];
  }
  if (Date.parse(pin.expiresAt) <= Date.parse(pin.verifiedAt)) problems.push("expiry_not_after_verified");
  const reservation = marketingLlmReservation(pin);
  if (reservation.reservedInputTokens > MARKETING_LLM_ROW_LIMITS.reservedInputTokensMax) {
    problems.push("context_window_over_row_limit");
  }
  if (reservation.reservedOutputTokens > MARKETING_LLM_ROW_LIMITS.reservedOutputTokensMax) {
    problems.push("output_cap_over_row_limit");
  }
  if (reservation.reservedMicroUsd > MARKETING_LLM_ROW_LIMITS.reservedMicroUsdMax) {
    problems.push("reservation_over_row_limit");
  }
  return problems;
};

export type MarketingLlmPinLookup =
  | { ok: true; pin: MarketingLlmPricePin }
  | { ok: false; code: "model_not_pinned" | "pin_expired" };

/** A malformed pin is treated as no pin: nothing is reserved against it. */
export const resolveMarketingLlmPin = (
  pins: readonly MarketingLlmPricePin[],
  model: string,
  now: Date,
): MarketingLlmPinLookup => {
  const matches = pins.filter((pin) => pin.model === model);
  if (matches.length !== 1 || marketingLlmPinProblems(matches[0]).length > 0) {
    return { ok: false, code: "model_not_pinned" };
  }
  const pin = matches[0];
  if (now.getTime() < Date.parse(pin.verifiedAt) || now.getTime() >= Date.parse(pin.expiresAt)) {
    return { ok: false, code: "pin_expired" };
  }
  return { ok: true, pin };
};

const CAP_PATTERN = /^([0-9]{1,3})(?:\.([0-9]{1,6}))?$/;

/**
 * Decimal USD to integer micro-USD by string arithmetic, never through a
 * float. Absent, malformed, zero or above the ceiling is unreadable, and an
 * unreadable cap refuses every reservation.
 */
export const parseMarketingLlmMonthlyCap = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const match = CAP_PATTERN.exec(raw);
  if (!match) return null;
  const micro = Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(6, "0") || "0");
  if (micro <= 0 || micro > MARKETING_LLM_MONTHLY_CAP_CEILING_MICRO_USD) return null;
  return micro;
};

// ---------------------------------------------------------------------------
// The operator's settings: which pinned model the generator uses, and the
// monthly cap. Set in the Admin Console (operator decision 2026-10-19), stored
// as one AppSetting document so both are read together, inside the
// reservation's transaction.

export const MARKETING_LLM_SETTINGS_KEY = "marketing.llmSettings";

export type MarketingLlmSettings = {
  /** A pinned model id, or null: nothing is selected and nothing can spend. */
  readonly model: string | null;
  /** Decimal USD as `parseMarketingLlmMonthlyCap` reads it, or null: no cap, nothing can spend. */
  readonly monthlyUsdCap: string | null;
};

export const MARKETING_LLM_SETTINGS_UNSET: MarketingLlmSettings = Object.freeze({ model: null, monthlyUsdCap: null });

/**
 * The stored document, or null when it is not one. Absent is unset. Strict: the
 * two keys and nothing else, a model in the pin's id grammar, a cap the cap
 * parser reads. A document this cannot read refuses every reservation.
 */
export const parseMarketingLlmSettings = (value: string | null | undefined): MarketingLlmSettings | null => {
  if (value === null || value === undefined) return MARKETING_LLM_SETTINGS_UNSET;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== "model" || keys[1] !== "monthlyUsdCap") return null;
  const { model, monthlyUsdCap } = parsed as Record<string, unknown>;
  if (model !== null && (typeof model !== "string" || !PIN_TEXT.test(model))) return null;
  if (monthlyUsdCap !== null && (typeof monthlyUsdCap !== "string" || parseMarketingLlmMonthlyCap(monthlyUsdCap) === null)) {
    return null;
  }
  return { model, monthlyUsdCap } as MarketingLlmSettings;
};

/** The document the store writes: keys in one order, so equal settings are equal strings. */
export const marketingLlmSettingsValue = (settings: MarketingLlmSettings): string =>
  JSON.stringify({ model: settings.model, monthlyUsdCap: settings.monthlyUsdCap });

/**
 * Where a settle report closes a call. Anything that contradicts the
 * reservation keeps the call at its reservation as unknown, with one reason
 * chosen by a fixed priority so the stored digest is the same on replay.
 */
export const marketingLlmSettleOutcome = (input: {
  configSnapshot: MarketingLlmConfigSnapshot;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  observation: MarketingLlmObservation;
}): { terminalState: MarketingLlmTerminalState; reason: MarketingLlmCloseReason } => {
  const { observation } = input;
  if (
    observation.reportedInputTokens > input.reservedInputTokens ||
    observation.reportedOutputTokens > input.reservedOutputTokens
  ) {
    return { terminalState: "unknown_retained", reason: "tokens_over_bound" };
  }
  if (!marketingLlmReportedModelMatches(input.configSnapshot.pin.model, observation.reportedModel)) {
    return { terminalState: "unknown_retained", reason: "model_mismatch" };
  }
  if (observation.reportedServiceTier !== MARKETING_LLM_SERVICE_TIER) {
    return { terminalState: "unknown_retained", reason: "tier_mismatch" };
  }
  return { terminalState: "settled", reason: "settled" };
};

/** `YYYY-MM` of a naive-UTC month start, the advisory lock's key. */
export const marketingLlmMonthKey = (monthStart: Date): string =>
  monthStart.toISOString().slice(0, 7);
