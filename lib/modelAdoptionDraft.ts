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
 *
 * One field sits between the last two: reasoning is *proposed* from what the
 * provider says about thinking, and listed in `suggestions` so the panel will
 * not save it until somebody confirms it. A proposal the save cannot skip is
 * not a guess; it is the operator not having to find out the model thinks.
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
import {
  buildPricingProfileProposal,
  docEvidenceIsFresh,
  docPricePrefill,
  type DocEvidenceSource,
  type DocPriceRefusal,
  type ProviderModelDocParse,
  type ProviderModelDocProvider,
} from "@/lib/providerModelDocsCore";

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
    /**
     * The effort levels the provider admits, comma-joined, when it publishes
     * them at all (Anthropic's `capabilities.effort`). Carried so the draft
     * stops telling the operator the provider said nothing about depth on a
     * model whose listing named every level.
     *
     * Still not mapped onto the registry's `reasoning` field: those are the
     * provider's words for how hard the model may think, and which of them
     * Tomverse sells a model at is a product decision.
     */
    effortLevels?: string | null;
    /** Anthropic's `capabilities.pdf_input.supported`. */
    pdfInput?: boolean | null;
  } | null;
};

/** The registry's reasoning values, `none` included because the form holds it. */
export type AdoptionReasoning = "none" | "low" | "medium" | "high";

/** Every sale class, in the order the registry form lists them. */
export const ADOPTION_USAGE_CLASSES = [
  "standard",
  "advanced",
  "premium",
  "reasoning",
  "premium-reasoning",
  "research",
  "deep-research",
] as const satisfies readonly ModelUsageClass[];

/**
 * The reasoning value to *propose*, from what the provider says about thinking.
 *
 * A proposal, not a setting: the panel refuses to save it until somebody has
 * confirmed it, the same way it treats the sale class. Which depth Tomverse
 * sells a model at is a product decision; what this removes is having to know
 * the model thinks at all before making it.
 *
 * `high` unless the provider listed its effort levels and `high` is not among
 * them. That check is not cosmetic. Anthropic requests carry this value
 * verbatim as `effort` (lib/modelGenerationCompatibility.ts), so proposing a
 * level the model does not accept is a proposal that fails every request.
 * When the listed levels share nothing with the registry's three, nothing is
 * proposed and the panel says why.
 */
export const suggestReasoning = (
  metadata: AdoptionObservation["metadata"]
): { value: Exclude<AdoptionReasoning, "none"> | null; levels: string[] } => {
  const levels = (metadata?.effortLevels ?? "")
    .split(",")
    .map((level) => level.trim().toLowerCase())
    .filter(Boolean);
  if (metadata?.thinking !== true) return { value: null, levels };
  if (levels.length === 0) return { value: "high", levels };
  const value = (["high", "medium", "low"] as const).find((level) =>
    levels.includes(level)
  );
  return { value: value ?? null, levels };
};

/**
 * The provider's output ceiling as a request cap, when it is safe to be one.
 *
 * The ceiling is a capability and the column is what every request asks for.
 * They are the same number only when asking for all of it still leaves room
 * for the largest prompt this deployment accepts. Kimi K3 is the case that
 * fails: its ceiling equals its whole context window, and as a request cap it
 * left no room for input, so every request was refused at every size. The
 * guard is that failure written as arithmetic, rather than a rule that never
 * copies.
 *
 * Never copying had a cost of its own, which is why this exists. An adoption
 * of a model no pricing profile covers cannot be saved with this field blank --
 * the credit floor has no output to price -- so "never copy" meant every such
 * operator retyping a number the scan already held, and a small number typed
 * into a reasoning model's cap is `claude-sonnet-5`'s 4,096 fossil again.
 *
 * The window may be the provider's input limit when it publishes no total
 * (Anthropic's `max_input_tokens`). That is a lower bound on the real window,
 * never above it -- the largest accepted input has to fit inside it -- so a
 * cap that passes against it passes against the real window too. On that
 * figure the guard can only be stricter than necessary, never looser.
 *
 * No window at all, no copy: the arithmetic cannot be done.
 */
