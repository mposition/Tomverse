/**
 * The registry entry a discovered model would become, proposed from what the
 * catalogue scan already knows.
 *
 * ## Why this exists
 *
 * Discovery and the registry are two tabs of one screen and nothing joined
 * them. An operator who decided to adopt a model read its identifier off the
 * queue, switched tabs, and retyped every field into an empty form -- including
 * the context window and output ceiling that the daily scan had already stored
 * against that exact model. Retyping what we hold is how a 1,048,576-token
 * context window becomes 1,048,567.
 *
 * ## What it will and will not propose
 *
 * Deliberately pure, and deliberately incomplete. Three kinds of field:
 *
 *   * `provider_catalogue` -- the provider said so this morning. Copied.
 *   * `derived` -- computed here from a rule that is written down, mostly the
 *     credit floor below.
 *   * `needs_decision` -- a product or money decision. Left for a person and
 *     named in `unknowns`, never guessed.
 *
 * The last category is the point. A draft that silently filled in a plan tier
 * or a sale price would be this module deciding what it is not allowed to
 * decide, and the operator would be approving a number nobody chose.
 */

import {
  getInputCreditMultiplier,
  MODEL_USAGE_CREDIT_WEIGHTS,
  type ModelUsageClass,
} from "@/lib/models";
import { COST_PER_CREDIT_CEILING_MICRO_USD } from "@/lib/chatCostGuardrails";
import {
  candidateFamilyIdentity,
  modelProductSurface,
} from "@/lib/modelLifecycleTriage";
import { adoptionTransitionPath } from "@/lib/modelLifecycleWorkItemCore";

/**
 * The largest prompt a user can send, from `CHAT_USER_MAX_INPUT_TOKENS`.
 *
 * Hard-coded rather than read from the environment because this module is pure
 * and because the floor is a *design* figure: it answers "is this class safe
 * for this price at the worst request we accept", and lowering the accepted
 * request size later must not quietly lower a class that is already live.
 */
export const WORST_CASE_INPUT_TOKENS = 128_000;

/** The classes a chat model can be sold under, cheapest first. */
const CLASS_CREDITS: ReadonlyArray<{
  usageClass: ModelUsageClass;
  credits: number;
}> = [
  { usageClass: "standard", credits: MODEL_USAGE_CREDIT_WEIGHTS.standard },
  { usageClass: "advanced", credits: MODEL_USAGE_CREDIT_WEIGHTS.advanced },
  { usageClass: "premium", credits: MODEL_USAGE_CREDIT_WEIGHTS.premium },
  { usageClass: "reasoning", credits: MODEL_USAGE_CREDIT_WEIGHTS.reasoning },
  {
    usageClass: "premium-reasoning",
    credits: MODEL_USAGE_CREDIT_WEIGHTS.premiumReasoning,
  },
];

export type CreditFloor = {
  /** The cheapest class whose credits still cover the worst accepted turn. */
  usageClass: ModelUsageClass;
  credits: number;
  /** What that turn costs this application, in micro-USD. */
  worstCaseMicroUsd: number;
  /** What those credits are allowed to buy, in micro-USD. */
  coverMicroUsd: number;
  inputTokens: number;
  outputTokens: number;
  inputMultiplier: number;
};

export type CreditFloorRefusal = {
  reason: "price_unknown" | "output_cap_unknown" | "above_every_class";
  /** The worst-case cost, when it could be computed at all. */
  worstCaseMicroUsd: number | null;
};

const positive = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;

