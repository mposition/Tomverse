// The image catalogue's guided flow, as pure functions the panel and its tests
// share: which step a model is on, what that step asks the operator to do,
// how a server reason reads, and which edited credits can be applied.
// Deciding whether a model may serve stays on the server (lib/modelCatalogCore.ts);
// these only describe what the server reported.
import type { AdminFlowStepState } from "@/lib/adminAmuxFlow";

export type ImageOptionPrice = { quality: string; size: string; credits: number; outputCostMicroUsd: number };
export type ImageOptionFloor = { quality: string; size: string; floor: number | null };
export type ImageDraftReview = { floors: ImageOptionFloor[]; reasons: string[] };
export type ImageDraft = {
  pricingVersion: string;
  prices: ImageOptionPrice[];
  verification: { verifiedAt: string; sources: string[]; thinkingCapMicroUsd: number | null };
};
export type Admission = { admitted: boolean; reasons?: string[] };

/** One image model as the list and the detail view need it, served or not. */
export type ImageCatalogItem = {
  id: string;
  name: string;
  provider: string;
  apiModelId: string;
  source: "code" | "catalog";
  sizes: string[];
  qualities: string[];
  /** What the image router is told the model is good and bad at; null when unset. */
  routingNote: string | null;
  /** What users are told the model is for (a chat.imageModelUse* key); null when unset. */
  useCase: string | null;
  /** Null until the model resolves (a runtime model with no price yet). */
  served: null | {
    enabled: boolean | null;
    holdReason: string | null;
    disabledReason: string | null;
    pricingVersion: string;
    prices: ImageOptionPrice[];
    floors: ImageOptionFloor[];
    priceVerification: { verifiedAt: string | null; sources: string[]; thinkingCapMicroUsd: number | null };
    admissionIfEnabled: Admission;
  };
  problem: string | null;
  draft: ImageDraft | null;
  draftCreatedAt: string | null;
  draftReview: ImageDraftReview | null;
  /** The stored row, for the advanced view. */
  raw: unknown;
};

export type ImageStage =
  | "profile_invalid"
  | "needs_draft"
  | "draft_ready"
  | "ready_to_enable"
  | "blocked"
  | "needs_budget"
  | "serving"
  | "held";

export const imageStage = (item: ImageCatalogItem): ImageStage => {
  if (!item.served) {
    if (item.problem === "invalid_full_profile") return "profile_invalid";
    return item.draft ? "draft_ready" : "needs_draft";
  }
  const served = item.served;
  if (served.holdReason || served.enabled === false) return item.draft ? "draft_ready" : "held";
  if (served.disabledReason === null) return item.draft ? "draft_ready" : "serving";
  if (item.draft) return "draft_ready";
  if (served.admissionIfEnabled.admitted) return "ready_to_enable";
  // Only the provider budget is missing: the prices are fine and a new draft
  // would not help; the budget is set in the environment, not on this screen.
  const reasons = served.admissionIfEnabled.reasons ?? [];
  return reasons.length > 0 && reasons.every((reason) => reason === "provider_budget_missing") ? "needs_budget" : "blocked";
};

/**
 * Models that wait for the operator are listed apart from the settled ones:
 * a model added here until it serves, and any model with a draft to check. A
 * code model that is off is the code's decision (an unbounded worst case, say),
 * not a step the operator owes, so it stays in the table with its state.
 */
export const needsAction = (item: Pick<ImageCatalogItem, "source" | "draft">, stage: ImageStage) =>
  stage === "draft_ready" || (item.source === "catalog" && stage !== "serving" && stage !== "held");

export const IMAGE_FLOW_STEPS = ["profile", "draft", "review", "enable"] as const;
export type ImageFlowStep = (typeof IMAGE_FLOW_STEPS)[number];

const STEP_STATES: Record<ImageStage, AdminFlowStepState[]> = {
  profile_invalid: ["attention", "todo", "todo", "todo"],
  needs_draft: ["done", "current", "todo", "todo"],
  draft_ready: ["done", "done", "current", "todo"],
  blocked: ["done", "done", "attention", "todo"],
  needs_budget: ["done", "done", "done", "attention"],
  ready_to_enable: ["done", "done", "done", "current"],
  serving: ["done", "done", "done", "done"],
  held: ["done", "done", "done", "attention"],
};

export const imageFlowSteps = (stage: ImageStage) =>
  IMAGE_FLOW_STEPS.map((id, index) => ({ id, state: STEP_STATES[stage][index] }));

/** The one action each stage offers as its primary button. */
export type ImageNextAction = "fix_profile" | "make_draft" | "review_prices" | "enable" | "redraft" | "view" | "none";
export const imageNextAction = (stage: ImageStage): ImageNextAction =>
  ({
    profile_invalid: "fix_profile",
    needs_draft: "make_draft",
    draft_ready: "review_prices",
    ready_to_enable: "enable",
    blocked: "redraft",
    needs_budget: "none",
    serving: "view",
    held: "view",
  })[stage] as ImageNextAction;

/**
 * A server reason or error code as a message key and its parameters, so the
 * screen reads in words. Unknown codes fall back to "unknown" with the code,
 * shown only in the advanced view.
 */