export const requestOutputCapFromProvider = (input: {
  providerMaxOutputTokens: number | null;
  contextWindowTokens: number | null;
  worstCaseInputTokens: number;
}):
  | { value: number; reason: "fits_with_worst_case_input" }
  | {
      value: null;
      reason: "no_provider_capability" | "no_context_window" | "leaves_no_room_for_input";
    } => {
  const cap = positive(input.providerMaxOutputTokens);
  if (cap === null) return { value: null, reason: "no_provider_capability" };
  const context = positive(input.contextWindowTokens);
  if (context === null) return { value: null, reason: "no_context_window" };
  if (cap + input.worstCaseInputTokens > context) {
    return { value: null, reason: "leaves_no_room_for_input" };
  }
  return { value: Math.floor(cap), reason: "fits_with_worst_case_input" };
};

/**
 * What an empty token field on the adoption form will save as.
 *
 * The panel greys these into the blank fields, so each has to be the value the
 * save actually produces -- a hint describing a different outcome is worse
 * than no hint.
 *
 * `maxOutputTokens` is `"required"` when no pricing profile covers the model:
 * the adoption preflight refuses a blank cap there, since the credit floor has
 * no output to price, and the class fallback a live request would otherwise
 * use is never reached. When whether a profile covers it is not yet known --
 * the lookup for a corrected id is pending or failed -- it is `null`: the
 * save's outcome turns on that profile, and a hint either way would be a guess.
 *
 * The reservation is clamped to the cap the operator typed when there is one,
 * the way a live request clamps it, and from the reservation *before* any cap
 * -- a figure already cut to the default cap cannot be un-cut.
 */
export const blankTokenFieldValues = (input: {
  /** `null` while unknown. */
  hasPricingProfile: boolean | null;
  formMaxOutputTokens: number | null;
  effective: { maxOutputTokens: number; reservationBeforeCap: number } | null;
}): {
  maxOutputTokens: number | "required" | null;
  reservationOutputTokens: number | null;
} => {
  const maxOutputTokens =
    input.hasPricingProfile === null
      ? null
      : input.hasPricingProfile
        ? input.effective?.maxOutputTokens ?? null
        : "required";
  if (!input.effective) return { maxOutputTokens, reservationOutputTokens: null };
  return {
    maxOutputTokens,
    reservationOutputTokens: Math.min(
      input.formMaxOutputTokens ?? input.effective.maxOutputTokens,
      input.effective.reservationBeforeCap
    ),
  };
};

export type AdoptionFieldSource =
  | "provider_catalogue"
  /** The provider's documentation, read by the daily enrichment. See lib/providerModelDocsCore.ts. */
  | "provider_docs"
  | "derived"
  | "needs_decision";

/** What the daily documentation read left for this model, as the draft consumes it. */
export type AdoptionDocEvidence = {
  parse: ProviderModelDocParse | null;
  /** Every document the parse read, first the one its fields came from, for the operator to open and check. */
  sources: readonly DocEvidenceSource[];
  fetchedAt: Date | null;
};

