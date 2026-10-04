/**
 * Pure, dark v4 Task cost contract. Callers supply a version-pinned, verified
 * catalog; this module neither reads the legacy estimate nor enables execution.
 * Rates are integer micro-USD per million tokens, not current CLI billing.
 *
 * Integration gate: the caller must bind the receipt to the canonical Task and
 * owner approval, dispatch only a route in the recalculated receipt, enforce
 * disjoint token caps cumulatively across every call in an attempt, count paid
 * SDK retries as attempts, and refuse a paid tool if its enforced cap is zero.
 * Catalog rates must be the worst applicable tier (context, cache duration,
 * region and service tier); reasoning tokens count toward output. If any of
 * those facts cannot be enforced or priced, registration/execution remains off.
 */

import { createHash } from "node:crypto";

const TOKENS_PER_MILLION = BigInt(1_000_000);
const MAX_DB_MICROUSD = BigInt("9223372036854775807");
const DIGEST = /^[a-f0-9]{64}$/i;
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type V4TaskTokenCaps = {
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  maxAttempts: number;
};

export type V4TaskPricedRoute = {
  routeId: string;
  workerName: string;
  provider: string;
  modelId: string;
  routePolicyDigest: string;
  enabled: boolean;
  roles: readonly string[];
  grades: readonly string[];
  pricingSource: string;
  pricingVerifiedAt: string;
  uncachedInputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
  cacheReadMicroUsdPerMillion: number;
  cacheWriteMicroUsdPerMillion: number;
  toolCostCapMicroUsdPerAttempt: number;
};

export type V4TaskCostCeilingInput = {
  role: string;
  grade: string;
  catalogVersion: string;
  catalogDigest: string;
  pricingVersion: string;
  gradeRulesVersion: string;
  asOfIso: string;
  caps: V4TaskTokenCaps;
  routes: readonly V4TaskPricedRoute[];
};

export type V4TaskRouteCost = {
  routeId: string;
  workerName: string;
  provider: string;
  modelId: string;
  routePolicyDigest: string;
  perAttemptMicroUsd: string;
};

export type V4TaskCostCeilingReceipt = {
  role: string;
  grade: string;
  catalogVersion: string;
  catalogDigest: string;
  pricingVersion: string;
  gradeRulesVersion: string;
  calculatedAtIso: string;
  caps: V4TaskTokenCaps;
  routes: V4TaskRouteCost[];
  ceilingMicroUsd: string;
  receiptDigest: string;
};

export type V4TaskCostCeilingResult =
  | { ok: true; receipt: V4TaskCostCeilingReceipt }
  | {
      ok: false;
      reason:
        | "basis_missing"
        | "caps_invalid"
        | "route_duplicate"
        | "route_unavailable"
        | "pricing_unverified"
        | "amount_overflow";
    };

const boundedText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 160 && value === value.trim();

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.length <= 64 &&
  value.every(boundedText);

const utcIso = (value: unknown): value is string =>
  typeof value === "string" && UTC_ISO.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

const nonnegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const ceilDivide = (value: bigint, divisor: bigint) =>
  (value + divisor - BigInt(1)) / divisor;

const validCaps = (value: unknown): value is V4TaskTokenCaps => {
  if (!record(value)) return false;
  const fields = [
    "uncachedInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "maxAttempts",
  ];
  if (Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key))) return false;
  return nonnegativeSafeInteger(value.uncachedInputTokens) &&
    nonnegativeSafeInteger(value.outputTokens) &&
    nonnegativeSafeInteger(value.cacheReadTokens) &&
    nonnegativeSafeInteger(value.cacheWriteTokens) &&
    nonnegativeSafeInteger(value.maxAttempts) &&
    value.maxAttempts > 0 &&
    (value.uncachedInputTokens > 0 || value.cacheReadTokens > 0 || value.cacheWriteTokens > 0) &&
    value.outputTokens > 0;
};

const decimalAmount = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 19 && /^(0|[1-9]\d*)$/.test(value) &&
  BigInt(value) <= MAX_DB_MICROUSD;

const asciiOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

const canonicalCaps = (caps: V4TaskTokenCaps): V4TaskTokenCaps => ({
  uncachedInputTokens: caps.uncachedInputTokens,
  outputTokens: caps.outputTokens,
  cacheReadTokens: caps.cacheReadTokens,
  cacheWriteTokens: caps.cacheWriteTokens,
  maxAttempts: caps.maxAttempts,
});

const receiptDigest = (receipt: Omit<V4TaskCostCeilingReceipt, "receiptDigest">) =>
  createHash("sha256")
    .update("amux-v4-task-cost-receipt-v1\n", "utf8")
    .update(JSON.stringify(receipt), "utf8")
    .digest("hex");

/**
 * Every eligible route must be fully priced. A missing price on a route that
 * may be selected cannot be ignored in favour of a cheaper route.
 */
