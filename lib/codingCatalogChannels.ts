// The coding API's view of the coding catalogue (owner decisions 2026-11-20
// and 2026-11-21). Behind CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED, default
// off: off, nothing here reads the database and the coding API offers and runs
// what the general API does, the chat registry. On, the coding API -- its
// model lists, Smart Adaptive, the coding-app settings and the tomverse CLI --
// offers the rows the newest coding snapshot lists for the coding API that the
// coding judge still admits now. A chat link runs and bills as its chat
// registry model. A dedicated row runs as its own published row at that row's
// prices, charged credits by the chat rule (its apiCreditWeight, or the chat
// floor at the chat input limit), through the same reservation,
// settlement, provider budget and concurrency as every external request.
// The general API (/api/v1, /api/anthropic) never reads this.
import "server-only";

import { codingApiCredit, codingRowRuntime, type CodingApiCreditBasis, type CodingRowRuntime } from "@/lib/codingRowRuntime";
import {
  chatModelFacts,
  loadCodingCatalog,
  loadCodingProviderTerms,
  parseSnapshotRows,
  servableCodingRows,
} from "@/lib/modelCatalog";
import {
  canonicalJson,
  codingApiSnapshotRows,
  codingCatalogExternalChannelsEnabled,
  codingPlanReaches,
  onCodingApi,
  snapshotIsCurrent,
  type CodingCatalogRow,
} from "@/lib/modelCatalogCore";
import type { AiModel, ModelTier } from "@/lib/models";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { prisma } from "@/lib/prisma";

/**
 * What the reservation of a dedicated row's request records beside the row's
 * own prices: the snapshot it was priced from, the cache-write rate that
 * bounds a client's prompt-cache marker, and how its credits were set
 * (lib/codingRowRuntime.ts codingApiCredit).
 */
export type CodingCatalogPricing = {
  cacheWriteUsdPerMillionTokens: number | null;
  /** `coding_catalog_snapshot:<version>:<contentHash>`. */
  pricingVersion: string;
  costSource: "coding_catalog_snapshot";
  creditBasis: { basis: CodingApiCreditBasis; credits: number; floorCredits: number };
};

export type CodingApiModel = { model: AiModel; pricing?: CodingCatalogPricing };

let warnedNoSnapshot = 0;
let warnedRefusal = 0;

/** A dedicated row as the model the coding API runs, priced at the row's own rates. */
export const codingApiDedicatedModel = (
  row: CodingCatalogRow,
  built: Extract<CodingRowRuntime, { ok: true }>,
  snapshot: { version: number; contentHash: string },
  credit: { credits: number; basis: CodingApiCreditBasis; floorCredits: number }
): CodingApiModel => ({
  model: {
    ...built.runtime,
    // The coding API's credits (the chat rule), not Code's `pricing.creditWeight`.
    creditWeight: credit.credits,
    maxOutputTokens: built.price.maxOutputTokens,
    inputUsdPerMillionTokens: built.price.inputUsdPerMillionTokens,
    outputUsdPerMillionTokens: built.price.outputUsdPerMillionTokens,
    cachedInputPriceMultiplier: built.price.cachedInputPriceMultiplier,
    inputCapabilities: { image: row.capabilities.imageInput, nativePdf: false },
  },
  pricing: {
    cacheWriteUsdPerMillionTokens: built.price.cacheWriteUsdPerMillionTokens ?? null,
    pricingVersion: `coding_catalog_snapshot:${snapshot.version}:${snapshot.contentHash}`,
    costSource: "coding_catalog_snapshot",
    creditBasis: { basis: credit.basis, credits: credit.credits, floorCredits: credit.floorCredits },
  },
});

/**
 * The models the coding API offers this plan, or null when the switch is off
 * (the coding API then serves the chat registry, as the general API does).
 *
 * A row must be in the newest snapshot for the coding API at a plan this
 * account reaches (publishing is the step that exposes it) and must still be
 * admitted now -- on, not held, the coding API still ticked, its current
 * minimum plan reached, its provider's conditions still allowing it -- so a
 * hold, a raised plan or a re-check that refuses a model takes effect at once.
 * A dedicated row is charged at its published price, so it also needs the row
 * the judge admits now to be exactly the published one, as Code's managed path
 * does (lib/codeManagedService.ts modelPair). No snapshot, or one past its
 * coverage, offers nothing: an unpublished catalogue does not fall back to the
 * whole registry.
 */
export const codingApiModels = async (
  plan: ModelTier,
  options: { runtime?: readonly AiModel[]; env?: Readonly<Record<string, string | undefined>>; now?: Date } = {}
): Promise<CodingApiModel[] | null> => {
  if (!codingCatalogExternalChannelsEnabled(options.env ?? process.env)) return null;
  const now = options.now ?? new Date();
  const snapshot = await prisma.modelCatalogSnapshot.findFirst({ where: { category: "coding" }, orderBy: { version: "desc" } });
  if (!snapshot || !snapshotIsCurrent(snapshot.coverageUntil, now)) {
    // Once a minute per instance at most: this is on every coding API request.
    if (now.getTime() - warnedNoSnapshot > 60_000) {
      warnedNoSnapshot = now.getTime();
      console.warn(
        JSON.stringify({
          event: "coding_catalog_external_channels_no_snapshot",
          state: snapshot ? "stale" : "missing",
          version: snapshot?.version ?? null,
        })
      );
    }
    return [];
  }
  const runtime = options.runtime ?? (await getRuntimeModels());
  const entries = await loadCodingCatalog(prisma, {
    context: { chat: runtime.map(chatModelFacts), providerTerms: await loadCodingProviderTerms(prisma) },
  });
  // The current row's channels and plan narrow the published row's: a plan
  // raised or the coding API unticked since publishing applies now.
  const current = new Map(
    servableCodingRows(entries)
      .filter((row) => onCodingApi(row.channels) && codingPlanReaches(plan, row.minimumPlan))
      .map((row) => [row.modelId, row] as const)
  );
  const published = codingApiSnapshotRows(parseSnapshotRows((snapshot.payload as { models?: unknown[] } | null)?.models ?? []), {
    plan,
    activeIds: new Set(current.keys()),
  });
  const chatById = new Map(runtime.map((model) => [model.id, model] as const));
  const models: CodingApiModel[] = [];
  const refused: { modelId: string; code: string }[] = [];
  for (const row of published) {
    if (row.source === "chat") {
      const model = chatById.get(row.registryModelId ?? row.modelId);
      if (model) models.push({ model });
      continue;
    }
    if (canonicalJson(current.get(row.modelId)) !== canonicalJson(row)) {
      refused.push({ modelId: row.modelId, code: "CODE_CATALOG_CHANGED" });
      continue;
    }
    const built = codingRowRuntime(row, snapshot);
    if (!built.ok) {
      refused.push({ modelId: row.modelId, code: built.code });
      continue;
    }
    // Charged by the chat rule, at the output ceiling the registry bounds.
    const credit = codingApiCredit(row, built.price.maxOutputTokens);
    if (!credit.ok) {
      refused.push({ modelId: row.modelId, code: credit.reason });
      continue;
    }
    models.push(codingApiDedicatedModel(row, built, snapshot, credit));
  }
  if (refused.length > 0 && now.getTime() - warnedRefusal > 60_000) {
    warnedRefusal = now.getTime();
    console.warn(JSON.stringify({ event: "coding_api_dedicated_rows_refused", version: snapshot.version, refused }));
  }
  return models;
};
