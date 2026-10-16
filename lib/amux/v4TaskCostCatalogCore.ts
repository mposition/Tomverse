import { createHash } from "node:crypto";
import { z } from "zod";

import { amuxCanonicalJson } from "./boardImportCore.ts";
import { amuxWorkerMatchesExecutionGrade } from "./executionGradeCore.ts";
import type { AmuxWorkerRoleCeiling } from "./workerRegistryCore.ts";
import {
  calculateV4TaskCostCeiling,
  checkV4TaskApprovedCeiling,
  type V4TaskCostCeilingReceipt,
} from "./v4TaskCostCeilingCore.ts";

/**
 * Dark contract only. The app must load this JSON from an operator-controlled,
 * immutable versioned source, verify its price evidence and approval, and keep
 * the result separate from Chat pricing and user credits. The asOfIso used for
 * a receipt must come from the server clock, never a request or model output.
 * No such loader or active v4 Task writer is connected here.
 */

const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9._:/-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const utcIso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const safeNonnegative = z.number().int().nonnegative().refine(Number.isSafeInteger);
const safePositive = safeNonnegative.refine((value) => value > 0);

const capsSchema = z.object({
  uncachedInputTokens: safeNonnegative,
  outputTokens: safePositive,
  cacheReadTokens: safeNonnegative,
  cacheWriteTokens: safeNonnegative,
  maxAttempts: safePositive,
}).strict().refine((caps) =>
  caps.uncachedInputTokens > 0 || caps.cacheReadTokens > 0 || caps.cacheWriteTokens > 0,
);

const gradeRuleSchema = z.object({
  role: id,
  grade: id,
  caps: capsSchema,
}).strict();

const routeSchema = z.object({
  routeId: id,
  workerName: id,
  provider: id,
  modelId: id,
  routePolicyDigest: digest,
  enabled: z.boolean(),
  roles: z.array(id).min(1).max(64),
  grades: z.array(id).min(1).max(64),
  pricingSource: id,
  pricingVerifiedAt: utcIso,
  pricingExpiresAt: utcIso,
  uncachedInputMicroUsdPerMillion: safePositive,
  outputMicroUsdPerMillion: safePositive,
  cacheReadMicroUsdPerMillion: safeNonnegative,
  cacheWriteMicroUsdPerMillion: safeNonnegative,
  toolCostCapMicroUsdPerAttempt: safeNonnegative,
}).strict();

const catalogSchema = z.object({
  schemaVersion: z.literal(1),
  catalogVersion: id,
  pricingVersion: id,
  gradeRulesVersion: id,
  gradeRules: z.array(gradeRuleSchema).min(1).max(256),
  routes: z.array(routeSchema).min(1).max(128),
}).strict();

export type V4TaskCostCatalog = z.infer<typeof catalogSchema>;

