import { createHash } from "node:crypto";

import { amuxCanonicalJson } from "./boardImportCore.ts";
import { AMUX_EXECUTION_GRADE_WORKER_ROLE,
  type AmuxExecutionGrade } from "./executionGradeCore.ts";
import { inspectV4TaskCostCatalog } from "./v4TaskCostCatalogCore.ts";

/**
 * The Task cost catalog, derived on every use from what Tomverse already
 * manages (owner decision 2026-10-25: no separate price approval):
 *
 * - routes: the v22 workers the assignment catalog can start (provider
 *   anthropic), each at the one grade its registered role ceiling gives and
 *   for the Task roles its v22 profile actually runs -- the ready check reads
 *   the same roles, so a Task no worker can run gets no ceiling;
 * - prices: the chat model registry (Admin › Models) resolved the way Chat
 *   bills it, at the tier the grade's input cap reaches, valid from the time
 *   the model's row last changed -- so usage that ended before a price change
 *   is never priced at the new rate. Cache reads use the resolved multiplier;
 *   cache writes use the verified write rate, or twice the input rate (the
 *   dearest Anthropic write) when none is verified. Tool costs are capped at
 *   zero;
 * - grade caps: AMUX_TASK_CATALOG_CAPS below, changed in code.
 *
 * Deterministic: the same registries give the same catalog digest, so a Task
 * reconfirms only when a worker or a model row actually changed. The ceiling it
 * gives is still reserved before every paid API call.
 */

export const AMUX_TASK_CATALOG_GRADES = ["routine", "advanced", "frontier"] as const;
/** Task roles a card may carry; review runs as independent review, not a Task. */
export const AMUX_TASK_CATALOG_ROLES = ["design", "implement", "test",
  "verify", "investigate", "operate"] as const;
/** A registry price stays valid until the row changes again. */
const PRICES_UNTIL = "2100-01-01T00:00:00.000Z";
const UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type AmuxTaskCatalogGradeCaps = {
  inputTokens: number;
  outputTokens: number;
  maxAttempts: number;
};

/** The most one Task of each grade may use, every attempt included. */
export const AMUX_TASK_CATALOG_CAPS: Readonly<Record<AmuxExecutionGrade,
  AmuxTaskCatalogGradeCaps>> = Object.freeze({
  routine: Object.freeze({ inputTokens: 300_000, outputTokens: 30_000, maxAttempts: 2 }),
  advanced: Object.freeze({ inputTokens: 600_000, outputTokens: 60_000, maxAttempts: 2 }),
  frontier: Object.freeze({ inputTokens: 1_000_000, outputTokens: 128_000, maxAttempts: 3 }),
});

export type AmuxTaskCatalogWorker = {
  workerName: string;
  modelId: string;
  /** The v22 profile's roles. */
  roles: readonly string[];
  roleCeiling: string | null;
};

export type AmuxTaskCatalogResolvedPrice = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  cachedInputPriceMultiplier: number;
  /** Null when no write rate was verified for the model. */
  cacheWriteUsdPerMillionTokens: number | null;
  /** When the model's registry row last changed, to the millisecond, UTC. */
  verifiedAt: string;
};

export type AmuxTaskAutoCatalog =
  | { ok: true; catalog: Record<string, unknown>; catalogDigest: string;
      /** The id receipts carry where an approval id used to be. */
      catalogId: string }
  | { ok: false; code: "no_priced_worker" };

const sha256 = (tag: string, value: unknown) => createHash("sha256")
  .update(`${tag}\n`, "utf8").update(amuxCanonicalJson(value), "utf8").digest("hex");

const microUsd = (usd: number | null | undefined) =>
  typeof usd === "number" && Number.isFinite(usd) && usd > 0
    ? Math.ceil(usd * 1_000_000) : null;

const gradeOf = (roleCeiling: string | null): AmuxExecutionGrade | null =>
  AMUX_TASK_CATALOG_GRADES.find((grade) =>
    AMUX_EXECUTION_GRADE_WORKER_ROLE[grade] === roleCeiling) ?? null;