/**
 * The cheapest usage class that can carry this model's price.
 *
 * Same arithmetic as the guardrail derivation in `lib/chatCostGuardrails.ts`,
 * pointed the other way. That comment works out what one credit may cost by
 * pricing the worst legitimate turn against the most expensive premium model;
 * this asks, for a model whose price we now know, which class buys enough
 * credits to cover the same turn.
 *
 *     worst turn = 128,000 input tokens at the model's input price
 *                + its full output cap at its output price
 *     a class covers it when
 *                  credits x input multiplier x 40,000 micro-USD >= that cost
 *
 * A **floor**, never an answer. What Tomverse charges is a product decision
 * that may sit anywhere above it, and `perplexity/sonar` is on record as a
 * model whose sale price is held deliberately above what arithmetic alone would
 * say (docs/policy/perplexity-sonar-credit-price-hold.md). What the floor does
 * is make the *unsafe* choice visible before it is saved rather than after a
 * month of billing.
 *
 * ## What it does not price
 *
 * Base tokens, at one price, with the caller's input premium. It does not
 * price a provider's native search per query, long-context price tiers, or
 * reasoning tokens billed apart from output. A model carrying any of those is
 * more expensive than this says, so the floor is a lower bound on a lower
 * bound -- safe to refuse a class with, never enough to justify one.
 */
export const suggestCreditFloor = (input: {
  inputUsdPerMillionTokens: number | null;
  outputUsdPerMillionTokens: number | null;
  maxOutputTokens: number | null;
  /**
   * What the costliest input token on this provider costs relative to the list
   * price -- Anthropic's five-minute prompt cache writes at 1.25x, everyone
   * else at 1.
   *
   * Here because leaving it out made the floor claim more than it could keep:
   * at US$5/US$25 with an 8,192-token cap the base arithmetic says premium
   * covers the worst turn (844,800 of 960,000 micro-USD), and the same turn
   * with every input token written to cache costs 1,004,800 -- above the cover
   * the panel had just shown. A floor that is quietly below the real worst case
   * is worse than no floor, because it is the number somebody trusts.
   */
  inputPriceMultiplier?: number;
  /**
   * The largest prompt this deployment accepts, from `CHAT_USER_MAX_INPUT_TOKENS`.
   *
   * Passed in rather than assumed. The runtime reads it from the environment,
   * and a deployment that had raised it to 200,000 was shown a floor computed
   * for 128,000 -- short of the real worst turn by 14,800 micro-USD, with no
   * extra credits to cover the gap because the input multiplier stops rising
   * above 100,000 tokens.
   */
  worstCaseInputTokens?: number;
}): CreditFloor | CreditFloorRefusal => {
  const listInputPrice = positive(input.inputUsdPerMillionTokens);
  const outputPrice = positive(input.outputUsdPerMillionTokens);
  const outputTokens = positive(input.maxOutputTokens);
  if (listInputPrice === null || outputPrice === null) {
    return { reason: "price_unknown", worstCaseMicroUsd: null };
  }
  if (outputTokens === null) {
    return { reason: "output_cap_unknown", worstCaseMicroUsd: null };
  }
  const inputPrice = listInputPrice * (positive(input.inputPriceMultiplier) ?? 1);
  const inputTokens =
    positive(input.worstCaseInputTokens) ?? WORST_CASE_INPUT_TOKENS;

  // Tokens times USD-per-million is already micro-USD: 128,000 tokens at
  // US$5/M is 640,000 micro-USD.
  const worstCaseMicroUsd = inputTokens * inputPrice + outputTokens * outputPrice;
  const inputMultiplier = getInputCreditMultiplier(inputTokens);

  for (const { usageClass, credits } of CLASS_CREDITS) {
    const coverMicroUsd =
      credits * inputMultiplier * COST_PER_CREDIT_CEILING_MICRO_USD;
    if (coverMicroUsd < worstCaseMicroUsd) continue;
    return {
      usageClass,
      credits,
      worstCaseMicroUsd,
      coverMicroUsd,
      inputTokens,
      outputTokens,
      inputMultiplier,
    };
  }
  // Every class is too cheap for this model. Not a number to round up to: it
  // means the price is outside what the credit system was sized for, and
  // somebody has to decide whether the ceiling moves or the model waits.
  return { reason: "above_every_class", worstCaseMicroUsd };
};

export const isCreditFloor = (
  value: CreditFloor | CreditFloorRefusal
): value is CreditFloor => "usageClass" in value;

/** What the catalogue scan stored about a model, as far as this cares. */
export type AdoptionObservation = {
  displayName?: string | null;
  metadata?: {
    contextLength?: number | null;
    inputTokenLimit?: number | null;
    outputTokenLimit?: number | null;
    vision?: boolean | null;
    thinking?: boolean | null;
  } | null;
};