export type ReasonMessage =
  | { key: "invalidProfile" }
  | { key: "noPrice" }
  | { key: "priceUnverified" }
  | { key: "unofficialSource"; host: string }
  | { key: "creditsBelowFloor"; quality: string; size: string }
  | { key: "priceBelowMeasured"; quality: string; size: string }
  | { key: "worstCaseUnbounded" }
  | { key: "thinkingCapBelowMinimum"; minimum: string }
  | { key: "providerBudgetMissing" }
  | { key: "draftLlmOff" }
  | { key: "noDefaultSource" }
  | { key: "noPriceFound"; detail: string }
  | { key: "versionReused" }
  | { key: "profilePriced" }
  | { key: "invalidInput" }
  | { key: "fetchFailed" }
  | { key: "noDraft" }
  | { key: "rateLimited" }
  | { key: "forbidden" }
  | { key: "timeout" }
  | { key: "network" }
  | { key: "sessionExpired" }
  | { key: "codingWeightBelowFloor"; floor: number }
  | { key: "codingFloorUnbounded" }
  | { key: "unknownProvider" }
  | { key: "destinationUnproven" }
  | { key: "noToolCalling" }
  | { key: "noStructuredOutput" }
  | { key: "noCapabilitySource" }
  | { key: "noCodingNotes" }
  | { key: "timeoutUnknown" }
  | { key: "draftFailed" }
  | { key: "noProfile" }
  | { key: "draftIncomplete"; detail: string }
  | { key: "chatModelMissing" }
  | { key: "chatContextUnknown" }
  | { key: "chatModelDeleted" }
  | { key: "chatModelDisabled" }
  | { key: "chatPriceUnverified" }
  | { key: "chatCreditsMissing" }
  | { key: "reasoningCostUnbounded" }
  | { key: "providerCostUnbounded" }
  | { key: "alreadyInCatalog" }
  | { key: "notACandidate" }
  | { key: "linkedRowProfileDraft" }
  | { key: "settingsLinkedOnly" }
  | { key: "unlinkTurnOffFirst" }
  | { key: "unknownModel" }
  | { key: "unknown"; code: string };

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

export const reasonMessage = (code: string, detail = ""): ReasonMessage => {
  const [head, ...rest] = code.split(":");
  const tail = rest.join(":");
  switch (head) {
    case "invalid_full_profile":
    case "invalid_profile":
      return { key: "invalidProfile" };
    case "no_price_revision":
    case "no_prices":
    case "unknown_model_or_no_price_revision":
      return { key: "noPrice" };
    case "price_unverified":
    case "no_price_sources":
      return { key: "priceUnverified" };
    case "unofficial_source":
    case "unofficial_price_source":
      return { key: "unofficialSource", host: hostOf(tail || detail) };
    case "credits_below_floor": {
      // Coding names the floor ("credits_below_floor:12"); image names the option.
      if (/^\d+$/.test(tail)) return { key: "codingWeightBelowFloor", floor: Number(tail) };
      const [quality = "", size = ""] = tail.split("/");
      return { key: "creditsBelowFloor", quality, size };
    }
    case "price_below_measured_cost": {
      const [quality = "", size = ""] = tail.split("/");
      return { key: "priceBelowMeasured", quality, size };
    }
    case "worst_case_cost_unbounded":
      return { key: "worstCaseUnbounded" };
    case "credit_floor_unbounded":
      return { key: "codingFloorUnbounded" };
    case "unknown_provider":
      return { key: "unknownProvider" };
    case "provider_destination_unproven":
      return { key: "destinationUnproven" };
    case "no_tool_calling":
      return { key: "noToolCalling" };
    case "no_structured_output":
      return { key: "noStructuredOutput" };
    case "no_capability_source":
      return { key: "noCapabilitySource" };
    case "no_coding_notes":
      return { key: "noCodingNotes" };
    case "timeout_outcome_unknown":
      return { key: "timeoutUnknown" };
    case "draft_failed":
      return { key: "draftFailed" };
    case "no_profile":
    case "no_valid_profile":
      return { key: "noProfile" };
    case "thinking_cap_below_minimum":
      return { key: "thinkingCapBelowMinimum", minimum: tail };
    case "provider_budget_missing":
      return { key: "providerBudgetMissing" };
    case "draft_llm_not_configured":
      return { key: "draftLlmOff" };
    case "no_default_source":
      return { key: "noDefaultSource" };
    case "draft_rejected":
      // A coding draft is refused for missing fields, not a missing price.
      if (detail === "credit_floor_unbounded") return { key: "codingFloorUnbounded" };
      if (detail && !/^(no_options|invalid_prices)/.test(detail)) return { key: "draftIncomplete", detail };
      return { key: "noPriceFound", detail: detail.replace(/^(no_options|invalid_prices):?\s*/, "") };
    case "pricing_version_reused":
      return { key: "versionReused" };
    case "execution_profile_priced":
    case "draft_profile_mismatch":
      return { key: "profilePriced" };
    case "INVALID_JSON":
    case "INVALID_REQUEST":
    case "REQUEST_BODY_TOO_LARGE":
    case "invalid_json":
    case "invalid_model_id":
    case "invalid_draft":
    case "credit_override_unknown_option":
    case "credit_overrides_image_only":
    case "coding_edit_coding_only":
      return { key: "invalidInput" };
    case "fetch_failed":
    case "page_too_large":
      return { key: "fetchFailed" };
    case "no_draft":
      return { key: "noDraft" };
    case "API_RATE_LIMITED":
      return { key: "rateLimited" };
    case "forbidden":
      return { key: "forbidden" };
    case "timeout":
      return { key: "timeout" };
    case "network_error":
      return { key: "network" };
    case "session_expired":
      return { key: "sessionExpired" };
    case "chat_model_missing":
      return { key: "chatModelMissing" };
    case "chat_context_unknown":
      return { key: "chatContextUnknown" };
    case "chat_model_deleted":
      return { key: "chatModelDeleted" };
    case "chat_model_disabled":
      return { key: "chatModelDisabled" };
    case "chat_price_unverified":
      return { key: "chatPriceUnverified" };
    case "chat_credits_missing":
      return { key: "chatCreditsMissing" };
    case "reasoning_cost_unbounded":
      return { key: "reasoningCostUnbounded" };
    case "provider_cost_unbounded":
      return { key: "providerCostUnbounded" };
    case "already_in_catalog":
      return { key: "alreadyInCatalog" };
    case "not_a_candidate":
      return { key: "notACandidate" };
    case "linked_row_profile_draft":
      return { key: "linkedRowProfileDraft" };
    case "settings_linked_only":
    case "unlink_linked_only":
      return { key: "settingsLinkedOnly" };
    case "unlink_turn_off_first":
      return { key: "unlinkTurnOffFirst" };
    case "unknown_model":
      return { key: "unknownModel" };
    default:
      return { key: "unknown", code };
  }
};

