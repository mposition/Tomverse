import "server-only";

import type { Prisma } from "@prisma/client";

import { resolveModelPricing } from "@/lib/modelPricing";
import { registryRowToModel } from "@/lib/modelRegistry";
import { calculateV4TaskCeilingFromCatalog } from "./v4TaskCostCatalogCore.ts";
import { deriveAmuxV4TaskAutoCatalog,
  type AmuxTaskCatalogResolvedPrice } from "./v4TaskCostAutoCatalogCore.ts";
import { readAmuxRegistryAndDerivedCatalog } from "./workerAssignmentCatalog.ts";

/** lib/modelPricing.ts reads these per model; any one may override a price. */
const PRICE_ENV_SUFFIXES = ["INPUT_USD_PER_MILLION", "OUTPUT_USD_PER_MILLION",
  "CACHED_INPUT_PRICE_MULTIPLIER"] as const;
const priceEnvKey = (modelId: string, suffix: string) =>
  `CHAT_MODEL_${modelId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_${suffix}`;

/** A Task's cost cannot be bounded right now; callers hold, never price at zero. */
export class AmuxV4TaskCatalogApprovalError extends Error {
  constructor(readonly code: "evidence_unverified" | "unavailable" |
    "worker_registry_unavailable") {
    super(code);
    this.name = "AmuxV4TaskCatalogApprovalError";
  }
}

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  if (!(rows[0]?.now instanceof Date) || !Number.isFinite(rows[0].now.getTime())) {
    throw new AmuxV4TaskCatalogApprovalError("unavailable");
  }
  return rows[0].now;
}

/**
 * The Task cost catalog as the registries give it in this transaction (owner
 * decision 2026-10-25: no separate price approval): v22 workers from the
 * worker registry, prices from Admin › Models resolved the way Chat bills
 * them, at `options.at` when given (the price schedule in force then). A
 * model id is matched exactly first; a model named only as another
 * row's API model takes the dearest such row, so a duplicate never lowers it.
 */
export async function readAmuxV4TaskAutoCatalog(tx: Prisma.TransactionClient,
  options: { at?: Date } = {}) {
  const { registrations, derived } = await readAmuxRegistryAndDerivedCatalog(tx);
  if (!registrations || !derived) {
    throw new AmuxV4TaskCatalogApprovalError("worker_registry_unavailable");
  }
  const ceilings = new Map(registrations.map((registration) =>
    [registration.workerName, registration.roleCeiling]));
  const rows = await tx.modelRegistryEntry.findMany({
    where: { provider: "anthropic", catalogDeleted: false } });
  const updatedAt = new Map(rows.map((row) => [row.id, row.updatedAt.getTime()]));
  const models = rows.flatMap((row) => {
    try { return [registryRowToModel(row)]; } catch { return []; }
  });
  const priceFor = (modelId: string, inputTokens: number):
    AmuxTaskCatalogResolvedPrice | null => {
    const exact = models.filter((model) => model.id === modelId);
    const candidates = exact.length > 0 ? exact :
      models.filter((model) => model.apiModel === modelId);
    if (candidates.length === 0) return null;
    const resolved = candidates.map((model) =>
      resolveModelPricing(model, { estimatedPromptTokens: inputTokens, at: options.at }));
    // An environment override replaces a price field without moving the
    // row's change time, so a past price that may use one cannot be proven:
    // unpriced. Checked per field, since a partial row override reports
    // itself as a registry override while its other fields still read the
    // environment.
    if (options.at && candidates.some((model) => PRICE_ENV_SUFFIXES.some((suffix) =>
      process.env[priceEnvKey(model.id, suffix)] !== undefined))) {
      return null;
    }
    const writes = resolved.flatMap((row) =>
      row.cacheWriteUsdPerMillionTokens === null ? [] : [row.cacheWriteUsdPerMillionTokens]);
    // The rows' last change, exactly: rounding it down would price usage that
    // ended just before a change at the new rate.
    const changedAt = Math.max(...candidates.map((model) =>
      updatedAt.get(model.id) ?? 0));
    return {
      cacheWriteUsdPerMillionTokens: writes.length === candidates.length ?
        Math.max(...writes) : null,
      verifiedAt: new Date(changedAt).toISOString(),
      inputUsdPerMillionTokens: Math.max(...resolved.map((row) => row.inputUsdPerMillionTokens)),
      outputUsdPerMillionTokens: Math.max(...resolved.map((row) => row.outputUsdPerMillionTokens)),
      cachedInputPriceMultiplier: Math.max(...resolved.map((row) => row.cachedInputPriceMultiplier)),
    };
  };
  return deriveAmuxV4TaskAutoCatalog({ priceFor,
    workers: derived.v22.map((entry) => ({ workerName: entry.worker_name,
      modelId: entry.model, roles: entry.routing_roles,
      roleCeiling: ceilings.get(entry.worker_name) ?? null })) });
}

/** Called from the same registration transaction as the prepared receipt.
 * No priced worker for the role and grade is a hold, never zero cost. */
export async function calculateCurrentApprovedAmuxV4TaskCost(
  tx: Prisma.TransactionClient, role: string, grade: string,
  options: { asOf?: Date } = {}) {
  const current = await readAmuxV4TaskAutoCatalog(tx);
  if (!current.ok) throw new AmuxV4TaskCatalogApprovalError("evidence_unverified");
  const now = await databaseNow(tx);
  // The receipt digest includes its calculation time. A caller that must match
  // a receipt stored earlier (the v39 read-only retry chain) pins that time;
  // the live calculation always runs too. A price that changed after the
  // pinned time cannot reproduce that receipt, so the live receipt is
  // returned and the caller sees a changed cost, never an error.
  const live = calculateV4TaskCeilingFromCatalog({
    rawCatalog: current.catalog, role, grade, asOfIso: now.toISOString(),
  });
  const pinned = options.asOf && live.ok ? calculateV4TaskCeilingFromCatalog({
    rawCatalog: current.catalog, role, grade, asOfIso: options.asOf.toISOString(),
  }) : live;
  const result = !pinned.ok && pinned.code === "pricing_unverified" ? live : pinned;
  if (!live.ok || !result.ok) {
    throw new AmuxV4TaskCatalogApprovalError("evidence_unverified");
  }
  return { approvalId: current.catalogId, catalogDigest: current.catalogDigest,
    catalog: current.catalog, receipt: result.receipt };
}