export type AdoptionFieldSource =
  | "provider_catalogue"
  | "derived"
  | "needs_decision";

export type ModelAdoptionDraft = {
  /**
   * Prefilled registry fields.
   *
   * The nulls are load-bearing. A registry row's price columns inherit the code
   * profile while they are `NULL` and become an administrator override the
   * moment they hold a number -- including zero. A draft that left the form's
   * `0` in place would write "this model is free, permanently, ignore any
   * profile added later" while the panel beside it said the price was still
   * somebody's to decide.
   */
  fields: {
    id: string;
    name: string;
    apiModel: string;
    provider: string;
    contextWindowTokens: number | null;
    /**
     * Never prefilled. The provider's `outputTokenLimit` is a *capability*;
     * this column is what every request asks for. Copying one into the other is
     * the mistake `providerMaxOutputTokens` exists to record: Kimi K3's ceiling
     * equals its whole context window, and using it as the request cap left no
     * room for input at all, so every request was refused at every size.
     */
    maxOutputTokens: null;
    reservationOutputTokens: null;
    inputUsdPerMillionTokens: null;
    outputUsdPerMillionTokens: null;
    cachedInputPriceMultiplier: null;
    supportsImage: boolean;
    /** The most restrictive tier, so an unmade decision cannot open a model up. */
    minimumPlan: "Pro";
    status: "coming-soon";
    publiclyListed: false;
  };
  /**
   * What the provider says the model can do, for the operator to read while
   * deciding — never written to the registry by this draft.
   */
  observedCapabilities: {
    providerMaxOutputTokens: number | null;
  };
  sources: Record<string, AdoptionFieldSource>;
  /** Fields a person still has to answer, in the words the panel shows. */
  unknowns: string[];
};

/**
 * A registry id from the provider's own identifier.
 *
 * Dots become hyphens because that is what every id in the catalogue already
 * does -- `gpt-5.6-sol` is registered as `gpt-5-6-sol` -- and a registry id
 * ends up in URLs, ledgers and stored user settings, where a second spelling of
 * the same model is a second model.
 */
export const registryIdFromApiModel = (
  apiModel: string,
  takenIds: readonly string[] = []
) => {
  const base = apiModel
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/[./]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  const taken = new Set(takenIds);
  if (!base) return "";
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
};