/**
 * Whether a refusal is one a billing measurement can answer: no per-image
 * price in the documentation, or no bound on what thinking costs. Only for a
 * provider the measurement has a method for.
 */
export const suggestsMeasurement = (provider: string, codes: readonly string[], detail = "") =>
  ["google", "openai", "qwen"].includes(provider) &&
  codes.some((code) => {
    const key = reasonMessage(code, detail).key;
    return key === "worstCaseUnbounded" || key === "noPriceFound";
  });

/**
 * Whether this model's refusal is one a measurement settles. Not when the
 * model already serves a reasoning cap of its own (a code model with a
 * measured bound, gemini-3.1-flash-image): a draft refused for an unbounded
 * cost there is one written before the cap existed, and a new draft takes the
 * cap. Measuring it instead would confirm terms the code model may not use
 * (2026-11-13: a 4,096 measurement on Flash was refused against its 2,048).
 */
export const measurementApplies = (
  item: { provider: string; served: null | { priceVerification: { thinkingCapMicroUsd: number | null } } },
  codes: readonly string[],
  detail = ""
) => item.served?.priceVerification.thinkingCapMicroUsd == null && suggestsMeasurement(item.provider, codes, detail);

/**
 * The admin session check's own 404 ("Not found."), as opposed to a
 * catalogue refusal that is also a 404 (no_draft when another admin applied
 * the draft first), which must not send the operator to sign in again.
 */
export const isSessionGone = (status: number, payload: { error?: string } | null) =>
  status === 404 && (payload === null || payload.error === "Not found.");

/** The refusal a response carries, with the reasons that explain it best. */
export const refusalReasons = (error: string, reasons: readonly string[]): string[] =>
  error === "not_admitted" && reasons.length > 0 ? [...reasons] : [error];

export const optionKey = (option: { quality: string; size: string }) => `${option.quality}|${option.size}`;

/**
 * Credits the operator typed, checked against each option's floor. An option
 * whose floor the server could not compute (unbounded worst case) is not an
 * input error: the draft's own reasons already say why it cannot apply.
 */
export const creditProblems = (
  prices: readonly ImageOptionPrice[],
  edits: Readonly<Record<string, string>>,
  floors: readonly ImageOptionFloor[]
): Record<string, "not_a_number" | "below_floor"> => {
  const floorByKey = new Map(floors.map((floor) => [optionKey(floor), floor.floor]));
  const problems: Record<string, "not_a_number" | "below_floor"> = {};
  for (const price of prices) {
    const key = optionKey(price);
    const typed = edits[key];
    const credits = typed === undefined ? price.credits : Number(typed);
    if (!Number.isInteger(credits) || credits <= 0 || credits > 10_000) {
      problems[key] = "not_a_number";
      continue;
    }
    const floor = floorByKey.get(key);
    if (floor !== null && floor !== undefined && credits < floor) problems[key] = "below_floor";
  }
  return problems;
};

/** The apply request's credit overrides: only options whose credits changed. */
export const creditOverrides = (prices: readonly ImageOptionPrice[], edits: Readonly<Record<string, string>>) =>
  prices.flatMap((price) => {
    const typed = edits[optionKey(price)];
    if (typed === undefined || Number(typed) === price.credits) return [];
    return [{ quality: price.quality, size: price.size, credits: Number(typed) }];
  });

export const priceRange = (prices: readonly { credits: number }[]) =>
  prices.length === 0
    ? null
    : { count: prices.length, min: Math.min(...prices.map((p) => p.credits)), max: Math.max(...prices.map((p) => p.credits)) };

export const QUALITY_ORDER = ["low", "medium", "high"] as const;
export const SIZE_ORDER = ["1024x1024", "1536x1024", "1024x1536"] as const;

/** Prices in reading order: quality, then square / landscape / portrait. */
export const orderedPrices = <P extends { quality: string; size: string }>(prices: readonly P[]): P[] =>
  [...prices].sort(
    (a, b) =>
      QUALITY_ORDER.indexOf(a.quality as never) - QUALITY_ORDER.indexOf(b.quality as never) ||
      SIZE_ORDER.indexOf(a.size as never) - SIZE_ORDER.indexOf(b.size as never)
  );

export const formatUsd = (microUsd: number) => `$${(microUsd / 1_000_000).toFixed(3)}`;

