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
 *   bills it, at the tier the grade's input cap reaches. Cache reads use the
 *   resolved multiplier; cache writes use the verified five-minute write rate,
 *   the lifetime the app and the one-shot CLI cache with (no one-hour TTL is
 *   set), or Anthropic's published five-minute rule (1.25x input) for a model
 *   with none -- the catalog is a recorded estimate, not a stop. Tool costs are capped at
 *   zero;
 * - grade caps: AMUX_TASK_CATALOG_CAPS below, changed in code. They bound
 *   cache reads and writes as well, because the Claude CLI reports them
 *   apart from input, so the reservation covers what an attempt settles.
 *   The reservation is recorded and reported; an ordinary run is not stopped
 *   by it (owner decision 2026-10-25).
 *
 * Deterministic: the same prices give the same catalog digest. An ordinary
 * Task reconfirms only when its route leaves the confirmed receipt; a price
 * or bound change alone does not stop it. The catalog
 * prices a Task before it runs; the price an assignment reserved against is
 * recorded with it (amuxTaskRoutePrice) and its usage is settled at that
 * price, never at a later one.
 */

export const AMUX_TASK_CATALOG_GRADES = ["routine", "advanced", "frontier"] as const;
/** Task roles a card may carry; review runs as independent review, not a Task. */
export const AMUX_TASK_CATALOG_ROLES = ["design", "implement", "test",
  "verify", "investigate", "operate"] as const;
/** The live registry price applies whenever the catalog is derived. */
const PRICES_FROM = "2026-01-01T00:00:00.000Z";
const PRICES_UNTIL = "2100-01-01T00:00:00.000Z";

export type AmuxTaskCatalogGradeCaps = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  maxAttempts: number;
};

/** The most one Task attempt of each grade may use. A CLI session rereads its
 * context every turn, so cache reads run to ten times the fresh input; each
 * prompt is written to the cache at most once. */
export const AMUX_TASK_CATALOG_CAPS: Readonly<Record<AmuxExecutionGrade,
  AmuxTaskCatalogGradeCaps>> = Object.freeze({
  routine: Object.freeze({ inputTokens: 300_000, cacheReadTokens: 3_000_000,
    cacheWriteTokens: 300_000, outputTokens: 30_000, maxAttempts: 2 }),
  advanced: Object.freeze({ inputTokens: 300_000, cacheReadTokens: 3_000_000,
    cacheWriteTokens: 300_000, outputTokens: 40_000, maxAttempts: 2 }),
  frontier: Object.freeze({ inputTokens: 200_000, cacheReadTokens: 2_000_000,
    cacheWriteTokens: 200_000, outputTokens: 32_000, maxAttempts: 3 }),
});

export type AmuxTaskCatalogWorker = {
  workerName: string;
  /** The v22 provider (a v19 CLI channel name). */
  provider: string;
  modelId: string;
  /** The v22 profile's roles. */
  roles: readonly string[];
  roleCeiling: string | null;
};

export type AmuxTaskCatalogResolvedPrice = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  cachedInputPriceMultiplier: number;
  /** The verified five-minute write rate; null when none was verified. */
  cacheWriteUsdPerMillionTokens: number | null;
  /**
   * The Admin › Models entry an owner's CLI model link priced the route from
   * (owner decision 2026-10-27); absent when the route's own model name did.
   */
  linkedModelId?: string;
};

export type AmuxTaskAutoCatalog =
  | { ok: true; catalog: Record<string, unknown>; catalogDigest: string;
      /** The id receipts carry where an approval id used to be. */
      catalogId: string }
  | { ok: false; code: "no_priced_worker" };

