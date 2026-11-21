// A dedicated coding row as a runnable model, with the price it is charged at.
// One conversion for both places a dedicated row runs: Code's managed path
// (lib/codeManagedService.ts) and the coding API (lib/codingCatalogChannels.ts).
// The row is the published snapshot row; nothing here reads the database.
import { CODE_MANAGED_UNBOUNDED_PROVIDERS, type CodingCatalogRow } from "@/lib/modelCatalogCore";
import { MODEL_PRICING, resolveModelPricing, type ResolvedModelPricing } from "@/lib/modelPricing";
import { isAiProvider } from "@/lib/modelRegistryShared";
import type { AiModel } from "@/lib/models";

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
export const registryPricesFor = (row: Pick<CodingCatalogRow, "provider" | "apiModelId" | "capabilities">, runtime: AiModel): RegistryPrice[] =>
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
  row: CodingCatalogRow,
  snapshot: { version: number; contentHash: string },
  deps: { registryPrices?: (row: CodingCatalogRow, runtime: AiModel) => readonly RegistryPrice[] } = {}
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
        row.provider === "anthropic" ? Math.max(knownWrite ?? 0, row.pricing.inputUsdPerMTok * 1.25) : knownWrite,
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