/** Server rows (served models + unresolved runtime rows) as one list. */
export const imageCatalogItems = (report: {
  models: Array<{
    id: string;
    name: string;
    provider: string;
    apiModelId?: string;
    sizes?: string[];
    qualities?: string[];
    routingNote?: string | null;
    useCase?: string | null;
    source: "code" | "catalog";
    enabled: boolean | null;
    holdReason: string | null;
    disabledReason: string | null;
    pricingVersion: string;
    prices?: ImageOptionPrice[];
    floors?: ImageOptionFloor[];
    priceVerification?: { verifiedAt: string | null; sources: string[]; thinkingCapMicroUsd: number | null };
    admissionIfEnabled: Admission;
    draft: unknown;
    draftCreatedAt?: string | null;
    draftReview?: ImageDraftReview | null;
  }>;
  pending?: Array<{
    modelId: string;
    profile: unknown;
    draft: unknown;
    draftCreatedAt?: string | null;
    draftReview?: ImageDraftReview | null;
    problem: string | null;
  }>;
}): ImageCatalogItem[] => {
  const served = report.models.map(
    (row): ImageCatalogItem => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      apiModelId: row.apiModelId ?? row.id,
      source: row.source,
      sizes: row.sizes ?? [],
      qualities: row.qualities ?? [],
      routingNote: row.routingNote ?? null,
      useCase: row.useCase ?? null,
      served: {
        enabled: row.enabled,
        holdReason: row.holdReason,
        disabledReason: row.disabledReason,
        pricingVersion: row.pricingVersion,
        prices: row.prices ?? [],
        floors: row.floors ?? [],
        priceVerification: row.priceVerification ?? { verifiedAt: null, sources: [], thinkingCapMicroUsd: null },
        admissionIfEnabled: row.admissionIfEnabled,
      },
      problem: null,
      draft: (row.draft as ImageDraft | null) ?? null,
      draftCreatedAt: row.draftCreatedAt ?? null,
      draftReview: row.draftReview ?? null,
      raw: row,
    })
  );
  const pending = (report.pending ?? []).map((row): ImageCatalogItem => {
    const profile = (row.profile ?? {}) as Partial<{ provider: string; apiModelId: string; name: string; sizes: string[]; qualities: string[]; routingNote: string }>;
    return {
      id: row.modelId,
      name: typeof profile.name === "string" ? profile.name : row.modelId,
      provider: typeof profile.provider === "string" ? profile.provider : "",
      apiModelId: typeof profile.apiModelId === "string" ? profile.apiModelId : row.modelId,
      source: "catalog",
      sizes: Array.isArray(profile.sizes) ? profile.sizes : [],
      qualities: Array.isArray(profile.qualities) ? profile.qualities : [],
      routingNote: typeof profile.routingNote === "string" ? profile.routingNote : null,
      useCase: null,
      served: null,
      problem: row.problem,
      draft: (row.draft as ImageDraft | null) ?? null,
      draftCreatedAt: row.draftCreatedAt ?? null,
      draftReview: row.draftReview ?? null,
      raw: row,
    };
  });
  return [...pending, ...served];
};

// --- coding ------------------------------------------------------------------
// The same four steps for a coding model, whose draft is a whole profile
// (name, plan, capabilities and prices). The judge is judgeCodingModel on the
// server; these only read its answer.

export type CodingProfileView = {
  name: string;
  provider: string;
  apiModelId: string;
  minimumPlan: "Free" | "Pro" | "Max";
  capabilities: {
    toolCalling: string;
    structuredOutput: string;
    imageInput: boolean;
    maxContextTokens: number;
    maxOutputTokens: number;
  };
  pricing: { inputUsdPerMTok: number; outputUsdPerMTok: number; creditWeight: number; verifiedAt: string; sources: string[]; pricingVersion?: string };
  /** Carried only by a row stored or published with provider conditions; never judged (owner decision 2026-11-21). */
  terms?: { allowsResaleAndCodingAgent: boolean; url: string; checkedAt: string };
  retention?: { url: string; checkedAt: string };
  processingRegion?: string;
  /**
   * A dedicated draft's basis (lib/modelCatalogCore.ts codingDraftBasisSchema):
   * whether the output cap is the pages' or the 8,192 default, and the input-size
   * price tiers the pages list. Absent on rows drafted before it and on resolved rows.
   */
  basis?: {
    maxOutputTokens: "documented" | "default";
    priceTiers?: { upToInputTokens: number | null; inputUsdPerMTok: number; outputUsdPerMTok: number }[];
  };
};

/** A resolved row reads the same as a profile. */
export type CodingResolvedView = CodingProfileView;

/** A chat registry model as the server reported it (lib/modelCatalogCore.ts ChatModelFacts). */
export type ChatFactsView = {
  id: string;
  name: string;
  provider: string;
  apiModelId: string;
  minimumPlan: "Free" | "Pro";
  usageClass: string;
  creditWeight: number;
  enabled: boolean;
  status: string;
  publiclyListed: boolean;
  catalogDeleted: boolean;
  contextWindowTokens: number | null;
  maxOutputTokens: number;
  imageInput: boolean;
  price: { inputUsdPerMTok: number; outputUsdPerMTok: number; pricingVersion: string; effectiveDate: string; verified: boolean };
};

/**
 * A coding row's strengths and weaknesses at coding work (owner decision
 * 2026-11-22; lib/modelCatalogCore.ts codingNotesSchema): what the coding API's
 * router reads instead of chat's bestFor. Empty sources: written by the operator.
 */
export type CodingNotesView = {
  strengths: string[];
  weaknesses: string[];
  sources: string[];
  draftedAt: string;
  editedAt?: string;
};

/** The limits a note is held to (lib/modelCatalogCore.ts CODING_NOTE_MAX_CHARS, CODING_NOTES_MAX_ITEMS). */
export const CODING_NOTE_MAX_CHARS = 120;
export const CODING_NOTES_MAX_ITEMS = 3;

const looksLikeNotes = (value: unknown): value is CodingNotesView => {
  const v = value as Partial<CodingNotesView> | null;
  return Boolean(v && Array.isArray(v.strengths) && Array.isArray(v.weaknesses) && Array.isArray(v.sources));
};

/** A stored row's notes when it has at least one; null when it has none. */
export const codingNotesFrom = (stored: unknown): CodingNotesView | null => {
  const notes = (stored as { codingNotes?: unknown } | null)?.codingNotes;
  return looksLikeNotes(notes) && notes.strengths.length + notes.weaknesses.length > 0 ? notes : null;
};

/** One list as typed in a textarea: one note per line, blank lines dropped. */
export const codingNoteLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);

