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
 *   anthropic), each at the one grade its registered role ceiling gives and
 *   for the Task roles its v22 profile actually runs -- the ready check reads
 *   the same roles, so a Task no worker can run gets no ceiling;
 * - prices: the chat model registry (Admin › Models) resolved the way Chat
 *   bills it, at the tier the grade's input cap reaches. Cache reads use the
 *   resolved cached-input multiplier; cache writes and tool costs are capped
 *   at zero;
 * - grade caps: the only values the owner sets here.
 *
 * Pure: the caller resolves prices and reads the registry and the clock. The
 * approval redrafts from the same inputs and must reach the same digest.
 */

export const AMUX_TASK_CATALOG_GRADES = ["routine", "advanced", "frontier"] as const;
/** Task roles a card may carry; review runs as independent review, not a Task. */
export const AMUX_TASK_CATALOG_ROLES = ["design", "implement", "test",
  "verify", "investigate", "operate"] as const;
/** How long a drafted price stays valid before it must be drafted again. */
export const AMUX_TASK_CATALOG_PRICE_DAYS = 90;
export const AMUX_TASK_CATALOG_VERSION = /^auto-\d{8}T\d{9}Z-[a-f0-9]{8}$/;

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
  /** The v22 profile's roles. */
  roles: readonly string[];
  roleCeiling: string | null;
};

export type AmuxTaskCatalogResolvedPrice = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  cachedInputPriceMultiplier: number;
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
  reason: "price_missing" | "grade_unknown" | "roles_missing";
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

const microUsd = (usd: number | null | undefined) =>
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

/** A version no other draft shares: the draft time to the millisecond and a nonce. */
export const amuxTaskCatalogVersion = (nowIso: string, nonceHex: string) =>
  `auto-${nowIso.replace(/[-:.]/g, "")}-${nonceHex}`;

/** The grade caps a drafted catalog was built with, or null when they are not uniform. */
export function amuxTaskCatalogCapsOf(catalog: { gradeRules: ReadonlyArray<{
  grade: string; caps: { uncachedInputTokens: number; outputTokens: number;
    maxAttempts: number } }> }): Record<AmuxExecutionGrade, AmuxTaskCatalogGradeCaps> | null {
  const caps: Partial<Record<AmuxExecutionGrade, AmuxTaskCatalogGradeCaps>> = {};
  for (const rule of catalog.gradeRules) {
    if (!(AMUX_TASK_CATALOG_GRADES as readonly string[]).includes(rule.grade)) return null;
    const value = { inputTokens: rule.caps.uncachedInputTokens,
      outputTokens: rule.caps.outputTokens, maxAttempts: rule.caps.maxAttempts };
    const seen = caps[rule.grade as AmuxExecutionGrade];
    if (seen && amuxCanonicalJson(seen) !== amuxCanonicalJson(value)) return null;
    caps[rule.grade as AmuxExecutionGrade] = value;
  }
  return AMUX_TASK_CATALOG_GRADES.every((grade) => caps[grade])
    ? caps as Record<AmuxExecutionGrade, AmuxTaskCatalogGradeCaps> : null;
}

export function draftAmuxV4TaskCostCatalog(input: {
  workers: readonly AmuxTaskCatalogDraftWorker[];
  /** The registry price for a model at a prompt of this many input tokens. */
  priceFor: (modelId: string, inputTokens: number) => AmuxTaskCatalogResolvedPrice | null;
  caps: Readonly<Record<AmuxExecutionGrade, AmuxTaskCatalogGradeCaps>>;
  nowIso: string;
  catalogVersion: string;
}): AmuxTaskCatalogDraft {
  const skipped: AmuxTaskCatalogSkippedWorker[] = [];
  if (!AMUX_TASK_CATALOG_GRADES.every((grade) => validCaps(input.caps[grade])) ||
      !AMUX_TASK_CATALOG_VERSION.test(input.catalogVersion)) {
    return { ok: false, code: "caps_invalid", skipped };
  }
  const expiresAt = new Date(Date.parse(input.nowIso) +
    AMUX_TASK_CATALOG_PRICE_DAYS * 86_400_000).toISOString();
  const routes: Record<string, unknown>[] = [];
  const summary: AmuxTaskCatalogDraftRoute[] = [];
  const evidence: Record<string, unknown>[] = [];
  for (const worker of [...input.workers].sort((a, b) =>
    a.workerName.localeCompare(b.workerName))) {
    const pick = { workerName: worker.workerName, modelId: worker.modelId };
    const grade = gradeOf(worker.roleCeiling);
    if (!grade) { skipped.push({ ...pick, reason: "grade_unknown" }); continue; }
    const roles = AMUX_TASK_CATALOG_ROLES.filter((role) => worker.roles.includes(role));
    if (roles.length === 0) { skipped.push({ ...pick, reason: "roles_missing" }); continue; }
    const price = input.priceFor(worker.modelId, input.caps[grade].inputTokens);
    const uncached = microUsd(price?.inputUsdPerMillionTokens);
    const output = microUsd(price?.outputUsdPerMillionTokens);
    if (!price || uncached === null || output === null) {
      skipped.push({ ...pick, reason: "price_missing" }); continue;
    }
    const multiplier = price.cachedInputPriceMultiplier;
    const cacheRead = Number.isFinite(multiplier) && multiplier > 0
      ? Math.ceil(uncached * multiplier) : uncached;
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
      uncachedInputMicroUsdPerMillion: uncached,
      outputMicroUsdPerMillion: output,
      cacheReadMicroUsdPerMillion: cacheRead,
      cacheWriteMicroUsdPerMillion: 0,
      toolCostCapMicroUsdPerAttempt: 0,
    });
    summary.push({ ...pick, grade, roles, inputUsdPerMillion: uncached / 1_000_000,
      outputUsdPerMillion: output / 1_000_000 });
    evidence.push({ workerName: worker.workerName, modelId: worker.modelId,
      input: uncached, output, cacheRead });
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
    catalogVersion: input.catalogVersion,
    pricingVersion: `model-registry-${evidenceDigest.slice(0, 12)}`,
    gradeRulesVersion: `grade-caps-${sha256("amux-v4-task-grade-caps-v1",
      input.caps).slice(0, 12)}`,
    gradeRules,
    routes,
  };
  const inspection = inspectV4TaskCostCatalog(catalog);
  if (!inspection.ok) return { ok: false, code: "caps_invalid", skipped };
  // What one Task of the grade can cost at most, over the roles priced there.
  const maxCostMicroUsd: Partial<Record<AmuxExecutionGrade, string>> = {};
  for (const grade of AMUX_TASK_CATALOG_GRADES) {
    for (const role of AMUX_TASK_CATALOG_ROLES) {
      if (!summary.some((route) => route.grade === grade && route.roles.includes(role))) continue;
      const cost = calculateV4TaskCeilingFromCatalog({ rawCatalog: catalog, role,
        grade, asOfIso: input.nowIso });
      if (cost.ok && BigInt(cost.receipt.ceilingMicroUsd) >
          BigInt(maxCostMicroUsd[grade] ?? "0")) {
        maxCostMicroUsd[grade] = cost.receipt.ceilingMicroUsd;
      }
    }
  }
  return { ok: true, catalog, catalogDigest: inspection.catalogDigest,
    evidenceDigest, routes: summary, skipped, maxCostMicroUsd,
    pricesExpireAt: expiresAt };
}