export function calculateV4TaskCostCeiling(
  input: unknown,
): V4TaskCostCeilingResult {
  if (!record(input)) return { ok: false, reason: "basis_missing" };
  if (
    !boundedText(input.role) ||
    !boundedText(input.grade) ||
    !boundedText(input.catalogVersion) ||
    typeof input.catalogDigest !== "string" ||
    !DIGEST.test(input.catalogDigest) ||
    !boundedText(input.pricingVersion) ||
    !boundedText(input.gradeRulesVersion) ||
    !utcIso(input.asOfIso) ||
    !Array.isArray(input.routes) ||
    input.routes.length > 128
  ) {
    return { ok: false, reason: "basis_missing" };
  }
  if (!validCaps(input.caps)) return { ok: false, reason: "caps_invalid" };

  const seen = new Set<string>();
  const eligible: V4TaskPricedRoute[] = [];
  for (const value of input.routes) {
    if (
      !record(value) ||
      !boundedText(value.routeId) ||
      !boundedText(value.workerName) ||
      !boundedText(value.provider) ||
      !boundedText(value.modelId) ||
      typeof value.routePolicyDigest !== "string" ||
      !DIGEST.test(value.routePolicyDigest) ||
      typeof value.enabled !== "boolean" ||
      !textArray(value.roles) ||
      !textArray(value.grades)
    ) {
      return { ok: false, reason: "basis_missing" };
    }
    if (seen.has(value.routeId)) return { ok: false, reason: "route_duplicate" };
    seen.add(value.routeId);
    if (value.enabled === true && value.roles.includes(input.role) && value.grades.includes(input.grade)) {
      eligible.push(value as V4TaskPricedRoute);
    }
  }
  if (eligible.length === 0) return { ok: false, reason: "route_unavailable" };

  const costs: V4TaskRouteCost[] = [];
  let highestPerAttempt = BigInt(0);
  for (const route of eligible) {
    if (
      !boundedText(route.pricingSource) ||
      !utcIso(route.pricingVerifiedAt) ||
      route.pricingVerifiedAt > input.asOfIso ||
      !nonnegativeSafeInteger(route.uncachedInputMicroUsdPerMillion) ||
      route.uncachedInputMicroUsdPerMillion === 0 ||
      !nonnegativeSafeInteger(route.outputMicroUsdPerMillion) ||
      route.outputMicroUsdPerMillion === 0 ||
      !nonnegativeSafeInteger(route.cacheReadMicroUsdPerMillion) ||
      (input.caps.cacheReadTokens > 0 && route.cacheReadMicroUsdPerMillion === 0) ||
      !nonnegativeSafeInteger(route.cacheWriteMicroUsdPerMillion) ||
      (input.caps.cacheWriteTokens > 0 && route.cacheWriteMicroUsdPerMillion === 0) ||
      !nonnegativeSafeInteger(route.toolCostCapMicroUsdPerAttempt)
    ) {
      return { ok: false, reason: "pricing_unverified" };
    }

    // Category caps are disjoint. The usage adapter must split cache tokens
    // out of total input before checking these bounds.
    const tokenCost =
      ceilDivide(
        BigInt(input.caps.uncachedInputTokens) * BigInt(route.uncachedInputMicroUsdPerMillion),
        TOKENS_PER_MILLION,
      ) +
      ceilDivide(
        BigInt(input.caps.outputTokens) * BigInt(route.outputMicroUsdPerMillion),
        TOKENS_PER_MILLION,
      ) +
      ceilDivide(
        BigInt(input.caps.cacheReadTokens) * BigInt(route.cacheReadMicroUsdPerMillion),
        TOKENS_PER_MILLION,
      ) +
      ceilDivide(
        BigInt(input.caps.cacheWriteTokens) * BigInt(route.cacheWriteMicroUsdPerMillion),
        TOKENS_PER_MILLION,
      );
    const perAttempt = tokenCost + BigInt(route.toolCostCapMicroUsdPerAttempt);
    if (perAttempt > MAX_DB_MICROUSD) return { ok: false, reason: "amount_overflow" };
    if (perAttempt > highestPerAttempt) highestPerAttempt = perAttempt;
    costs.push({
      routeId: route.routeId,
      workerName: route.workerName,
      provider: route.provider,
      modelId: route.modelId,
      routePolicyDigest: route.routePolicyDigest.toLowerCase(),
      perAttemptMicroUsd: perAttempt.toString(),
    });
  }

  const ceiling = highestPerAttempt * BigInt(input.caps.maxAttempts);
  if (ceiling > MAX_DB_MICROUSD) return { ok: false, reason: "amount_overflow" };
  costs.sort((a, b) => asciiOrder(a.routeId, b.routeId));
  const receiptCore: Omit<V4TaskCostCeilingReceipt, "receiptDigest"> = {
    role: input.role,
    grade: input.grade,
    catalogVersion: input.catalogVersion,
    catalogDigest: input.catalogDigest.toLowerCase(),
    pricingVersion: input.pricingVersion,
    gradeRulesVersion: input.gradeRulesVersion,
    calculatedAtIso: input.asOfIso,
    caps: canonicalCaps(input.caps),
    routes: costs,
    ceilingMicroUsd: ceiling.toString(),
  };
  return {
    ok: true,
    receipt: {
      ...receiptCore,
      receiptDigest: receiptDigest(receiptCore),
    },
  };
}