export type CodingNotesProblem = "too_many" | "too_long";

/** What the typed notes would be refused for (the server holds them to the same limits). */
export const codingNotesProblems = (value: { strengths: string; weaknesses: string }): Partial<Record<"strengths" | "weaknesses", CodingNotesProblem>> => {
  const problems: Partial<Record<"strengths" | "weaknesses", CodingNotesProblem>> = {};
  for (const field of ["strengths", "weaknesses"] as const) {
    const lines = codingNoteLines(value[field]);
    if (lines.length > CODING_NOTES_MAX_ITEMS) problems[field] = "too_many";
    else if (lines.some((line) => line.length > CODING_NOTE_MAX_CHARS)) problems[field] = "too_long";
  }
  return problems;
};

/** The settings request for typed notes: null when both lists are empty (the notes are removed). */
export const codingNotesRequest = (value: { strengths: string; weaknesses: string }) => {
  const strengths = codingNoteLines(value.strengths);
  const weaknesses = codingNoteLines(value.weaknesses);
  return strengths.length + weaknesses.length === 0 ? null : { strengths, weaknesses };
};

/** A chat link's own stored values. */
export type CodingLinkView = {
  registryModelId: string;
  capabilities: { toolCalling: string; structuredOutput: string };
  minimumPlan?: "Free" | "Pro" | "Max";
  creditWeight?: number;
  channels: string[];
  evidence?: { sources: string[]; draftedAt: string; toolCalling: string; structuredOutput: string; note?: string };
};

export const CODING_PLANS = ["Free", "Pro", "Max"] as const;
/**
 * The channels the screen shows and sets: Code, and the coding API (owner
 * decision 2026-11-21). A row stored with the older "cli" channel reads as the
 * coding API; saving writes "api".
 */
export const CODING_CHANNEL_ORDER = ["code", "api"] as const;
export const codingChannelsShown = (channels: readonly string[]): string[] =>
  CODING_CHANNEL_ORDER.filter((channel) => (channel === "api" ? channels.includes("api") || channels.includes("cli") : channels.includes(channel)));
export const CODING_TOOL_CALLING_VALUES = ["none", "basic", "parallel"] as const;
/**
 * The two structured output choices the screen shows and saves (owner decision
 * 2026-11-22; lib/modelCatalogCore.ts CODING_STRUCTURED_OUTPUT_CHOICES).
 */
export const CODING_STRUCTURED_OUTPUT_VALUES = ["supported", "none"] as const;
/**
 * A stored value as the screen shows it. A finer value stored before the two
 * choices ("json_mode", "strict_schema", ...) reads as supported and stays
 * stored as it is until the operator saves the row's settings.
 */
export const codingStructuredOutputShown = (value: string): (typeof CODING_STRUCTURED_OUTPUT_VALUES)[number] =>
  value === "none" ? "none" : "supported";

/**
 * A dedicated row's two credits (owner decision 2026-11-21): Code's
 * managed-path credits, and the coding API's -- the chat rule's minimum unless
 * the operator set a higher override (lib/codingRowRuntime.ts codingApiCreditView).
 */
export type CodingApiCreditView = {
  codeCredits: number;
  override: number | null;
  floorCredits: number | null;
  credits: number | null;
  basis: "chat_rule_floor" | "api_override" | null;
  refusal: string | null;
};

export type CodingCatalogItem = {
  id: string;
  name: string;
  provider: string;
  apiModelId: string;
  enabled: boolean | null;
  holdReason: string | null;
  /** Dedicated (a whole profile here) or a chat link; null when the row cannot be read. */
  source: "dedicated" | "chat" | null;
  /** Where it is offered once on. */
  channels: string[];
  /** Each channel's own answer (null: not offered there). A chat link can pass the coding API and not Code. */
  channelAdmission: { code: Admission | null; api: Admission | null };
  /** The stored channels the row passes on. */
  effectiveChannels: string[];
  /** A chat link whose chat model has no context window (Code refuses it). */
  contextUnknown: boolean;
  /** A chat link's stored values, and the chat model it reads. */
  link: CodingLinkView | null;
  chat: ChatFactsView | null;
  /** The resolved model (a dedicated profile, or a link with chat's values read in). */
  profile: CodingResolvedView | null;
  /** The credit weight's floor at the stored profile's prices. */
  floor: number | null;
  /** A dedicated row's coding API credits; null for a link or an unreadable row. */
  apiCredit: CodingApiCreditView | null;
  problem: string | null;
  admission: Admission | null;
  draft: CodingProfileView | null;
  draftCreatedAt: string | null;
  /** The draft's floor and the judge's reasons at the draft's own values. */
  draftReview: { floor: number | null; reasons: string[] } | null;
  /** The row's coding notes, from the stored row; null when it has none. */
  codingNotes: CodingNotesView | null;
  raw: unknown;
};

/** The image stages without the image budget one (coding has no per-provider budget). */
export type CodingStage = Exclude<ImageStage, "needs_budget">;

const looksLikeCodingProfile = (value: unknown): value is CodingProfileView => {
  const v = value as Partial<CodingProfileView> | null;
  return Boolean(v && typeof v.name === "string" && v.pricing && v.capabilities);
};

const looksLikeResolvedRow = (value: unknown): value is CodingResolvedView => {
  const v = value as Partial<CodingResolvedView> | null;
  return Boolean(v && typeof v.name === "string" && v.pricing && v.capabilities);
};

const looksLikeLink = (value: unknown): value is CodingLinkView => {
  const v = value as (Partial<CodingLinkView> & { source?: unknown }) | null;
  return Boolean(v && v.source === "chat" && typeof v.registryModelId === "string" && v.capabilities && Array.isArray(v.channels));
};

