import "server-only";

import type { ModelRegistryEntry, Prisma } from "@prisma/client";

import { resolveModelPricing } from "@/lib/modelPricing";
import { registryRowToModel } from "@/lib/modelRegistry";
import { amuxCliModelLinkFor, amuxCliModelLinkMap,
  type AmuxCliModelLink } from "./cliModelCatalogCore.ts";
import { AMUX_V22_PROVIDERS, amuxV22Provider } from "./v22WorkerClaimCore.ts";
import { calculateV4TaskCeilingFromCatalog } from "./v4TaskCostCatalogCore.ts";
import { deriveAmuxV4TaskAutoCatalog,
  type AmuxTaskCatalogResolvedPrice } from "./v4TaskCostAutoCatalogCore.ts";
import { readAmuxRegistryAndDerivedCatalog } from "./workerAssignmentCatalog.ts";

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
 * them. A model id is matched exactly first; a model named only as another
 * row's API model takes the dearest such row, so a duplicate never lowers it.
 */
export async function readAmuxV4TaskAutoCatalog(tx: Prisma.TransactionClient) {
  const { registrations, derived } = await readAmuxRegistryAndDerivedCatalog(tx);
  if (!registrations || !derived) {
    throw new AmuxV4TaskCatalogApprovalError("worker_registry_unavailable");
  }
  const ceilings = new Map(registrations.map((registration) =>
    [registration.workerName, registration.roleCeiling]));
  // Any provider's row: a Codex, Copilot or Cursor route prices from the
  // Admin › Models entry its model ID names, as a Claude route does -- unless
  // the owner linked that CLI's name to an entry (owner decision 2026-10-27).
  // Both are read in one statement, so no AMUX boundary that prices a Task
  // sends one more.
  const [read] = await tx.$queryRaw<Array<{ rows: unknown; links: unknown }>>`
    SELECT
      COALESCE((SELECT pg_catalog.json_agg(entry) FROM "ModelRegistryEntry" entry
        WHERE NOT entry."catalogDeleted"), '[]'::json) AS "rows",
      COALESCE((SELECT pg_catalog.json_agg(link) FROM (
        SELECT DISTINCT ON ("cli", "cliModel") "cli", "cliModel", "pricedModelId"
        FROM "AmuxCliModelLinkEvent"
        ORDER BY "cli", "cliModel", "sequence" DESC) link), '[]'::json) AS "links"
  `;
  if (!read || !Array.isArray(read.rows) || !Array.isArray(read.links)) {
    throw new AmuxV4TaskCatalogApprovalError("unavailable");
  }
  // The JSON carries every column the registry reader uses; no date is read.
  const rows = read.rows as ModelRegistryEntry[];
  const links = amuxCliModelLinkMap(read.links as AmuxCliModelLink[]);
  const unreadable = new Set<string>();
  const models = rows.flatMap((row) => {
    try { return [registryRowToModel(row)]; } catch { unreadable.add(row.id); return []; }
  });
  const priceFor = (modelId: string, inputTokens: number, provider: string):
    AmuxTaskCatalogResolvedPrice | null => {
    const known = amuxV22Provider(provider);
    const link = known === null ? { linked: false as const } :
      amuxCliModelLinkFor(links, AMUX_V22_PROVIDERS[known].cli, modelId);
    // A link to nothing holds the name; a link prices from its entry alone.
    if (link.linked && link.pricedModelId === null) return null;
    const exactRows = rows.filter((row) => row.id === (link.linked ? link.pricedModelId : modelId));
    const pool = exactRows.length > 0 || link.linked ? exactRows :
      rows.filter((row) => row.apiModel === modelId);
    // A row that cannot be read might be the dearest: price nothing rather
    // than fall through to a cheaper one.
    if (pool.length === 0 || pool.some((row) => unreadable.has(row.id))) return null;
    const ids = new Set(pool.map((row) => row.id));
    const candidates = models.filter((model) => ids.has(model.id));
    const resolved = candidates.map((model) =>
      resolveModelPricing(model, { estimatedPromptTokens: inputTokens }));
    const writes = resolved.flatMap((row) =>
      row.cacheWriteUsdPerMillionTokens === null ? [] : [row.cacheWriteUsdPerMillionTokens]);
    return {
      cacheWriteUsdPerMillionTokens: writes.length === candidates.length ?
        Math.max(...writes) : null,
      inputUsdPerMillionTokens: Math.max(...resolved.map((row) => row.inputUsdPerMillionTokens)),
      outputUsdPerMillionTokens: Math.max(...resolved.map((row) => row.outputUsdPerMillionTokens)),
      cachedInputPriceMultiplier: Math.max(...resolved.map((row) => row.cachedInputPriceMultiplier)),
      ...(link.linked && link.pricedModelId !== null ? { linkedModelId: link.pricedModelId } : {}),
    };
  };
  return deriveAmuxV4TaskAutoCatalog({ priceFor,
    workers: derived.v22.map((entry) => ({ workerName: entry.worker_name,
      provider: entry.provider, modelId: entry.model, roles: entry.routing_roles,
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
  // the live calculation always runs too. A price that changed since gives a
  // different catalog digest, which the caller treats as a changed cost.
  const live = calculateV4TaskCeilingFromCatalog({
    rawCatalog: current.catalog, role, grade, asOfIso: now.toISOString(),
  });
  const result = options.asOf && live.ok ? calculateV4TaskCeilingFromCatalog({
    rawCatalog: current.catalog, role, grade, asOfIso: options.asOf.toISOString(),
  }) : live;
  if (!live.ok || !result.ok) {
    throw new AmuxV4TaskCatalogApprovalError("evidence_unverified");
  }
  return { approvalId: current.catalogId, catalogDigest: current.catalogDigest,
    catalog: current.catalog, receipt: result.receipt };
}
