/** Assignment is deliberately distinct from execution start. The role/grade
 * and route facts come from owner-approved receipts, never model prose. */
export const AMUX_V22_WORKER_CLAIM_CODE_LATCH = true;
export const AMUX_V22_WORKER_CLAIM_ENV = "TOMVERSE_AMUX_V22_WORKER_CLAIM";
export const AMUX_V22_GLOBAL_ACTIVE_LIMIT = 3;
export const AMUX_V22_PER_WORKER_ACTIVE_LIMIT = 1;
export const AMUX_V22_CLAIM_LANES = ["normal", "parallel", "sev1"] as const;
export type AmuxV22ClaimLane = (typeof AMUX_V22_CLAIM_LANES)[number];
const ROLE_TOOL: Record<string, string> = {
  design: "repo_read", implement: "repo_write", test: "test_run",
  review: "repo_read", verify: "test_run", investigate: "repo_read",
  operate: "operations",
};
export const amuxV22RequiredTool = (role: string) => ROLE_TOOL[role] ?? null;

/** The environment-gated A15 one-shot path only has these Claude capabilities.
 * Do not claim a Task that the local sidecar will refuse after execution
 * start; test/verify need a separately approved isolated test runner. */
const ONE_SHOT_ROLES = new Set(["design", "implement", "review", "investigate"]);
export const amuxV22OneShotRoleSupported = (role: string) =>
  ONE_SHOT_ROLES.has(role);
export const amuxV22OneShotRouteSupported = (provider: string, modelId: string) =>
  provider.toLowerCase() === "anthropic" &&
  /^claude-[A-Za-z0-9._-]{1,120}$/.test(modelId);

export const amuxV22WorkerClaimEnabled = (value: string | undefined) =>
  AMUX_V22_WORKER_CLAIM_CODE_LATCH && value === "enabled";

export function amuxV22ClaimCapacity(input: {
  lane: AmuxV22ClaimLane;
  verifiedWorkerCount: number;
  totalAssigned: number;
  laneAssigned: number;
}) {
  const { lane, verifiedWorkerCount, totalAssigned, laneAssigned } = input;
  if (![verifiedWorkerCount, totalAssigned, laneAssigned].every(
    (value) => Number.isSafeInteger(value) && value >= 0) ||
    verifiedWorkerCount === 0) return { allowed: false as const,
      reason: "capacity_unconfigured" as const };
  if (totalAssigned >= Math.min(AMUX_V22_GLOBAL_ACTIVE_LIMIT,
      verifiedWorkerCount)) return { allowed: false as const,
    reason: "global_capacity_full" as const };
  // One normal, one parallel, one owner-declared SEV1. In particular a normal
  // job never borrows a reserved slot from a lane that has no ready card.
  if (laneAssigned >= 1) return { allowed: false as const,
    reason: "lane_capacity_full" as const };
  if (lane === "normal" && verifiedWorkerCount < 3) {
    return { allowed: false as const,
      reason: "reserved_capacity_unavailable" as const };
  }
  return { allowed: true as const, reason: null };
}

export type AmuxV22EligibleRoute = {
  routeId: string;
  workerName: string;
  provider: string;
  modelId: string;
  routePolicyDigest: string;
  perAttemptMicroUsd: string;
};

/** Review cannot use the implementing worker. A distinct provider wins when
 * one is actually available; price then identity break ties deterministically. */
export function chooseAmuxV22WorkerRoute(input: {
  routes: readonly AmuxV22EligibleRoute[];
  priorAuthorWorkers: readonly string[];
  priorAuthorProviders: readonly string[];
  isReview: boolean;
}) {
  const candidates = input.routes.filter((route) =>
    !input.isReview || !input.priorAuthorWorkers.includes(route.workerName));
  candidates.sort((left, right) => {
    const leftPrior = input.isReview &&
      input.priorAuthorProviders.includes(left.provider) ? 1 : 0;
    const rightPrior = input.isReview &&
      input.priorAuthorProviders.includes(right.provider) ? 1 : 0;
    if (leftPrior !== rightPrior) return leftPrior - rightPrior;
    const price = BigInt(left.perAttemptMicroUsd) -
      BigInt(right.perAttemptMicroUsd);
    if (price !== BigInt(0)) return price < 0 ? -1 : 1;
    const worker = left.workerName.localeCompare(right.workerName);
    return worker || left.routeId.localeCompare(right.routeId);
  });
  return candidates[0] ?? null;
}