const DOC_PRICE_REFUSAL_TEXT: Record<Exclude<DocPriceRefusal, "profile_covers">, string> = {
  no_evidence: "공급자 문서에서 읽은 가격이 없습니다. 공식 가격표에서 확인해 입력합니다.",
  stale:
    "문서 증거가 오래돼 채우지 않았습니다. 그 사이 가격이 바뀌었을 수 있고, 오래된 낮은 가격이 override로 들어가면 모든 요청이 그 가격으로 과금됩니다. 공식 가격표에서 확인해 입력합니다.",
  problems: "문서를 읽었지만 구조가 예상과 달라 가격을 신뢰하지 않았습니다. 공식 가격표에서 확인해 입력합니다.",
  incomplete: "문서에 입력·출력 단가가 모두 있지 않아 채우지 않았습니다.",
  tiered:
    "문서에 장문 구간 가격이 있어 채우지 않았습니다. 이 칸은 구간을 담지 못해, 숫자를 넣으면 임계값을 넘는 요청이 모두 짧은 문맥 가격으로 과금됩니다. 아래 profile 제안으로 lib/modelPricing.ts에 등록하는 것을 권합니다.",
  long_context_unknown:
    "문서가 장문 구간 과금 여부를 말하지 않아 채우지 않았습니다. 이 칸은 구간을 담지 못하므로, 확인되지 않은 채 넣으면 과소 과금될 수 있습니다.",
  promotional:
    "문서의 가격이 프로모션 가격이라 채우지 않았습니다. 기간이 끝나면 바뀌는 가격을 고정 override로 넣지 않습니다.",
};

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
     * The provider's ceiling, only when `requestOutputCapFromProvider` finds it
     * leaves room for the largest prompt, and only when no pricing profile
     * covers the model. With a profile the null is the answer: the column
     * inherits the profile's cap, and a typed number would override it for
     * good.
     */
    maxOutputTokens: number | null;
    /**
     * Always null, and shown rather than written. A null reservation already
     * resolves to the profile's or the sale class's conservative default at
     * request time; writing that same number here would change nothing today
     * and leave a fossil that no longer follows the policy tomorrow.
     */
    reservationOutputTokens: null;
    /**
     * From the provider's documentation, only when `docPricePrefill` finds the
     * price flat, complete, not promotional and uncontested, and no profile
     * covers the model. Anything else stays null and is named in `unknowns`:
     * a number here is a permanent override that flattens tiers.
     */
    inputUsdPerMillionTokens: number | null;
    outputUsdPerMillionTokens: number | null;
    cachedInputPriceMultiplier: number | null;
    supportsImage: boolean;
    supportsNativePdf: boolean;
    /** A proposal while `suggestions.reasoning` is set; the panel makes it confirmed. */
    reasoning: AdoptionReasoning;
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
  /**
   * Values placed in `fields` that a person still has to confirm before the
   * save. Separate from `sources` because the panel gates on it.
   */
  suggestions: {
    reasoning: Exclude<AdoptionReasoning, "none"> | null;
    /**
     * The price columns were filled from provider documentation. The panel
     * will not save them until the operator confirms them against the source:
     * recognising temporary pricing by its wording is a warning, not a
     * guarantee, and the person reading the page is the check that is.
     */
    price: boolean;
  };
  sources: Record<string, AdoptionFieldSource>;
  /**
   * A `lib/modelPricing.ts` entry written from the documentation, for a person
   * to review and commit. Present above all for tiered models, whose price the
   * registry's columns cannot hold. Never applied by anything.
   */
  pricingProfileProposal: string | null;
  /** Fields a person still has to answer, in the words the panel shows. */
  unknowns: string[];
  /** Values already settled, in the words the panel shows. */
  notes: string[];
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
  /** `CHAT_USER_MAX_INPUT_TOKENS`, for whether the output ceiling leaves room. */
  worstCaseInputTokens?: number;
  /** What the daily documentation read found, if the provider is one it reads. */
  docEvidence?: AdoptionDocEvidence | null;
  /** The instant the draft is built for, for how old the evidence may be. */
  now?: Date;
  /**
   * The registry id the operator currently has in the form. The profile
   * proposal is keyed on it: a profile committed under the id this draft first
   * suggested does nothing for a model saved under a corrected one.
   */
  registryModelId?: string | null;
  /**
   * A pricing profile exists for the registry id but describes a different
   * provider or api model. A null price column would inherit it, and the
   * runtime picks a profile by id alone -- so saving under this id would bill
   * this model at another model's price.
   */
  profileForOtherPair?: { provider: string; apiModelId: string } | null;
}): ModelAdoptionDraft => {
  const metadata = input.observation?.metadata ?? null;
  const now = input.now ?? new Date();
  const evidenceFetchedAt = input.docEvidence?.fetchedAt ?? null;
  // Stale evidence fills nothing -- not the price, and not the capability
  // fields either. A page read weeks ago describes a model as it was then.
  const evidenceFresh = docEvidenceIsFresh(evidenceFetchedAt, now);
  const doc =
    evidenceFresh && input.docEvidence?.parse?.status === "parsed"
      ? input.docEvidence.parse.fields
      : null;
  const docSourceUrl = input.docEvidence?.sources[0]?.url ?? null;
  const docSource = docSourceUrl
    ? `${docSourceUrl}${
        evidenceFetchedAt
          ? ` (${evidenceFetchedAt.toISOString().slice(0, 10)} 조회)`
          : ""
      }`
    : "공급자 문서";
  // The models API first, the documentation where the API is silent. Where
  // both speak and disagree, the API wins -- it answers for this account, the
  // page for everybody -- and the disagreement is named rather than resolved
  // quietly in either direction.
  const apiContextWindow =
    positive(metadata?.contextLength) ?? positive(metadata?.inputTokenLimit);
  const contextWindowTokens = apiContextWindow ?? positive(doc?.contextWindowTokens);
  const apiMaxOutput = positive(metadata?.outputTokenLimit);
  const providerMaxOutputTokens = apiMaxOutput ?? positive(doc?.maxOutputTokens);
  const imageFromApi = typeof metadata?.vision === "boolean";
  const supportsImage = imageFromApi ? metadata?.vision === true : doc?.imageInput === true;
  const supportsNativePdf = metadata?.pdfInput === true;
  const worstCaseInputTokens =
    positive(input.worstCaseInputTokens) ?? WORST_CASE_INPUT_TOKENS;
  const outputCap = requestOutputCapFromProvider({
    providerMaxOutputTokens,
    contextWindowTokens,
    worstCaseInputTokens,
  });
  const maxOutputTokens = input.hasPricingProfile ? null : outputCap.value;
  const reasoning = suggestReasoning(metadata);

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
  // Values this draft settled on its own and the operator should leave alone.
  // Kept apart from  because the two ask for opposite actions.
  const notes: string[] = [];

  const numberText = (value: number) => value.toLocaleString("en-US");
  if (apiContextWindow !== null) {
    sources.contextWindowTokens = "provider_catalogue";
    const documented = positive(doc?.contextWindowTokens);
    if (documented !== null && documented !== apiContextWindow) {
      unknowns.push(
        `컨텍스트 윈도우 — 공급자 API는 ${numberText(apiContextWindow)}, 문서는 ${numberText(documented)}입니다. API 값을 채웠습니다.`
      );
    }
  } else if (contextWindowTokens !== null) {
    sources.contextWindowTokens = "provider_docs";
    notes.push(`컨텍스트 윈도우 — ${docSource}에서 채웠습니다.`);
  } else {
    unknowns.push("컨텍스트 윈도우 — 공급자 목록과 문서 어디에도 없습니다.");
  }

  if (imageFromApi) {
    if (metadata?.vision === true) sources.supportsImage = "provider_catalogue";
    if (typeof doc?.imageInput === "boolean" && doc.imageInput !== metadata?.vision) {
      unknowns.push(
        `이미지 입력 지원 — 공급자 API는 ${metadata?.vision ? "지원" : "미지원"}, 문서는 ${doc.imageInput ? "지원" : "미지원"}입니다. API 값을 채웠습니다.`
      );
    }
  } else if (typeof doc?.imageInput === "boolean") {
    sources.supportsImage = "provider_docs";
    notes.push(`이미지 입력 지원 — ${docSource}의 입력 modality에서 채웠습니다.`);
  } else {
    // The parser keeps "the provider did not say" apart from "the provider said
    // no", and collapsing the two here would save a model as explicitly
    // image-blind on the strength of a field that was simply absent.
    unknowns.push("이미지 입력 지원 — 공급자 목록이 말하지 않았습니다. 미지원으로 두었습니다.");
  }

  const docPrice = docPricePrefill({
    parse: input.docEvidence?.parse ?? null,
    hasPricingProfile: Boolean(input.hasPricingProfile),
    fetchedAt: evidenceFetchedAt,
    now,
  });
  if (input.docEvidence?.parse?.status === "parsed" && !evidenceFresh) {
    unknowns.push(
      `공급자 문서 — ${evidenceFetchedAt ? `${evidenceFetchedAt.toISOString().slice(0, 10)}에 읽은` : "읽은 시각을 알 수 없는"} 증거라 어떤 값도 채우지 않았습니다.`
    );
  }
  const documentedMaxOutput = positive(doc?.maxOutputTokens);
  if (apiMaxOutput !== null && documentedMaxOutput !== null && documentedMaxOutput !== apiMaxOutput) {
    unknowns.push(
      `최대 출력 상한 — 공급자 API는 ${numberText(apiMaxOutput)}, 문서는 ${numberText(documentedMaxOutput)}입니다. API 값으로 판단했습니다.`
    );
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
    // Settled, not owed. It goes in `notes` so the panel does not file it under
    // the values nobody has decided: leaving these columns empty *is* the
    // decision, and a list headed "still to decide" that contains "leave this
    // alone" tells an operator to act on it.
    notes.push(
      "입력·출력 단가 — lib/modelPricing.ts의 profile을 상속합니다. 비워 두세요. 숫자를 넣으면 tier와 예정 가격이 영구 override 됩니다."
    );
    unknowns.push("판매 등급과 크레딧 — 최소 등급은 상속 가격으로 계산됩니다.");
  } else if (docPrice.value) {
    sources.inputUsdPerMillionTokens = "provider_docs";
    sources.outputUsdPerMillionTokens = "provider_docs";
    if (docPrice.value.cachedInputPriceMultiplier !== null) {
      sources.cachedInputPriceMultiplier = "provider_docs";
    }
    // A note, but not one to leave alone: these are the override columns, and
    // the lifecycle still owes a pricing validation before rollout.
    notes.push(
      `입력·출력 단가 — ${docSource}에서 US$${docPrice.value.inputUsdPerMillionTokens} / US$${docPrice.value.outputUsdPerMillionTokens}${
        docPrice.value.cachedInputPriceMultiplier !== null
          ? `, 캐시 입력 배수 ${docPrice.value.cachedInputPriceMultiplier}`
          : ""
      }을 채웠습니다. 단일 요율로 확인된 가격이며, 저장하면 관리자 override가 됩니다. 채택 뒤 pricing 검증은 그대로 남습니다.`
    );
    unknowns.push("판매 등급과 크레딧 — 채운 가격으로 최소 등급이 계산됩니다.");
  } else {
    unknowns.push(
      `입력·출력 단가 — ${DOC_PRICE_REFUSAL_TEXT[docPrice.refusal === "profile_covers" ? "no_evidence" : docPrice.refusal]}`
    );
    if (doc?.promotional) unknowns.push(`프로모션 문구 — ${doc.promotional.note}`);
    if (doc?.longContext.kind === "tiered") {
      unknowns.push(
        `장문 구간 — 문서 기준 ${numberText(doc.longContext.thresholdTokens)} 입력 토큰 초과 시 입력 ${doc.longContext.inputMultiplier}배, 출력 ${doc.longContext.outputMultiplier}배입니다.`
      );
    }
    unknowns.push("판매 등급과 크레딧 — 최소 등급은 가격을 넣으면 계산됩니다.");
  }
  unknowns.push("최소 플랜 — Pro로 두었습니다. 더 열려면 제품 결정이 필요합니다.");
  if (input.profileForOtherPair) {
    unknowns.push(
      `Registry ID — 이 ID의 pricing profile은 다른 모델(${input.profileForOtherPair.provider} / ${input.profileForOtherPair.apiModelId})의 것입니다. 이 ID로는 저장되지 않습니다. 다른 ID를 쓰세요.`
    );
  }

  if (typeof metadata?.pdfInput === "boolean") {
    sources.supportsNativePdf = "provider_catalogue";
  } else {
    // Same distinction as image input: absent is not "no".
    unknowns.push("Native PDF — 공급자 목록이 말하지 않았습니다. 미지원으로 두었습니다.");
  }

  if (input.hasPricingProfile) {
    sources.maxOutputTokens = "derived";
    notes.push(
      "최대 출력 토큰 — lib/modelPricing.ts의 profile 상한을 상속합니다. 비워 두세요. 숫자를 넣으면 profile이 바뀌어도 따라가지 않습니다."
    );
  } else if (outputCap.value !== null) {
    sources.maxOutputTokens = apiMaxOutput !== null ? "provider_catalogue" : "provider_docs";
    notes.push(
      `최대 출력 토큰 — 공급자 상한 ${numberText(outputCap.value)}을 채웠습니다. 최대 입력 ${numberText(worstCaseInputTokens)}을 더해도 컨텍스트 ${numberText(contextWindowTokens ?? 0)} 안에 들어갑니다. profile이 없어 비우면 저장되지 않습니다.`
    );
  } else if (outputCap.reason === "leaves_no_room_for_input") {
    unknowns.push(
      `최대 출력 토큰 — 공급자 상한 ${numberText(providerMaxOutputTokens ?? 0)}에 최대 입력 ${numberText(worstCaseInputTokens)}을 더하면 컨텍스트 ${numberText(contextWindowTokens ?? 0)}를 넘어 채우지 않았습니다. 그대로 쓰면 입력 자리가 남지 않습니다. 요청 상한을 정해야 합니다.`
    );
  } else if (outputCap.reason === "no_context_window") {
    unknowns.push(
      `최대 출력 토큰 — 공급자 상한은 ${numberText(providerMaxOutputTokens ?? 0)}이지만 컨텍스트 윈도우를 몰라 입력 자리를 확인할 수 없어 채우지 않았습니다. 요청 상한을 정해야 합니다.`
    );
  } else {
    unknowns.push("최대 출력 토큰 — 공급자가 알리지 않았습니다. 요청 상한을 정해야 합니다.");
  }

  // Shown, not written: the panel greys in the value a null resolves to.
  sources.reservationOutputTokens = "derived";
  notes.push(
    "예약 출력 토큰 — 비워 두면 profile 또는 판매 등급의 정책 기본값이 적용되고, 칸에 흐리게 표시됩니다. 숫자를 넣으면 고정값이 되어 정책이 바뀌어도 따라가지 않습니다."
  );

  if (reasoning.value) {
    sources.reasoning = "needs_decision";
    unknowns.push(
      reasoning.levels.length
        ? `추론 강도 — 공급자가 알린 단계(${reasoning.levels.join(", ")}) 중 ${reasoning.value}를 제안했습니다. 확정해야 저장됩니다.`
        : `추론 강도 — 공급자가 thinking 지원을 알려 ${reasoning.value}를 제안했습니다. 단계 목록은 알리지 않았습니다. 확정해야 저장됩니다.`
    );
  } else if (metadata?.thinking === true) {
    unknowns.push(
      `추론 강도 — 공급자가 알린 단계(${reasoning.levels.join(", ")})가 레지스트리 값(low, medium, high)과 겹치지 않아 제안하지 않았습니다.`
    );
  }

  return {
    fields: {
      id: registryIdFromApiModel(input.apiModel, input.takenIds ?? []),
      name: input.observation?.displayName?.trim() || input.apiModel,
      apiModel: input.apiModel,
      provider: input.provider,
      contextWindowTokens,
      maxOutputTokens,
      reservationOutputTokens: null,
      inputUsdPerMillionTokens: docPrice.value?.inputUsdPerMillionTokens ?? null,
      outputUsdPerMillionTokens: docPrice.value?.outputUsdPerMillionTokens ?? null,
      cachedInputPriceMultiplier: docPrice.value?.cachedInputPriceMultiplier ?? null,
      supportsImage,
      supportsNativePdf,
      reasoning: reasoning.value ?? "none",
      minimumPlan: "Pro",
      // Born switched off. The operator turns it on once the price is in and
      // the validations are clear, through the same guard every other enable
      // goes through.
      status: "coming-soon",
      publiclyListed: false,
    },
    observedCapabilities: { providerMaxOutputTokens },
    suggestions: { reasoning: reasoning.value, price: Boolean(docPrice.value) },
    pricingProfileProposal:
      input.hasPricingProfile ||
      !input.docEvidence ||
      !input.docEvidence.fetchedAt ||
      (input.provider !== "openai" && input.provider !== "anthropic")
        ? null
        : buildPricingProfileProposal({
            modelId:
              input.registryModelId?.trim() ||
              registryIdFromApiModel(input.apiModel, input.takenIds ?? []),
            provider: input.provider as ProviderModelDocProvider,
            apiModel: input.apiModel,
            parse: input.docEvidence.parse,
            sources: input.docEvidence.sources,
            fetchedAt: input.docEvidence.fetchedAt,
            now,
            // The cap the form's guard accepted, never the documented ceiling.
            requestOutputCapTokens: outputCap.value,
          }),
    sources,
    unknowns,
    notes,
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
  /**
   * Whether the catalogue says the pair being saved is not servable.
   *
   * The pair in `body`, not the work item. A registry row carries one
   * `(provider, apiModel)` and the runtime sends requests to exactly that
   * pair -- it does not fall through to another provider that lists the same
   * model. So an item Groq has switched off and Anthropic still serves is
   * adoptable *as the Anthropic pair* and must be refused *as the Groq pair*,
   * and a question asked about the item as a whole gets both halves wrong.
   *
   * The panel already prints the lifecycle and the triage already reads
   * `조치 비권장`, but neither stops a save: the row said do not adopt this
   * and the button adopted it anyway. Refused on the server because that is
   * the side that decides.
   *
   * `false` when the catalogue has no row for the pair. Absence is the
   * missing-detection machinery's question, and reading it as "unservable"
   * would refuse adoptions on the strength of a row nobody wrote.
   */
  submittedPairUnservable?: boolean;
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
  /** A profile registered under the saved id for a different provider or api model. */
  profileForOtherPair?: { provider: string; apiModelId: string } | null;
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
  if (input.profileForOtherPair) {
    return {
      status: 409,
      message: `The pricing profile for ${input.body.id} describes ${input.profileForOtherPair.provider}/${input.profileForOtherPair.apiModelId}, not ${input.body.provider}/${input.body.apiModel}. Prices resolve by id, so this model would bill at that one's price. Save it under a different id.`,
    };
  }
  if (modelProductSurface(workItem.apiModel) !== "chat") {
    return {
      status: 409,
      message:
        "Only chat models are adopted into this registry. Image generation models belong to the Image Studio ledger.",
    };
  }
  if (input.submittedPairUnservable) {
    return {
      status: 409,
      message: `${input.body.provider} lists ${input.body.apiModel} as not servable. Adopting it would put a row in the registry that answers no request. If another provider still serves this model, adopt that pair instead.`,
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
