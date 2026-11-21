// A dedicated coding row as a runnable model, with the price it is charged at.
// One conversion for both places a dedicated row runs: Code's managed path
// (lib/codeManagedService.ts) and the coding API (lib/codingCatalogChannels.ts).
// The row is the published snapshot row; nothing here reads the database.
import { chatUserMaxInputTokens } from "@/lib/chatInputLimits";
import { isCreditFloor, suggestCreditFloor } from "@/lib/modelAdoptionDraft";
import { CODE_MANAGED_UNBOUNDED_PROVIDERS, CODING_API_CREDIT_WEIGHT_MAX, type CodingCatalogRow } from "@/lib/modelCatalogCore";
import { MODEL_PRICING, PROMPT_CACHE_WRITE_5M_PRICE_MULTIPLIER, resolveModelPricing, type ResolvedModelPricing } from "@/lib/modelPricing";
import { isAiProvider } from "@/lib/modelRegistryShared";
import { INPUT_CREDIT_MULTIPLIERS, type AiModel } from "@/lib/models";

export type CodingRowPrice = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  /** An unverified cache discount is full input price. */
  cachedInputPriceMultiplier: number;
  /** Null where the price registry knows the model but has no write rate; undefined where it does not know it. */
  cacheWriteUsdPerMillionTokens: number | null | undefined;
  /** The row's output ceiling, within the provider's settable one where the registry knows it. */
  maxOutputTokens: number;
  costSource: string;
  cacheWriteBoundSource: string | undefined;
};

export type CodingRowRefusal =
  | "CODE_PROVIDER_UNSUPPORTED"
  | "CODE_PROVIDER_COST_UNBOUNDED"
  | "CODE_REASONING_COST_UNBOUNDED"
  | "CODE_CATALOG_PRICING_CHANGED";

/** What the conversion reads of a row: a published snapshot row, or a resolved catalogue row. */
export type CodingRowInput = Pick<CodingCatalogRow, "modelId" | "name" | "apiModelId" | "provider" | "minimumPlan" | "pricing" | "capabilities">;

export type CodingRowRuntime =
  | { ok: true; runtime: AiModel; price: CodingRowPrice }
  | { ok: false; code: CodingRowRefusal };

/** What the price registry says one provider model costs, as the checks below read it. */
export type RegistryPrice = Pick<
  ResolvedModelPricing,
  | "inputUsdPerMillionTokens"
  | "outputUsdPerMillionTokens"
  | "reasoningTokenBilling"
  | "providerMaxOutputTokens"
  | "cacheWriteUsdPerMillionTokens"
  | "pricingVersion"
>;

/**
 * Every price the registry holds for the provider model a row calls, found by
 * provider and API model id -- not by the catalogue id the row chose, so a
 * known model registered under another id is checked all the same. At a
 * prompt filling the row's window, the worst a coding turn can be priced at.
 * More than one profile can name one provider model (a "thinking" variant);
 * all of them are returned and the checks take the strictest.
 */
export const registryPricesFor = (row: Pick<CodingRowInput, "provider" | "apiModelId" | "capabilities">, runtime: AiModel): RegistryPrice[] =>
  MODEL_PRICING.filter((profile) => profile.provider === row.provider && profile.apiModelId === row.apiModelId).map((profile) =>
    resolveModelPricing({ ...runtime, id: profile.modelId }, { estimatedPromptTokens: row.capabilities.maxContextTokens })
  );

/**
 * The runtime model a dedicated row runs as, or why it cannot run. Refused:
 * a provider this application has no adapter for; inference hosts and
 * aggregators (they need their own destination pin) and Perplexity (search
 * fees a token row does not carry); a provider model the price registry knows
 * bills reasoning separately; and a row priced below what the registry now says
 * the same provider model costs. The row's output limit is held within the
 * provider's settable ceiling the registry knows for it.
 */