/** One route's per-token prices, as an assignment records them. */
export type AmuxTaskRoutePrice = {
  pricingVersion: string;
  modelId: string;
  uncachedInputMicroUsdPerMillion: number;
  cacheReadMicroUsdPerMillion: number;
  cacheWriteMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
};

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
  /** The registry price for a provider's model at a prompt of this many input tokens. */
  priceFor: (modelId: string, inputTokens: number, provider: string) => AmuxTaskCatalogResolvedPrice | null;
  caps?: Readonly<Record<AmuxExecutionGrade, AmuxTaskCatalogGradeCaps>>;
}): AmuxTaskAutoCatalog {
  const caps = input.caps ?? AMUX_TASK_CATALOG_CAPS;
  const routes: Record<string, unknown>[] = [];
  for (const worker of [...input.workers].sort((a, b) =>
    a.workerName.localeCompare(b.workerName))) {
    const grade = gradeOf(worker.roleCeiling);
    const roles = AMUX_TASK_CATALOG_ROLES.filter((role) => worker.roles.includes(role));
    if (!grade || roles.length === 0) continue;
    const price = input.priceFor(worker.modelId, caps[grade].inputTokens, worker.provider);
    const uncached = microUsd(price?.inputUsdPerMillionTokens);
    const output = microUsd(price?.outputUsdPerMillionTokens);
    // A zero or missing price never becomes a free route.
    if (!price || uncached === null || output === null) continue;
    const verifiedWrite = microUsd(price.cacheWriteUsdPerMillionTokens) ??
      Math.ceil(uncached * 1.25);
    const multiplier = price.cachedInputPriceMultiplier;
    const cacheRead = Number.isFinite(multiplier) && multiplier > 0
      ? Math.ceil(uncached * multiplier) : uncached;
    const cacheWrite = verifiedWrite;
    const identity = { workerName: worker.workerName, provider: worker.provider,
      modelId: worker.modelId, roles, grade };
    routes.push({
      routeId: `v22:${worker.workerName}`,
      workerName: worker.workerName,
      provider: worker.provider,
      modelId: worker.modelId,
      // Only the route's identity, so a price change never asks an approved
      // Task to reconfirm its route.
      routePolicyDigest: sha256("amux-v4-task-route-policy-v1", identity),
      enabled: true,
      roles,
      grades: [grade],
      // A linked name names the entry that priced it; an unlinked one is unchanged.
      pricingSource: `model-registry:${price.linkedModelId ?? worker.modelId}`,
      pricingVerifiedAt: PRICES_FROM,
      pricingExpiresAt: PRICES_UNTIL,
      uncachedInputMicroUsdPerMillion: uncached,
      outputMicroUsdPerMillion: output,
      cacheReadMicroUsdPerMillion: cacheRead,
      cacheWriteMicroUsdPerMillion: cacheWrite,
      toolCostCapMicroUsdPerAttempt: 0,
    });
  }
  if (routes.length === 0) return { ok: false, code: "no_priced_worker" };
  const gradeRules = AMUX_TASK_CATALOG_ROLES.flatMap((role) =>
    AMUX_TASK_CATALOG_GRADES.map((grade) => ({ role, grade, caps: {
      uncachedInputTokens: caps[grade].inputTokens,
      outputTokens: caps[grade].outputTokens,
      cacheReadTokens: caps[grade].cacheReadTokens,
      cacheWriteTokens: caps[grade].cacheWriteTokens,
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

const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const PRICE_FIELDS = ["uncachedInputMicroUsdPerMillion", "cacheReadMicroUsdPerMillion",
  "cacheWriteMicroUsdPerMillion", "outputMicroUsdPerMillion"] as const;

/** The prices of one catalog route, for the assignment that reserves against it. */
export function amuxTaskRoutePrice(catalog: unknown, routeId: string): AmuxTaskRoutePrice | null {
  if (!catalog || typeof catalog !== "object") return null;
  const { pricingVersion, routes } = catalog as { pricingVersion?: unknown; routes?: unknown };
  if (typeof pricingVersion !== "string" || !Array.isArray(routes)) return null;
  const matches = routes.filter((route) => route?.routeId === routeId);
  return matches.length === 1 ? parseAmuxTaskRoutePrice({ ...pick(matches[0]), pricingVersion }) : null;
}

/** A recorded route price, or null when it is not exactly that shape. */
export function parseAmuxTaskRoutePrice(value: unknown): AmuxTaskRoutePrice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== PRICE_FIELDS.length + 2 ||
      typeof row.pricingVersion !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(row.pricingVersion) ||
      typeof row.modelId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(row.modelId) ||
      !PRICE_FIELDS.every((field) => nonnegative(row[field])) ||
      (row.uncachedInputMicroUsdPerMillion as number) <= 0 ||
      (row.outputMicroUsdPerMillion as number) <= 0) return null;
  return pick(row, ["pricingVersion", "modelId"]) as AmuxTaskRoutePrice;
}

const pick = (row: Record<string, unknown>, extra: string[] = ["modelId"]) =>
  Object.fromEntries([...extra, ...PRICE_FIELDS].map((field) => [field, row[field]]));
