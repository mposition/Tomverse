import { createHash } from "node:crypto";

import { amuxCanonicalJson } from "./boardImportCore.ts";
import { AMUX_EXECUTION_GRADE_WORKER_ROLE,
  type AmuxExecutionGrade } from "./executionGradeCore.ts";
import { calculateV4TaskCeilingFromCatalog,
  inspectV4TaskCostCatalog } from "./v4TaskCostCatalogCore.ts";

/**
 * The Task cost catalog drafted from what Tomverse already manages, so the
 * owner never types a price twice (owner decision 2026-10-25):
 *
 * - routes: the v22 workers the assignment catalog can start (provider
 *   anthropic), each at the one grade its registered role ceiling gives. A
 *   worker's price does not depend on the Task role, so each route prices
 *   every Task role; a Task's ceiling is the dearest route at its grade;
 * - prices: the chat model registry (Admin › Models), the same per-million
 *   rates Chat billing uses. Cache reads use the registry's cached-input
 *   multiplier; cache writes and tool costs are capped at zero;
 * - grade caps: the only values the owner sets here.
 *
 * Pure: the caller reads the registry and the server clock.
 */

export const AMUX_TASK_CATALOG_GRADES = ["routine", "advanced", "frontier"] as const;
/** Task roles a card may carry; review runs as independent review, not a Task. */
export const AMUX_TASK_CATALOG_ROLES = ["design", "implement", "test",
  "verify", "investigate", "operate"] as const;
/** How long a drafted price stays valid before it must be drafted again. */
export const AMUX_TASK_CATALOG_PRICE_DAYS = 90;

export type AmuxTaskCatalogGradeCaps = {
  inputTokens: number;
  outputTokens: number;
  maxAttempts: number;
};

export const AMUX_TASK_CATALOG_DEFAULT_CAPS: Readonly<Record<AmuxExecutionGrade,
  AmuxTaskCatalogGradeCaps>> = Object.freeze({
  routine: Object.freeze({ inputTokens: 300_000, outputTokens: 30_000, maxAttempts: 2 }),
  advanced: Object.freeze({ inputTokens: 600_000, outputTokens: 60_000, maxAttempts: 2 }),
  frontier: Object.freeze({ inputTokens: 1_000_000, outputTokens: 128_000, maxAttempts: 3 }),
});

export type AmuxTaskCatalogDraftWorker = {
  workerName: string;
  modelId: string;
  roleCeiling: string | null;
};

export type AmuxTaskCatalogRegistryPrice = {
  modelId: string;
  inputUsdPerMillionTokens: number | null;
  outputUsdPerMillionTokens: number | null;
  cachedInputPriceMultiplier: number | null;
};