export const buildAdoptionDraft = (input: {
  provider: string;
  apiModel: string;
  observation?: AdoptionObservation | null;
  takenIds?: readonly string[];
  /** Whether lib/modelPricing.ts already prices the id this draft proposes. */
  hasPricingProfile?: boolean;
}): ModelAdoptionDraft => {
  const metadata = input.observation?.metadata ?? null;
  const contextWindowTokens =
    positive(metadata?.contextLength) ?? positive(metadata?.inputTokenLimit);
  const providerMaxOutputTokens = positive(metadata?.outputTokenLimit);
  const supportsImage = metadata?.vision === true;

  const sources: Record<string, AdoptionFieldSource> = {
    id: "derived",
    name: input.observation?.displayName ? "provider_catalogue" : "derived",
    apiModel: "provider_catalogue",
    provider: "provider_catalogue",
    status: "derived",
    publiclyListed: "derived",
    minimumPlan: "needs_decision",
    maxOutputTokens: "needs_decision",
    reservationOutputTokens: "needs_decision",
    inputUsdPerMillionTokens: "needs_decision",
    outputUsdPerMillionTokens: "needs_decision",
  };
  const unknowns: string[] = [];

  if (contextWindowTokens !== null) sources.contextWindowTokens = "provider_catalogue";
  else unknowns.push("컨텍스트 윈도우 — 공급자 목록에 없습니다.");

  if (metadata?.vision === true) sources.supportsImage = "provider_catalogue";
  else if (typeof metadata?.vision !== "boolean") {
    // The parser keeps "the provider did not say" apart from "the provider said
    // no", and collapsing the two here would save a model as explicitly
    // image-blind on the strength of a field that was simply absent.
    unknowns.push("이미지 입력 지원 — 공급자 목록이 말하지 않았습니다. 미지원으로 두었습니다.");
  }

  // Named rather than guessed. Each of these is somebody's decision, and a
  // draft that filled them in would be making it.
  //
  // The price is the exception, and only when a profile already covers this
  // model: leaving the columns empty is then the *correct* answer, not an
  // unmade decision, because a null column inherits the profile's tiers and
  // schedule and a typed number replaces both for good. Telling an operator to
  // enter a price they already have would be telling them to break that.
  if (input.hasPricingProfile) {
    unknowns.push(
      "입력·출력 단가 — lib/modelPricing.ts의 profile을 상속합니다. 비워 두세요. 숫자를 넣으면 tier와 예정 가격이 영구 override 됩니다."
    );
  } else {
    unknowns.push("입력·출력 단가 — 공급자 공식 가격표에서 확인해 입력합니다.");
  }
  unknowns.push("판매 등급과 크레딧 — 최소 등급은 가격을 넣으면 계산됩니다.");
  unknowns.push("최소 플랜 — Pro로 두었습니다. 더 열려면 제품 결정이 필요합니다.");
  unknowns.push(
    providerMaxOutputTokens === null
      ? "최대 출력 토큰 — 요청마다 요구할 출력 상한을 정해야 합니다."
      : `최대 출력 토큰 — 공급자가 알린 능력 상한은 ${providerMaxOutputTokens.toLocaleString()}이지만, 요청 상한은 별개 결정입니다.`
  );
  unknowns.push(
    "예약 출력 토큰 — 능력이 아니라 entitlement이므로 출력 한도에서 유도하지 않습니다."
  );
  if (metadata?.thinking === true) {
    unknowns.push(
      "추론 강도 — 공급자가 thinking 지원을 알렸을 뿐 등급은 알리지 않습니다."
    );
  }

  return {
    fields: {
      id: registryIdFromApiModel(input.apiModel, input.takenIds ?? []),
      name: input.observation?.displayName?.trim() || input.apiModel,
      apiModel: input.apiModel,
      provider: input.provider,
      contextWindowTokens,
      maxOutputTokens: null,
      reservationOutputTokens: null,
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
      cachedInputPriceMultiplier: null,
      supportsImage,
      minimumPlan: "Pro",
      // Born switched off. The operator turns it on once the price is in and
      // the validations are clear, through the same guard every other enable
      // goes through.
      status: "coming-soon",
      publiclyListed: false,
    },
    observedCapabilities: { providerMaxOutputTokens },
    sources,
    unknowns,
  };
};

/**
 * What an adopted model still owes before it may be rolled out.
 *
 * The three the lifecycle contract names. Written on the item rather than left
 * empty because `validation_pending` with nothing pending is a state that lets
 * the next transition through: `workItemTransitionRefusal` refuses a rollout
 * only when the list is non-empty, so an empty list is not "nothing to check",
 * it is "no check".
 */
export const ADOPTION_PENDING_VALIDATIONS = ["pricing", "access", "staging"] as const;

/**
 * Why this adoption may not proceed, or null.
 *
 * Three questions, and the first two are the ones a query parameter makes
 * possible at all. A work item names one model; the body names another; nothing
 * before this compared them, so an Anthropic discovery could be closed by
 * registering an OpenAI model, and an item already linked to one row could be
 * adopted again into a second, leaving the first orphaned with no decision
 * behind it.
 *
 * Identity is compared on the collapsed family rather than the exact string,
 * because that is what "the same model" means everywhere else in this pipeline:
 * registering `claude-fable-5-1-20260901` against an item filed as
 * `claude-fable-5-1` is the same decision, and registering `gpt-other` is not.
 */