export const codingCatalogItems = (report: {
  models: Array<{
    modelId: string;
    enabled: boolean | null;
    holdReason: string | null;
    source?: "dedicated" | "chat" | null;
    profile: unknown;
    stored?: unknown;
    chat?: ChatFactsView | null;
    channelAdmission?: { code: Admission | null; api: Admission | null };
    effectiveChannels?: string[];
    contextUnknown?: boolean;
    problem: string | null;
    admission: Admission | null;
    draft: unknown;
    draftCreatedAt?: string | null;
    floor?: number | null;
    apiCredit?: CodingApiCreditView | null;
    draftReview?: { floor: number | null; reasons: string[] } | null;
  }>;
}): CodingCatalogItem[] =>
  report.models.map((row) => {
    const profile = looksLikeResolvedRow(row.profile) ? row.profile : null;
    const draft = looksLikeCodingProfile(row.draft) ? row.draft : null;
    const link = looksLikeLink(row.stored) ? row.stored : null;
    const shown = draft ?? profile;
    const channels = codingChannelsShown((profile as { channels?: string[] } | null)?.channels ?? link?.channels ?? ["code"]);
    return {
      id: row.modelId,
      name: profile?.name ?? row.chat?.name ?? draft?.name ?? row.modelId,
      provider: shown?.provider ?? row.chat?.provider ?? "",
      apiModelId: shown?.apiModelId ?? row.chat?.apiModelId ?? row.modelId,
      enabled: row.enabled,
      holdReason: row.holdReason,
      source: row.source ?? (link ? "chat" : profile || draft ? "dedicated" : null),
      channels,
      channelAdmission: row.channelAdmission ?? { code: null, api: null },
      effectiveChannels: codingChannelsShown(row.effectiveChannels ?? []),
      contextUnknown: row.contextUnknown ?? false,
      link,
      chat: row.chat ?? null,
      profile,
      floor: row.floor ?? null,
      apiCredit: row.apiCredit ?? null,
      problem: row.problem,
      admission: row.admission,
      draft,
      draftCreatedAt: row.draftCreatedAt ?? null,
      draftReview: row.draftReview ?? null,
      codingNotes: codingNotesFrom(row.stored),
      raw: row,
    };
  });

export const codingStage = (item: CodingCatalogItem): CodingStage => {
  if (item.draft) return "draft_ready";
  if (!item.profile) {
    if (item.problem === "invalid_profile") return "profile_invalid";
    // A link whose chat model cannot be read is refused, not waiting for a draft.
    return item.source === "chat" || (item.problem !== null && item.problem !== "no_profile") ? "blocked" : "needs_draft";
  }
  if (item.holdReason || item.enabled === false) return "held";
  if (item.admission?.admitted) return item.enabled === true ? "serving" : "ready_to_enable";
  return "blocked";
};

/** Every reason this model cannot be turned on now: the judge's. */
export const codingRefusals = (item: CodingCatalogItem): string[] => [
  ...new Set(item.admission?.admitted ? [] : (item.admission?.reasons ?? (item.problem ? [item.problem] : []))),
];

/** The list's three words: on, needs a check, off. */
export type CodingListState = "active" | "attention" | "inactive";
export const codingListState = (item: CodingCatalogItem): CodingListState => {
  const stage = codingStage(item);
  if (stage === "serving") return "active";
  if (stage === "held") return "inactive";
  return "attention";
};

export type CodingListFilter = { query: string; provider: string; source: "all" | "dedicated" | "chat"; state: "all" | CodingListState };

/** Rows matching the list's filters. */
export const filterCodingItems = (items: readonly CodingCatalogItem[], filter: CodingListFilter): CodingCatalogItem[] => {
  const query = filter.query.trim().toLowerCase();
  return items.filter(
    (item) =>
      (filter.provider === "all" || item.provider === filter.provider) &&
      (filter.source === "all" || item.source === filter.source) &&
      (filter.state === "all" || codingListState(item) === filter.state) &&
      (!query || [item.name, item.provider, item.apiModelId, item.id].some((value) => value.toLowerCase().includes(query)))
  );
};

export type CodingSettingsValue = {
  toolCalling: string;
  structuredOutput: string;
  /** "" follows the chat model. */
  minimumPlan: string;
  /** "" follows the chat model's weight. */
  creditWeight: string;
  channels: string[];
};

/**
 * The settings form's starting values from a link's stored ones. Structured
 * output starts at its shown choice; a finer stored value is written as that
 * choice only when the operator saves (codingSettingsRequest).
 */
export const codingSettingsFrom = (link: CodingLinkView): CodingSettingsValue => ({
  toolCalling: link.capabilities.toolCalling,
  structuredOutput: codingStructuredOutputShown(link.capabilities.structuredOutput),
  minimumPlan: link.minimumPlan ?? "",
  creditWeight: link.creditWeight === undefined ? "" : String(link.creditWeight),
  channels: codingChannelsShown(link.channels),
});

/** The weight a link would charge with these settings: its own, or chat's. */
export const effectiveCreditWeight = (value: CodingSettingsValue, chatWeight: number | null): number | null =>
  value.creditWeight.trim() === "" ? chatWeight : Number(value.creditWeight);

export type CodingSettingsProblem = "not_a_number" | "below_floor" | "none_selected";

/**
 * What the settings would be refused or held back for. A malformed weight or
 * no channel is an input error; a weight below the floor is saved but cannot
 * be turned on (the server refuses it for a serving model).
 */