export type AmuxTaskCatalogDraftRoute = {
  workerName: string;
  modelId: string;
  grade: AmuxExecutionGrade;
  roles: string[];
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

export type AmuxTaskCatalogSkippedWorker = {
  workerName: string;
  modelId: string;
  reason: "price_missing" | "grade_unknown";
};

export type AmuxTaskCatalogDraft =
  | { ok: true; catalog: Record<string, unknown>; catalogDigest: string;
      evidenceDigest: string; routes: AmuxTaskCatalogDraftRoute[];
      skipped: AmuxTaskCatalogSkippedWorker[];
      maxCostMicroUsd: Partial<Record<AmuxExecutionGrade, string>>;
      pricesExpireAt: string }
  | { ok: false; code: "caps_invalid" | "no_priced_worker";
      skipped: AmuxTaskCatalogSkippedWorker[] };

const sha256 = (tag: string, value: unknown) => createHash("sha256")
  .update(`${tag}\n`, "utf8").update(amuxCanonicalJson(value), "utf8").digest("hex");

const microUsd = (usd: number | null) =>
  typeof usd === "number" && Number.isFinite(usd) && usd > 0
    ? Math.ceil(usd * 1_000_000) : null;

const gradeOf = (roleCeiling: string | null): AmuxExecutionGrade | null => {
  const found = AMUX_TASK_CATALOG_GRADES.find((grade) =>
    AMUX_EXECUTION_GRADE_WORKER_ROLE[grade] === roleCeiling);
  return found ?? null;
};

const validCaps = (caps: AmuxTaskCatalogGradeCaps | undefined) =>
  !!caps && [caps.inputTokens, caps.outputTokens, caps.maxAttempts].every((value) =>
    Number.isSafeInteger(value) && value > 0) &&
  caps.inputTokens <= 10_000_000 && caps.outputTokens <= 1_000_000 &&
  caps.maxAttempts <= 10;

const stamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

export function draftAmuxV4TaskCostCatalog(input: {
  workers: readonly AmuxTaskCatalogDraftWorker[];
  prices: readonly AmuxTaskCatalogRegistryPrice[];
  caps: Readonly<Record<AmuxExecutionGrade, AmuxTaskCatalogGradeCaps>>;
  nowIso: string;
}): AmuxTaskCatalogDraft {
  const skipped: AmuxTaskCatalogSkippedWorker[] = [];
  if (!AMUX_TASK_CATALOG_GRADES.every((grade) => validCaps(input.caps[grade]))) {
    return { ok: false, code: "caps_invalid", skipped };
  }
  const priceOf = new Map(input.prices.map((price) => [price.modelId, price]));
  const expiresAt = new Date(Date.parse(input.nowIso) +
    AMUX_TASK_CATALOG_PRICE_DAYS * 86_400_000).toISOString();
  const routes: Record<string, unknown>[] = [];
  const summary: AmuxTaskCatalogDraftRoute[] = [];
  const evidence: Record<string, unknown>[] = [];
  for (const worker of [...input.workers].sort((a, b) =>
    a.workerName.localeCompare(b.workerName))) {
    const grade = gradeOf(worker.roleCeiling);
    const roles = [...AMUX_TASK_CATALOG_ROLES];
    const price = priceOf.get(worker.modelId);
    const input_ = microUsd(price?.inputUsdPerMillionTokens ?? null);
    const output = microUsd(price?.outputUsdPerMillionTokens ?? null);
    if (!grade) { skipped.push({ ...pick(worker), reason: "grade_unknown" }); continue; }
    if (input_ === null || output === null) {
      skipped.push({ ...pick(worker), reason: "price_missing" }); continue;
    }
    const multiplier = price?.cachedInputPriceMultiplier;
    const cacheRead = typeof multiplier === "number" && Number.isFinite(multiplier) &&
      multiplier > 0 ? Math.ceil(input_ * multiplier) : input_;
    const identity = { workerName: worker.workerName, provider: "anthropic",
      modelId: worker.modelId, roles, grade };
    routes.push({
      routeId: `v22:${worker.workerName}`,
      workerName: worker.workerName,
      provider: "anthropic",
      modelId: worker.modelId,
      // The same route always has the same policy digest, so drafting again
      // never makes an approved Task reconfirm its route.
      routePolicyDigest: sha256("amux-v4-task-route-policy-v1", identity),
      enabled: true,
      roles,
      grades: [grade],
      pricingSource: `model-registry:${worker.modelId}`,
      pricingVerifiedAt: input.nowIso,
      pricingExpiresAt: expiresAt,
      uncachedInputMicroUsdPerMillion: input_,
      outputMicroUsdPerMillion: output,
      cacheReadMicroUsdPerMillion: cacheRead,
      cacheWriteMicroUsdPerMillion: 0,
      toolCostCapMicroUsdPerAttempt: 0,
    });
    summary.push({ workerName: worker.workerName, modelId: worker.modelId, grade,
      roles, inputUsdPerMillion: input_ / 1_000_000, outputUsdPerMillion: output / 1_000_000 });
    evidence.push({ modelId: worker.modelId, input: input_, output, cacheRead });
  }
  if (routes.length === 0) return { ok: false, code: "no_priced_worker", skipped };
  const gradeRules = AMUX_TASK_CATALOG_ROLES.flatMap((role) =>
    AMUX_TASK_CATALOG_GRADES.map((grade) => ({ role, grade, caps: {
      uncachedInputTokens: input.caps[grade].inputTokens,
      outputTokens: input.caps[grade].outputTokens,
      cacheReadTokens: 0, cacheWriteTokens: 0,
      maxAttempts: input.caps[grade].maxAttempts } })));
  const evidenceDigest = sha256("amux-v4-task-catalog-model-registry-v1",
    { source: "model-registry", prices: evidence });
  const catalog = {
    schemaVersion: 1,
    catalogVersion: `auto-${stamp(input.nowIso)}`,
    pricingVersion: `model-registry-${evidenceDigest.slice(0, 12)}`,
    gradeRulesVersion: `grade-caps-${sha256("amux-v4-task-grade-caps-v1",
      input.caps).slice(0, 12)}`,
    gradeRules,
    routes,
  };
  const inspection = inspectV4TaskCostCatalog(catalog);
  if (!inspection.ok) return { ok: false, code: "caps_invalid", skipped };
  const maxCostMicroUsd: Partial<Record<AmuxExecutionGrade, string>> = {};
  for (const grade of AMUX_TASK_CATALOG_GRADES) {
    // Caps and prices are the same for every role, so one role stands for all.
    if (!summary.some((route) => route.grade === grade)) continue;
    const cost = calculateV4TaskCeilingFromCatalog({ rawCatalog: catalog,
      role: AMUX_TASK_CATALOG_ROLES[0], grade, asOfIso: input.nowIso });
    if (cost.ok) maxCostMicroUsd[grade] = cost.receipt.ceilingMicroUsd;
  }
  return { ok: true, catalog, catalogDigest: inspection.catalogDigest,
    evidenceDigest, routes: summary, skipped, maxCostMicroUsd,
    pricesExpireAt: expiresAt };
}

const pick = (worker: AmuxTaskCatalogDraftWorker) =>
  ({ workerName: worker.workerName, modelId: worker.modelId });