export const codingRowRuntime = (
  row: CodingRowInput,
  snapshot: { version: number; contentHash: string },
  deps: { registryPrices?: (row: CodingRowInput, runtime: AiModel) => readonly RegistryPrice[] } = {}
): CodingRowRuntime => {
  if (!isAiProvider(row.provider)) return { ok: false, code: "CODE_PROVIDER_UNSUPPORTED" };
  if (CODE_MANAGED_UNBOUNDED_PROVIDERS.includes(row.provider)) return { ok: false, code: "CODE_PROVIDER_COST_UNBOUNDED" };
  // The coding catalogue is independent of Chat's static model registry.
  // Endpoints and credential aliases still come solely from getActiveAiModel.
  const runtime: AiModel = {
    id: row.modelId,
    name: row.name,
    apiModel: row.apiModelId,
    provider: row.provider,
    icon: "",
    bestFor: "Coding",
    minimumPlan: row.minimumPlan === "Max" ? "Pro" : row.minimumPlan,
    usageClass: "standard",
    enabled: true,
    status: "enabled",
    creditWeight: row.pricing.creditWeight,
    contextWindowTokens: row.capabilities.maxContextTokens,
    maxOutputTokens: row.capabilities.maxOutputTokens,
  };
  const known = (deps.registryPrices ?? registryPricesFor)(row, runtime);
  if (known.some((price) => price.reasoningTokenBilling === "billed_separately")) return { ok: false, code: "CODE_REASONING_COST_UNBOUNDED" };
  if (known.some((price) => price.inputUsdPerMillionTokens > row.pricing.inputUsdPerMTok || price.outputUsdPerMillionTokens > row.pricing.outputUsdPerMTok)) {
    return { ok: false, code: "CODE_CATALOG_PRICING_CHANGED" };
  }
  // The highest verified write rate; null where the registry knows the model
  // but no write rate, undefined where it does not know the model.
  const writeRates = known.flatMap((price) => (typeof price.cacheWriteUsdPerMillionTokens === "number" ? [price.cacheWriteUsdPerMillionTokens] : []));
  const knownWrite: number | null | undefined = writeRates.length > 0 ? Math.max(...writeRates) : known.length > 0 ? null : undefined;
  const writeBound = known.find((price) => price.cacheWriteUsdPerMillionTokens === knownWrite) ?? known[0];
  return {
    ok: true,
    runtime,
    price: {
      inputUsdPerMillionTokens: row.pricing.inputUsdPerMTok,
      outputUsdPerMillionTokens: row.pricing.outputUsdPerMTok,
      cachedInputPriceMultiplier: 1,
      // No verified write rate is taken as Anthropic's 5-minute write premium
      // over the row's own input price, the same multiplier the credit floor uses.
      cacheWriteUsdPerMillionTokens:
        row.provider === "anthropic" ? Math.max(knownWrite ?? 0, row.pricing.inputUsdPerMTok * PROMPT_CACHE_WRITE_5M_PRICE_MULTIPLIER) : knownWrite,
      maxOutputTokens: Math.min(row.capabilities.maxOutputTokens, ...known.map((price) => price.providerMaxOutputTokens ?? Infinity)),
      costSource: `coding_catalog_snapshot:${snapshot.version}:${snapshot.contentHash}`,
      cacheWriteBoundSource:
        knownWrite !== undefined
          ? writeBound?.pricingVersion
          : row.provider === "anthropic"
            ? "coding_credit_floor_anthropic_1.25"
            : "no_cache_write_requested",
    },
  };
};

// --- credits on the coding API (owner decision 2026-11-21) --------------------
//
// The coding API takes every model's input up to chatUserMaxInputTokens() and
// settles through the chat reservation, input-size multiplier included, so a
// dedicated row there is charged by the chat rule: the chat catalogue's own
// floor (suggestCreditFloor, as the chat registry screen and adoption use it)
// over every input band up to that limit, at the row's output ceiling. Code's managed path keeps
// `pricing.creditWeight`, whose floor (codingCreditFloor) assumes the whole
// context window as input and would overcharge here.

export type CodingApiCreditBasis = "chat_rule_floor" | "api_override";

export type CodingApiCredit =
  | { ok: true; credits: number; basis: CodingApiCreditBasis; floorCredits: number }
  | { ok: false; reason: "api_credit_floor_unbounded" | `api_credits_below_floor:${number}`; floorCredits: number | null };