export const codingSettingsProblems = (
  value: CodingSettingsValue,
  input: { floor: number | null; chatWeight: number | null }
): Partial<Record<"creditWeight" | "channels", CodingSettingsProblem>> => {
  const problems: Partial<Record<"creditWeight" | "channels", CodingSettingsProblem>> = {};
  if (value.channels.length === 0) problems.channels = "none_selected";
  if (value.creditWeight.trim() !== "") {
    const weight = Number(value.creditWeight);
    if (!Number.isInteger(weight) || weight <= 0 || weight > 1_000) problems.creditWeight = "not_a_number";
  }
  const weight = effectiveCreditWeight(value, input.chatWeight);
  if (!problems.creditWeight && weight !== null && input.floor !== null && weight < input.floor) problems.creditWeight = "below_floor";
  return problems;
};

/** The settings request: only the fields that differ from the stored link. */
export const codingSettingsRequest = (link: CodingLinkView, value: CodingSettingsValue) => {
  const out: {
    toolCalling?: string;
    structuredOutput?: string;
    minimumPlan?: string | null;
    creditWeight?: number | null;
    channels?: string[];
  } = {};
  const before = codingSettingsFrom(link);
  if (value.toolCalling !== before.toolCalling) out.toolCalling = value.toolCalling;
  if (value.structuredOutput !== before.structuredOutput) out.structuredOutput = value.structuredOutput;
  if (value.minimumPlan !== before.minimumPlan) out.minimumPlan = value.minimumPlan === "" ? null : value.minimumPlan;
  if (value.creditWeight.trim() !== before.creditWeight) out.creditWeight = value.creditWeight.trim() === "" ? null : Number(value.creditWeight);
  const channels = CODING_CHANNEL_ORDER.filter((channel) => value.channels.includes(channel));
  if (channels.join(",") !== before.channels.join(",")) out.channels = channels;
  // A save of a link stored with a finer structured output value writes it as
  // the shown choice; with nothing else changed nothing is sent, so the row
  // (and its snapshot hash) stays as it is.
  const stored = link.capabilities.structuredOutput;
  if (Object.keys(out).length > 0 && out.structuredOutput === undefined && !(CODING_STRUCTURED_OUTPUT_VALUES as readonly string[]).includes(stored)) {
    out.structuredOutput = value.structuredOutput;
  }
  return out;
};

/**
 * Whether a "fill all" run may start its next paid call after one row failed.
 * An unknown outcome stops it: a client-side timeout, the server's own LLM
 * timeout (504 `timeout_outcome_unknown`) or a network error may each have left
 * a paid call running or its write landed, so no further call starts. A lost
 * session stops it too. Any other refusal is about that row and the run goes on.
 */
export const fillRunStop = (result: { timedOut: boolean; code?: string }): "continue" | "unknown_outcome" | "session" => {
  if (result.timedOut || result.code === "timeout_outcome_unknown" || result.code === "network_error") return "unknown_outcome";
  if (result.code === "session_expired") return "session";
  return "continue";
};

/**
 * A dedicated row's settings form (owner decision 2026-11-21): its channels,
 * and its coding API credits. The override is read only while the coding API
 * is ticked -- with it off the field is hidden, so neither its value nor its
 * check holds the save back, and nothing about it is sent.
 */
export const codingDedicatedSettings = (input: {
  channels: readonly string[];
  storedChannels: readonly string[];
  /** The override field as typed; "" is the chat rule's minimum. */
  override: string;
  storedOverride: number | null;
}) => {
  const ordered = CODING_CHANNEL_ORDER.filter((channel) => input.channels.includes(channel));
  const channelsChanged = ordered.join(",") !== input.storedChannels.join(",");
  const onApi = ordered.includes("api");
  const typed = input.override.trim() === "" ? null : Number(input.override.trim());
  const overrideInvalid = onApi && typed !== null && (!Number.isInteger(typed) || typed <= 0 || typed > 1_000);
  const overrideChanged = onApi && !overrideInvalid && typed !== input.storedOverride;
  const request: { channels?: string[]; apiCreditWeight?: number | null } = {
    ...(channelsChanged ? { channels: ordered } : {}),
    ...(overrideChanged ? { apiCreditWeight: typed } : {}),
  };
  return {
    onApi,
    typed,
    overrideInvalid,
    canSave: ordered.length > 0 && !overrideInvalid && (channelsChanged || overrideChanged),
    request,
  };
};

/** Whether the stored profile is what the Code client is served now. */
export const codingServing = (item: CodingCatalogItem) =>
  item.profile !== null && item.enabled === true && !item.holdReason && item.admission?.admitted === true;

/**
 * A coding profile has no form to fix: an invalid one is replaced by a new
 * draft, so the first step's action is "make a new draft" too.
 */
export const codingNextAction = (stage: CodingStage): ImageNextAction =>
  stage === "profile_invalid" ? "redraft" : imageNextAction(stage);

export const codingNeedsAction = (stage: CodingStage) => stage !== "serving" && stage !== "held";

export type CodingEditValue = { name?: string; minimumPlan?: string; creditWeight?: string };
export type CodingEditProblem = "name_invalid" | "not_a_number" | "below_floor";

/** The operator's edits to a draft, checked the way the server will check them. */
export const codingEditProblems = (
  draft: Pick<CodingProfileView, "name" | "pricing">,
  edits: Readonly<CodingEditValue>,
  floor: number | null
): Partial<Record<"name" | "creditWeight", CodingEditProblem>> => {
  const problems: Partial<Record<"name" | "creditWeight", CodingEditProblem>> = {};
  const name = (edits.name ?? draft.name).trim();
  if (name.length === 0 || name.length > 80) problems.name = "name_invalid";
  const weight = edits.creditWeight === undefined ? draft.pricing.creditWeight : Number(edits.creditWeight);
  if (!Number.isInteger(weight) || weight <= 0 || weight > 1_000) problems.creditWeight = "not_a_number";
  else if (floor !== null && weight < floor) problems.creditWeight = "below_floor";
  return problems;
};