export function deriveAmuxV4TaskAutoCatalog(input: {
  workers: readonly AmuxTaskCatalogWorker[];
  /** The registry price for a model at a prompt of this many input tokens. */
  priceFor: (modelId: string, inputTokens: number) => AmuxTaskCatalogResolvedPrice | null;
  caps?: Readonly<Record<AmuxExecutionGrade, AmuxTaskCatalogGradeCaps>>;
}): AmuxTaskAutoCatalog {
  const caps = input.caps ?? AMUX_TASK_CATALOG_CAPS;
  const routes: Record<string, unknown>[] = [];
  for (const worker of [...input.workers].sort((a, b) =>
    a.workerName.localeCompare(b.workerName))) {
    const grade = gradeOf(worker.roleCeiling);
    const roles = AMUX_TASK_CATALOG_ROLES.filter((role) => worker.roles.includes(role));
    if (!grade || roles.length === 0) continue;
    const price = input.priceFor(worker.modelId, caps[grade].inputTokens);
    const uncached = microUsd(price?.inputUsdPerMillionTokens);
    const output = microUsd(price?.outputUsdPerMillionTokens);
    // A zero or missing price never becomes a free route.
    if (!price || uncached === null || output === null ||
        !UTC_MS.test(price.verifiedAt) || price.verifiedAt >= PRICES_UNTIL) continue;
    const multiplier = price.cachedInputPriceMultiplier;
    const identity = { workerName: worker.workerName, provider: "anthropic",
      modelId: worker.modelId, roles, grade };
    routes.push({
      routeId: `v22:${worker.workerName}`,
      workerName: worker.workerName,
      provider: "anthropic",
      modelId: worker.modelId,
      // Only the route's identity, so a price change never asks an approved
      // Task to reconfirm its route.
      routePolicyDigest: sha256("amux-v4-task-route-policy-v1", identity),
      enabled: true,
      roles,
      grades: [grade],
      pricingSource: `model-registry:${worker.modelId}`,
      pricingVerifiedAt: price.verifiedAt,
      pricingExpiresAt: PRICES_UNTIL,
      uncachedInputMicroUsdPerMillion: uncached,
      outputMicroUsdPerMillion: output,
      cacheReadMicroUsdPerMillion: Number.isFinite(multiplier) && multiplier > 0
        ? Math.ceil(uncached * multiplier) : uncached,
      cacheWriteMicroUsdPerMillion: microUsd(price.cacheWriteUsdPerMillionTokens) ??
        uncached * 2,
      toolCostCapMicroUsdPerAttempt: 0,
    });
  }
  if (routes.length === 0) return { ok: false, code: "no_priced_worker" };
  const gradeRules = AMUX_TASK_CATALOG_ROLES.flatMap((role) =>
    AMUX_TASK_CATALOG_GRADES.map((grade) => ({ role, grade, caps: {
      uncachedInputTokens: caps[grade].inputTokens,
      outputTokens: caps[grade].outputTokens,
      cacheReadTokens: 0, cacheWriteTokens: 0,
      maxAttempts: caps[grade].maxAttempts } })));
  const pricingVersion = `model-registry-${sha256("amux-v4-task-auto-prices-v1",
    routes).slice(0, 16)}`;
  const gradeRulesVersion = `grade-caps-${sha256("amux-v4-task-grade-caps-v1",
    caps).slice(0, 16)}`;
  const catalog = {
    schemaVersion: 1,
    catalogVersion: `registry-${sha256("amux-v4-task-auto-catalog-v1",
      { pricingVersion, gradeRulesVersion }).slice(0, 16)}`,
    pricingVersion,
    gradeRulesVersion,
    gradeRules,
    routes,
  };
  const inspection = inspectV4TaskCostCatalog(catalog);
  if (!inspection.ok) return { ok: false, code: "no_priced_worker" };
  return { ok: true, catalog, catalogDigest: inspection.catalogDigest,
    catalogId: `registry:${inspection.catalogDigest.slice(0, 32)}` };
}