export const adoptionPreflightRefusal = (input: {
  workItem: {
    id: string;
    status: string;
    action: string;
    provider: string;
    apiModel: string;
    modelId: string | null;
  } | null;
  body: {
    /** The registry id being created, which is how a price profile is keyed. */
    id: string;
    apiModel: string;
    provider: string;
    status: string;
    publiclyListed: boolean;
    usageClass: string;
    creditWeight: number;
    inputUsdPerMillionTokens?: number | null;
    outputUsdPerMillionTokens?: number | null;
    maxOutputTokens?: number | null;
  };
  /** The exact pairs a scan has seen, from the item's own sightings. */
  observedPairs?: ReadonlyArray<{ provider: string; apiModel: string }>;
  /** Whether the registry already has a row for this provider and api model. */
  providerPairRegistered?: boolean;
  /**
   * The price the code profile already carries for this model, when one exists.
   *
   * Here because requiring the form's own numbers would force an override on a
   * model whose price is already versioned in `lib/modelPricing.ts`. A `NULL`
   * price column *inherits* that profile, tiers, schedule and all; a number
   * replaces it permanently and flattens both. So a model with a profile is
   * adopted with its price columns empty, and the floor is computed from the
   * profile instead.
   */
  profilePrice?: {
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
    maxOutputTokens?: number | null;
  } | null;
  /** `CHAT_USER_MAX_INPUT_TOKENS`, for the floor. */
  worstCaseInputTokens?: number;
  /** The costliest input token relative to list price, for the floor. */
  inputPriceMultiplier?: number;
}): { status: number; message: string } | null => {
  const { workItem } = input;
  if (!workItem) return { status: 404, message: "No such work item." };
  if (workItem.action !== "add") {
    return {
      status: 409,
      message: "Only a discovered model can be adopted into the registry.",
    };
  }
  if (workItem.modelId) {
    return {
      status: 409,
      message: `This discovery item was already adopted as ${workItem.modelId}. Adopting it again would leave that model behind with no decision against it.`,
    };
  }
  // The chat registry is not where image generation models live. Their ledger
  // is `lib/imageModelRegistry.ts`, `supportsImage` on this row means image
  // *input*, and a generation model saved here would be priced and routed as a
  // chat model.
  if (modelProductSurface(workItem.apiModel) !== "chat") {
    return {
      status: 409,
      message:
        "Only chat models are adopted into this registry. Image generation models belong to the Image Studio ledger.",
    };
  }
  if (
    candidateFamilyIdentity(input.body.apiModel) !==
    candidateFamilyIdentity(workItem.apiModel)
  ) {
    return {
      status: 409,
      message: `This work item is about ${workItem.apiModel}. Register that model, or adopt the work item that names the one you are creating.`,
    };
  }
  // Which provider will carry the requests is a real choice -- several
  // catalogues list the same model -- but it is a choice between the ones that
  // actually serve it. Without this, an Anthropic discovery could be answered
  // with a row pointing at OpenAI, and nothing downstream would notice: the
  // registry checks that a provider is *configured*, never that it serves the
  // model named beside it.
  const observedPairs = input.observedPairs?.length
    ? input.observedPairs
    : [{ provider: workItem.provider, apiModel: workItem.apiModel }];
  // The pair, not its halves. The api model is the literal string every request
  // carries upstream, so the provider that returned it is the only provider
  // that can be asked for it.
  const served = observedPairs.some(
    (pair) =>
      pair.provider.toLowerCase() === input.body.provider.toLowerCase() &&
      pair.apiModel === input.body.apiModel
  );
  if (!served) {
    return {
      status: 409,
      message: `No catalogue scan has seen ${input.body.provider} serve ${input.body.apiModel}. It was seen as ${observedPairs
        .map((pair) => `${pair.provider} ${pair.apiModel}`)
        .join(", ")}.`,
    };
  }
  if (input.providerPairRegistered) {
    return {
      status: 409,
      message: `The registry already serves ${input.body.apiModel} on ${input.body.provider}. Edit that row rather than creating a second one.`,
    };
  }
  const path = adoptionTransitionPath(
    workItem.status as Parameters<typeof adoptionTransitionPath>[0]
  );
  if (path === null) {
    return {
      status: 409,
      message: `A work item in ${workItem.status} cannot be adopted. Reopening a closed decision is a new work item.`,
    };
  }
  // An empty path means the item is already at or past `validation_pending`
  // without a model. Creating the row then records the validations it owes
  // *after* the state that was supposed to hold them, and an item already at
  // `rollout_pending` would walk straight to completed with the checks written
  // behind it. The item is in a shape adoption cannot explain, so it is refused
  // rather than half-handled.
  if (path.length === 0) {
    return {
      status: 409,
      message: `This work item is already at ${workItem.status} with no model against it. Adoption files the validations a model still owes, and this item is past the state that holds them.`,
    };
  }
  // Born switched off, enforced rather than suggested. The draft proposes
  // `coming-soon` and unlisted, and the same form can flip both before saving:
  // a model enabled here is live to users while its work item still lists
  // pricing, access and staging as owed.
  if (input.body.status === "enabled" || input.body.status === "limited") {
    return {
      status: 409,
      message:
        "An adopted model is created switched off. Enable it from the registry once pricing, access and staging are verified.",
    };
  }
  if (input.body.publiclyListed) {
    return {
      status: 409,
      message:
        "An adopted model is created unlisted. List it once it is verified and enabled.",
    };
  }
  // And if a price is known, the class has to cover it. The panel shows this
  // floor as the operator types; refusing it here is what makes the figure
  // more than decoration.
  // The row's own numbers when it has them, the code profile when it does not.
  // Either way a price this adoption can be measured against -- and a model
  // whose price lives in a profile keeps its columns null, which is what makes
  // the profile's tiers and schedule apply at all.
  const floor = suggestCreditFloor({
    inputUsdPerMillionTokens:
      input.body.inputUsdPerMillionTokens ??
      input.profilePrice?.inputUsdPerMillionTokens ??
      null,
    outputUsdPerMillionTokens:
      input.body.outputUsdPerMillionTokens ??
      input.profilePrice?.outputUsdPerMillionTokens ??
      null,
    maxOutputTokens:
      input.body.maxOutputTokens ?? input.profilePrice?.maxOutputTokens ?? null,
    worstCaseInputTokens: input.worstCaseInputTokens,
    inputPriceMultiplier: input.inputPriceMultiplier,
  });
  if (!isCreditFloor(floor)) {
    // A model nobody has priced is a model nobody can class, and the sale
    // fields cannot hold "undecided": they are non-nullable columns, so an
    // untouched form saves `standard` and one credit -- a price nobody set,
    // under a banner calling it unset. Refusing here is what makes the floor
    // below reachable at all.
    if (floor.reason === "above_every_class") {
      return {
        status: 409,
        message: `No usage class covers this price: the worst accepted turn costs US$${((floor.worstCaseMicroUsd ?? 0) / 1_000_000).toFixed(3)}. Either the credit ceiling moves or this model waits.`,
      };
    }
    return {
      status: 409,
      message:
        floor.reason === "output_cap_unknown"
          ? "An adopted model needs its maximum output tokens, so the credit floor can be computed before it is priced."
          : "An adopted model needs a price: either a profile in lib/modelPricing.ts, or the provider's input and output prices on this entry. Without one no class can be justified, and the form would save one credit by default.",
    };
  }
  if (input.body.creditWeight < floor.credits) {
    return {
      status: 409,
      message: `At this price the worst accepted turn costs US$${(floor.worstCaseMicroUsd / 1_000_000).toFixed(3)}, which needs at least ${floor.credits} credits (${floor.usageClass}). This entry sells it for ${input.body.creditWeight}.`,
    };
  }
  return null;
};

/**
 * What an item still owes after some validations are marked satisfied.
 *
 * Pure, and it answers three questions at once: what was owed, what is left,
 * and which of the names offered were not on the list. The last one matters
 * because a typo that silently clears nothing looks exactly like a validation
 * that was satisfied.
 */
export const remainingValidations = (
  pending: unknown,
  completed: readonly string[]
) => {
  const before = Array.isArray(pending)
    ? pending.filter((entry): entry is string => typeof entry === "string")
    : [];
  const owed = new Set(before);
  const unknown = completed.filter((name) => !owed.has(name));
  for (const name of completed) owed.delete(name);
  return { before, remaining: [...owed], unknown };
};