export type V4TaskApiExecutionBasis = {
  catalogVersion: string;
  catalogDigest: string;
  pricingVersion: string;
  pricingSource: string;
  pricingVerifiedAt: string;
  pricingExpiresAt: string;
  uncachedInputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
  cacheReadMicroUsdPerMillion: number;
  cacheWriteMicroUsdPerMillion: number;
  tokenLimits: {
    uncachedInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
};

type ParsedCatalog = {
  catalog: V4TaskCostCatalog;
  catalogDigest: string;
};

export type V4TaskCatalogInspection =
  | { ok: true; catalogDigest: string; ruleCount: number; routeCount: number }
  | { ok: false; code: "schema_rejected" | "duplicate_identity" | "unpriced_route" };

const parseCatalog = (raw: unknown): ParsedCatalog | V4TaskCatalogInspection & { ok: false } => {
  const parsed = catalogSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: "schema_rejected" };
  const catalog = parsed.data;
  const rules = new Set<string>();
  for (const rule of catalog.gradeRules) {
    const key = `${rule.role}\0${rule.grade}`;
    if (rules.has(key)) return { ok: false, code: "duplicate_identity" };
    rules.add(key);
  }
  const routeIds = new Set<string>();
  for (const route of catalog.routes) {
    if (routeIds.has(route.routeId) ||
      new Set(route.roles).size !== route.roles.length ||
      new Set(route.grades).size !== route.grades.length) {
      return { ok: false, code: "duplicate_identity" };
    }
    routeIds.add(route.routeId);
    if (route.pricingExpiresAt <= route.pricingVerifiedAt) {
      return { ok: false, code: "schema_rejected" };
    }
    if (route.cacheReadMicroUsdPerMillion === 0 && catalog.gradeRules.some((rule) =>
      route.enabled && route.roles.includes(rule.role) && route.grades.includes(rule.grade) &&
      rule.caps.cacheReadTokens > 0)) {
      return { ok: false, code: "unpriced_route" };
    }
    if (route.cacheWriteMicroUsdPerMillion === 0 && catalog.gradeRules.some((rule) =>
      route.enabled && route.roles.includes(rule.role) && route.grades.includes(rule.grade) &&
      rule.caps.cacheWriteTokens > 0)) {
      return { ok: false, code: "unpriced_route" };
    }
  }
  // Canonical object keys but exact array order: the digest binds the precise
  // published catalog bytes after strict schema normalization, not an
  // order-insensitive semantic set.
  const catalogDigest = createHash("sha256")
    .update("amux-v4-task-cost-catalog-v1\n", "utf8")
    .update(amuxCanonicalJson(catalog), "utf8")
    .digest("hex");
  return { catalog, catalogDigest };
};

export function inspectV4TaskCostCatalog(raw: unknown): V4TaskCatalogInspection {
  const parsed = parseCatalog(raw);
  if ("ok" in parsed) return parsed;
  return {
    ok: true,
    catalogDigest: parsed.catalogDigest,
    ruleCount: parsed.catalog.gradeRules.length,
    routeCount: parsed.catalog.routes.length,
  };
}

/** v52 approval guard: every route has one grade and its registered worker has that grade. */
export function inspectV52TaskCatalogGrades(raw: unknown,
  workerGrades: ReadonlyMap<string, AmuxWorkerRoleCeiling> | null):
  { ok: true } | { ok: false; code: "schema_rejected" |
    "worker_registry_unavailable" | "grade_route_mismatch" } {
  const parsed = parseCatalog(raw);
  if ("ok" in parsed) return { ok: false, code: "schema_rejected" };
  if (!workerGrades) return { ok: false, code: "worker_registry_unavailable" };
  for (const route of parsed.catalog.routes) {
    if (route.grades.length !== 1 ||
        !amuxWorkerMatchesExecutionGrade(route.grades[0], route.workerName,
          workerGrades)) {
      return { ok: false, code: "grade_route_mismatch" };
    }
  }
  return { ok: true };
}

export type V4TaskCatalogCeilingResult =
  | { ok: true; receipt: V4TaskCostCeilingReceipt }
  | { ok: false; code: string };

/** Re-parse on each use; never trust a model-provided digest or cost number. */
export function calculateV4TaskCeilingFromCatalog(input: {
  rawCatalog: unknown;
  role: unknown;
  grade: unknown;
  asOfIso: unknown;
}): V4TaskCatalogCeilingResult {
  if (!input || typeof input !== "object") return { ok: false, code: "schema_rejected" };
  const parsed = parseCatalog(input.rawCatalog);
  if ("ok" in parsed) return parsed;
  const parsedAsOf = utcIso.safeParse(input.asOfIso);
  if (typeof input.role !== "string" || typeof input.grade !== "string" ||
    !parsedAsOf.success) return { ok: false, code: "selection_invalid" };
  const rule = parsed.catalog.gradeRules.find((entry) =>
    entry.role === input.role && entry.grade === input.grade);
  if (!rule) return { ok: false, code: "grade_rule_missing" };
  const asOfIso = parsedAsOf.data;
  if (parsed.catalog.routes.some((route) => route.enabled &&
    route.roles.includes(rule.role) && route.grades.includes(rule.grade) &&
    (route.pricingVerifiedAt > asOfIso || route.pricingExpiresAt <= asOfIso))) {
    return { ok: false, code: "pricing_unverified" };
  }
  const cost = calculateV4TaskCostCeiling({
    role: rule.role,
    grade: rule.grade,
    catalogVersion: parsed.catalog.catalogVersion,
    catalogDigest: parsed.catalogDigest,
    pricingVersion: parsed.catalog.pricingVersion,
    gradeRulesVersion: parsed.catalog.gradeRulesVersion,
    asOfIso,
    caps: rule.caps,
    routes: parsed.catalog.routes,
  });
  return cost.ok ? cost : { ok: false, code: cost.reason };
}