/**
 * The chat rule's minimum credits for a dedicated row on the coding API, or
 * null when it cannot be worked out (no price, no output cap, above every
 * class, or above CODING_API_CREDIT_WEIGHT_MAX). `maxOutputTokens` is the
 * row's output ceiling as codingRowRuntime bounds it against the registry.
 *
 * A request is charged its credits times the multiplier of its own input band
 * (INPUT_CREDIT_MULTIPLIERS: x1 to 16k, x1.5 to 50k, x2 to 100k, x3 above), so
 * the floor must cover the worst turn of every band, not only the largest
 * input: for a model whose output is dear, a short prompt with a full answer
 * at x1 costs more per credit than the longest prompt at x3. Each band's worst
 * turn is its largest input (up to the input limit) with the full output; the
 * floor is the largest of the bands' floors. suggestCreditFloor itself is the
 * chat catalogue's and is not changed here.
 */
export const codingApiCreditFloor = (
  row: Pick<CodingCatalogRow, "provider" | "pricing">,
  maxOutputTokens: number,
  worstCaseInputTokens: number = chatUserMaxInputTokens()
): number | null => {
  const bandInputs = [
    ...new Set([...INPUT_CREDIT_MULTIPLIERS.map((band) => band.aboveTokens), worstCaseInputTokens].map((edge) => Math.min(edge, worstCaseInputTokens))),
  ];
  let credits = 0;
  for (const inputTokens of bandInputs) {
    const floor = suggestCreditFloor({
      inputUsdPerMillionTokens: row.pricing.inputUsdPerMTok,
      outputUsdPerMillionTokens: row.pricing.outputUsdPerMTok,
      maxOutputTokens,
      inputPriceMultiplier: row.provider === "anthropic" ? PROMPT_CACHE_WRITE_5M_PRICE_MULTIPLIER : 1,
      worstCaseInputTokens: inputTokens,
    });
    if (!isCreditFloor(floor)) return null;
    credits = Math.max(credits, floor.credits);
  }
  return credits > CODING_API_CREDIT_WEIGHT_MAX ? null : credits;
};

/**
 * What a dedicated row is charged per request on the coding API: its
 * `apiCreditWeight` when the operator set one at or above the chat rule's
 * minimum, otherwise that minimum. Refused -- the row is not offered on the
 * coding API, Code is unaffected -- when the minimum cannot be worked out or
 * the override is below it.
 */
export const codingApiCredit = (
  row: Pick<CodingCatalogRow, "provider" | "pricing" | "apiCreditWeight">,
  maxOutputTokens: number,
  worstCaseInputTokens?: number
): CodingApiCredit => {
  const floorCredits = codingApiCreditFloor(row, maxOutputTokens, worstCaseInputTokens);
  if (floorCredits === null) return { ok: false, reason: "api_credit_floor_unbounded", floorCredits };
  if (row.apiCreditWeight === undefined) return { ok: true, credits: floorCredits, basis: "chat_rule_floor", floorCredits };
  if (row.apiCreditWeight < floorCredits) return { ok: false, reason: `api_credits_below_floor:${floorCredits}`, floorCredits };
  return { ok: true, credits: row.apiCreditWeight, basis: "api_override", floorCredits };
};

/** What the coding catalogue screen shows of a dedicated row's two credits. */
export type CodingApiCreditView = {
  /** Code's managed-path credits (`pricing.creditWeight`). */
  codeCredits: number;
  /** The operator's coding API credits, when set. */
  override: number | null;
  /** The chat rule's minimum on the coding API; null when it cannot be worked out. */
  floorCredits: number | null;
  /** What the coding API charges; null while it refuses the row. */
  credits: number | null;
  basis: CodingApiCreditBasis | null;
  /** Why the coding API does not offer the row, or null. */
  refusal: string | null;
};

export const codingApiCreditView = (row: CodingRowInput & Pick<CodingCatalogRow, "apiCreditWeight">): CodingApiCreditView => {
  const codeCredits = row.pricing.creditWeight;
  const override = row.apiCreditWeight ?? null;
  // The same conversion and output ceiling a request is charged at.
  const built = codingRowRuntime(row, { version: 0, contentHash: "" });
  if (!built.ok) return { codeCredits, override, floorCredits: null, credits: null, basis: null, refusal: built.code };
  const credit = codingApiCredit(row, built.price.maxOutputTokens);
  return credit.ok
    ? { codeCredits, override, floorCredits: credit.floorCredits, credits: credit.credits, basis: credit.basis, refusal: null }
    : { codeCredits, override, floorCredits: credit.floorCredits, credits: null, basis: null, refusal: credit.reason };
};