export type V4TaskApprovedCeiling = V4TaskCostCeilingReceipt;

const approvedReceiptValid = (value: unknown): value is V4TaskApprovedCeiling => {
  if (!record(value) ||
    !boundedText(value.role) ||
    !boundedText(value.grade) ||
    !boundedText(value.catalogVersion) ||
    typeof value.catalogDigest !== "string" || !DIGEST.test(value.catalogDigest) ||
    !boundedText(value.pricingVersion) ||
    !boundedText(value.gradeRulesVersion) ||
    !utcIso(value.calculatedAtIso) ||
    !validCaps(value.caps) ||
    !decimalAmount(value.ceilingMicroUsd) ||
    typeof value.receiptDigest !== "string" || !DIGEST.test(value.receiptDigest) ||
    !Array.isArray(value.routes) || value.routes.length === 0 || value.routes.length > 128
  ) return false;

  const routes: V4TaskRouteCost[] = [];
  const seen = new Set<string>();
  for (const item of value.routes) {
    if (!record(item) ||
      !boundedText(item.routeId) ||
      !boundedText(item.workerName) ||
      !boundedText(item.provider) ||
      !boundedText(item.modelId) ||
      typeof item.routePolicyDigest !== "string" || !DIGEST.test(item.routePolicyDigest) ||
      !decimalAmount(item.perAttemptMicroUsd) ||
      seen.has(item.routeId)
    ) return false;
    seen.add(item.routeId);
    routes.push({
      routeId: item.routeId,
      workerName: item.workerName,
      provider: item.provider,
      modelId: item.modelId,
      routePolicyDigest: item.routePolicyDigest,
      perAttemptMicroUsd: item.perAttemptMicroUsd,
    });
  }
  if (routes.some((route, index) => index > 0 &&
    asciiOrder(routes[index - 1].routeId, route.routeId) >= 0)) return false;
  const impliedCeiling = routes.reduce((max, route) => {
    const amount = BigInt(route.perAttemptMicroUsd);
    return amount > max ? amount : max;
  }, BigInt(0)) * BigInt(value.caps.maxAttempts);
  if (impliedCeiling.toString() !== value.ceilingMicroUsd) return false;

  // This digest detects accidental receipt drift. Only the separate canonical
  // owner approval, loaded from the app DB and bound to the Task, authorizes it.
  const core: Omit<V4TaskCostCeilingReceipt, "receiptDigest"> = {
    role: value.role,
    grade: value.grade,
    catalogVersion: value.catalogVersion,
    catalogDigest: value.catalogDigest,
    pricingVersion: value.pricingVersion,
    gradeRulesVersion: value.gradeRulesVersion,
    calculatedAtIso: value.calculatedAtIso,
    caps: canonicalCaps(value.caps),
    routes,
    ceilingMicroUsd: value.ceilingMicroUsd,
  };
  return receiptDigest(core) === value.receiptDigest;
};

export function checkV4TaskApprovedCeiling(
  approved: unknown,
  current: V4TaskCostCeilingResult,
): { decision: "allow" | "reconfirm" | "hold"; reason: string } {
  if (!approvedReceiptValid(approved)) {
    return { decision: "hold", reason: "approval_invalid" };
  }
  if (!current.ok) return { decision: "hold", reason: current.reason };
  const approvedAmount = BigInt(approved.ceilingMicroUsd);
  if (approved.role !== current.receipt.role || approved.grade !== current.receipt.grade) {
    return { decision: "reconfirm", reason: "task_route_changed" };
  }
  const approvedRoutes = new Map(approved.routes.map((route) => [route.routeId, route]));
  if (approvedRoutes.size !== approved.routes.length) {
    return { decision: "hold", reason: "approval_invalid" };
  }
  if (current.receipt.routes.some((route) => {
    const old = approvedRoutes.get(route.routeId);
    return !old || old.workerName !== route.workerName ||
      old.provider !== route.provider || old.modelId !== route.modelId ||
      old.routePolicyDigest !== route.routePolicyDigest;
  })) {
    return { decision: "reconfirm", reason: "task_route_changed" };
  }
  if (
    current.receipt.caps.uncachedInputTokens > approved.caps.uncachedInputTokens ||
    current.receipt.caps.outputTokens > approved.caps.outputTokens ||
    current.receipt.caps.cacheReadTokens > approved.caps.cacheReadTokens ||
    current.receipt.caps.cacheWriteTokens > approved.caps.cacheWriteTokens ||
    current.receipt.caps.maxAttempts > approved.caps.maxAttempts
  ) {
    return { decision: "reconfirm", reason: "task_bounds_increased" };
  }
  if (BigInt(current.receipt.ceilingMicroUsd) > approvedAmount) {
    return { decision: "reconfirm", reason: "ceiling_increased" };
  }
  return { decision: "allow", reason: "within_approved_ceiling" };
}