/** The apply request's codingEdit: only the fields that differ from the draft. */
export const codingEdit = (
  draft: Pick<CodingProfileView, "name" | "minimumPlan" | "pricing">,
  edits: Readonly<CodingEditValue>
): { name?: string; minimumPlan?: string; creditWeight?: number } => {
  const out: { name?: string; minimumPlan?: string; creditWeight?: number } = {};
  const name = edits.name?.trim();
  if (name !== undefined && name !== draft.name) out.name = name;
  if (edits.minimumPlan !== undefined && edits.minimumPlan !== draft.minimumPlan) out.minimumPlan = edits.minimumPlan;
  if (edits.creditWeight !== undefined && Number(edits.creditWeight) !== draft.pricing.creditWeight) {
    out.creditWeight = Number(edits.creditWeight);
  }
  return out;
};

/** The URLs a coding draft reads: the price page, or the provider's default (owner decision 2026-11-21: no terms or retention pages). */
export const codingDraftSources = (input: { priceUrl: string }, defaultSources: readonly string[]): string[] => {
  const price = input.priceUrl.trim() || defaultSources[0] || "";
  return price ? [price] : [];
};


// --- the coding tab's report (GET /api/admin/model-catalog/coding) -----------

export type CodingCandidateView = ChatFactsView;

/** What "Add chat models" answers (POST link_all): how many were added, and the judge's reasons for the rest. */
export type CodingLinkAllResult = {
  attempted: number;
  /** Added on the coding API. */
  added: string[];
  /** Of those, also on Code. */
  withCode: string[];
  refused: { modelId: string; reasons: string[] }[];
  reasonCounts: Record<string, number>;
  /** Why the added models without Code are not on Code. */
  codeReasonCounts: Record<string, number>;
  codeRefused: { modelId: string; reasons: string[] }[];
};

/**
 * Refusal reasons of a link-all run, most common first. `sample` is the first
 * full reason of that name (it keeps the detail the count dropped, such as the
 * credit floor), which the screen turns into words.
 */
export const linkAllReasonRows = (
  result: Pick<CodingLinkAllResult, "reasonCounts" | "refused">
): { reason: string; sample: string; count: number }[] => reasonCountRows(result.reasonCounts, result.refused);

/** The same rows for why the added models are not on Code. */
export const linkAllCodeReasonRows = (
  result: Pick<CodingLinkAllResult, "codeReasonCounts" | "codeRefused">
): { reason: string; sample: string; count: number }[] => reasonCountRows(result.codeReasonCounts, result.codeRefused);

const reasonCountRows = (counts: Record<string, number>, refused: readonly { reasons: string[] }[]) =>
  Object.entries(counts)
    .map(([reason, count]) => ({
      reason,
      sample: refused.flatMap((row) => row.reasons).find((full) => full.split(":")[0] === reason) ?? reason,
      count,
    }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

/**
 * Where a link's two capability values came from: the chat registry (a link
 * made without pages), or an LLM draft that read the provider's documentation
 * (a link made before owner decision 2026-11-21).
 */
export const capabilityOrigin = (link: Pick<CodingLinkView, "evidence">): "registry" | "llm" =>
  link.evidence && link.evidence.sources.length > 0 ? "llm" : "registry";

export type CodingSnapshotView = {
  version: number;
  contentHash: string;
  coverageUntil: string;
  publishedAt: string;
  modelCount: number;
  current: boolean;
  pendingChanges: { modelId: string; kind: "added" | "removed" | "changed" }[];
  /** False when the next publish would change the hash even with no row changed (the scheduled renewal waits for it). */
  contentHashMatches: boolean;
};

export type CodingCatalogReport = Parameters<typeof codingCatalogItems>[0] & {
  candidates: { eligible: CodingCandidateView[]; excluded: { id: string; name: string; provider: string; reason: string }[] };
  snapshot: CodingSnapshotView | null;
  servableCount: number;
  externalChannels: { enabled: boolean; env: string };
  draftLlm: { configured: boolean; env: string };
  /** "Fill capabilities with the LLM": the draft model is set, and these providers have default documentation pages. */
  capabilityFill: { configured: boolean; env: string; providers: string[] };
  draftProviders: { provider: string; defaultSources: string[]; hosts: string[] }[];
};

/** How many models wait on each kind of check, for the summary tile. */
export const codingAttentionCounts = (items: readonly CodingCatalogItem[]) => {
  let floor = 0;
  let other = 0;
  for (const item of items) {
    if (codingListState(item) !== "attention") continue;
    if (codingRefusals(item).some((reason) => reason.startsWith("credits_below_floor"))) floor += 1;
    else other += 1;
  }
  return { floor, other };
};

/**
 * The rows a fill run is for (lib/codingCatalogAdmin.ts capabilitiesNeedFilling):
 * chat links that still carry the registry's conservative capability values
 * (structured output None, or no documentation read), and any readable row --
 * a link or a dedicated row -- with no coding notes yet (owner decision
 * 2026-11-22), split into the ones the LLM can fill (the provider has default
 * pages) and the ones it cannot.
 */
export const capabilityFillTargets = (
  items: readonly CodingCatalogItem[],
  providers: readonly string[]
): { targets: CodingCatalogItem[]; unsupported: CodingCatalogItem[] } => {
  const needing = items.filter((item) => {
    if (item.source === "chat") {
      if (item.link === null) return false;
      return item.link.capabilities.structuredOutput === "none" || capabilityOrigin(item.link) === "registry" || item.codingNotes === null;
    }
    return item.source === "dedicated" && item.profile !== null && item.codingNotes === null;
  });
  return {
    targets: needing.filter((item) => providers.includes(item.provider)),
    unsupported: needing.filter((item) => !providers.includes(item.provider)),
  };
};