/**
 * Select the price and token basis for one already-approved route. The caller
 * remains responsible for loading `rawCatalog` from the immutable approval
 * row; request or model supplied rates must never reach this function.
 */
export function resolveV4TaskApiExecutionBasis(input: {
  rawCatalog: unknown;
  role: unknown;
  grade: unknown;
  routeId: unknown;
  asOfIso: unknown;
}): { ok: true; basis: V4TaskApiExecutionBasis } |
  { ok: false; code: string } {
  const parsed = parseCatalog(input.rawCatalog);
  if ("ok" in parsed) return parsed;
  const parsedAsOf = utcIso.safeParse(input.asOfIso);
  if (typeof input.role !== "string" || typeof input.grade !== "string" ||
      typeof input.routeId !== "string" || !parsedAsOf.success) {
    return { ok: false, code: "selection_invalid" };
  }
  const rule = parsed.catalog.gradeRules.find((entry) =>
    entry.role === input.role && entry.grade === input.grade);
  const route = parsed.catalog.routes.find((entry) => entry.routeId === input.routeId);
  if (!rule || !route || !route.enabled || !route.roles.includes(input.role) ||
      !route.grades.includes(input.grade)) {
    return { ok: false, code: "route_unavailable" };
  }
  const asOfIso = parsedAsOf.data;
  if (route.pricingVerifiedAt > asOfIso || route.pricingExpiresAt <= asOfIso ||
      route.uncachedInputMicroUsdPerMillion <= 0 ||
      route.outputMicroUsdPerMillion <= 0 ||
      (rule.caps.cacheReadTokens > 0 && route.cacheReadMicroUsdPerMillion <= 0) ||
      (rule.caps.cacheWriteTokens > 0 && route.cacheWriteMicroUsdPerMillion <= 0)) {
    return { ok: false, code: "pricing_unverified" };
  }
  return { ok: true, basis: {
    catalogVersion: parsed.catalog.catalogVersion,
    catalogDigest: parsed.catalogDigest,
    pricingVersion: parsed.catalog.pricingVersion,
    pricingSource: route.pricingSource,
    pricingVerifiedAt: route.pricingVerifiedAt,
    pricingExpiresAt: route.pricingExpiresAt,
    uncachedInputMicroUsdPerMillion: route.uncachedInputMicroUsdPerMillion,
    outputMicroUsdPerMillion: route.outputMicroUsdPerMillion,
    cacheReadMicroUsdPerMillion: route.cacheReadMicroUsdPerMillion,
    cacheWriteMicroUsdPerMillion: route.cacheWriteMicroUsdPerMillion,
    tokenLimits: {
      uncachedInputTokens: rule.caps.uncachedInputTokens,
      outputTokens: rule.caps.outputTokens,
      cacheReadTokens: rule.caps.cacheReadTokens,
      cacheWriteTokens: rule.caps.cacheWriteTokens,
    },
  } };
}

/** Preserve a concrete refusal reason when passing a catalog result to the approval guard. */
export function checkV4TaskApprovedCatalogCeiling(
  approved: unknown,
  current: V4TaskCatalogCeilingResult,
): { decision: "allow" | "reconfirm" | "hold"; reason: string } {
  if (!current.ok) return { decision: "hold", reason: current.code };
  return checkV4TaskApprovedCeiling(approved, current);
}
