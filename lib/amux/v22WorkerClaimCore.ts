/** Assignment is deliberately distinct from execution start. The role/grade
 * and route facts come from owner-approved receipts, never model prose. */
/**
 * Tasks held by workers at once, across every lane: one per verified worker
 * and no other bound (owner direction 2026-11-15, "제한을 줄 이유가
 * 없습니다"; it was at most six from 2026-11-13). The lane only orders the
 * candidates (SEV1 first). Each attempt still reserves its own approved cost
 * and the daily caps still apply.
 */
export const AMUX_V22_PER_WORKER_ACTIVE_LIMIT = 1;
export const AMUX_V22_CLAIM_LANES = ["normal", "parallel", "sev1"] as const;
export type AmuxV22ClaimLane = (typeof AMUX_V22_CLAIM_LANES)[number];
const ROLE_TOOL: Record<string, string> = {
  design: "repo_read", implement: "repo_write", test: "test_run",
  review: "repo_read", verify: "test_run", investigate: "repo_read",
  operate: "operations",
};
export const amuxV22RequiredTool = (role: string) => ROLE_TOOL[role] ?? null;

/** The environment-gated A15 one-shot path only has these capabilities.
 * Do not claim a Task that the local sidecar will refuse after execution
 * start. A worker profile names these roles only. */
const ONE_SHOT_ROLES = new Set(["design", "implement", "review", "investigate"]);
export const amuxV22OneShotRoleSupported = (role: string) =>
  ONE_SHOT_ROLES.has(role);

/** Owner decision 2026-10-30: a test Task runs as an implement execution (it
 * writes tests; the pull request's CI runs them) and a verify Task as an
 * investigate execution (read-only). Running tests inside the worker still
 * needs a separately approved isolated test runner, so the sidecar sees only
 * the four roles above. operate stays a person's step. */
const EXECUTION_ROLE: Readonly<Record<string, string>> = Object.freeze({
  test: "implement", verify: "investigate",
});
export const amuxV22ExecutionRole = (taskRole: string) =>
  Object.hasOwn(EXECUTION_ROLE, taskRole) ? EXECUTION_ROLE[taskRole]! : taskRole;
export const amuxV22TaskRoleSupported = (taskRole: string) =>
  amuxV22OneShotRoleSupported(amuxV22ExecutionRole(taskRole));
/** A Task whose run leaves a patch to publish: implement, and test. */
export const amuxV22TaskWritesPatch = (taskRole: string | null | undefined) =>
  typeof taskRole === "string" && amuxV22ExecutionRole(taskRole) === "implement";

/**
 * The one-shot providers, keyed by the v19 CLI channel names (owner decision
 * 2026-10-26: every registered provider class may run v22 Tasks). Claude is
 * always on, and so are the others (the multi-provider switch is gone,
 * 2026-11-16). Every route is priced from
 * Admin › Models by its model ID, so a model missing there holds the route.
 * Cursor's print mode cannot be kept from its shell once it may write, so a
 * Cursor worker takes the read roles only (`implement: false`): Cursor
 * 2026.11.05 also runs `miniSweAgentBashArgs` execs as a fixed `/bin/sh -c`
 * with the CLI's own environment, which no PATH jail reaches.
 */
// The CLI usage receipt's model grammar has no colon, so neither does a route.
const ANY_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
export const AMUX_V22_PROVIDERS = Object.freeze({
  anthropic: Object.freeze({ providerClass: "claude", cli: "claude",
    model: /^claude-[A-Za-z0-9._-]{1,120}$/, implement: true }),
  openai: Object.freeze({ providerClass: "codex", cli: "codex",
    model: ANY_MODEL, implement: true }),
  "github-copilot": Object.freeze({ providerClass: "copilot", cli: "copilot",
    model: ANY_MODEL, implement: true }),
  cursor: Object.freeze({ providerClass: "cursor", cli: "cursor",
    model: ANY_MODEL, implement: false }),
  // Owner decision 2026-11-10: Antigravity implements. Its shell is found on
  // PATH (agy 1.5.4, measured on the box), so the sidecar's jail holds it.
  antigravity: Object.freeze({ providerClass: "antigravity", cli: "antigravity",
    model: ANY_MODEL, implement: true }),
  // Owner request 2026-11-28: Kimi Code CLI takes the read roles only. Its
  // print mode approves every tool call, its file tools read any absolute
  // path, and its Shell tool runs without a sandbox, so no jail holds it once
  // it may write (v22ChannelRun.mjs).
  kimi: Object.freeze({ providerClass: "kimi", cli: "kimi",
    model: ANY_MODEL, implement: false }),
});
export type AmuxV22Provider = keyof typeof AMUX_V22_PROVIDERS;
export const amuxV22Provider = (provider: string): AmuxV22Provider | null => {
  const key = provider.toLowerCase();
  return Object.hasOwn(AMUX_V22_PROVIDERS, key) ? key as AmuxV22Provider : null;
};
export const amuxV22ProviderForClass = (providerClass: string): AmuxV22Provider | null =>
  (Object.keys(AMUX_V22_PROVIDERS) as AmuxV22Provider[]).find((provider) =>
    AMUX_V22_PROVIDERS[provider].providerClass === providerClass) ?? null;
/** Whether this provider's one-shot run may take this role. */
export const amuxV22ProviderRoleSupported = (provider: string, role: string) => {
  const known = amuxV22Provider(provider);
  return known !== null && amuxV22OneShotRoleSupported(role) &&
    (role !== "implement" || AMUX_V22_PROVIDERS[known].implement);
};
/**
 * The vendor the review server keeps away from a v22 change: the vendor of
 * the model that wrote it, not the CLI it ran in. Antigravity runs Google's,
 * Anthropic's and OpenAI's models through one CLI (agy 1.5.4 lists Gemini 4,
 * Claude Opus/Sonnet 5.5 and GPT-OSS), so its model ID decides; a model ID
 * that names no known vendor is "unknown", which the review server refuses
 * rather than pair with a reviewer it cannot show to differ (owner decision
 * 2026-11-20: Antigravity workers on Hydrogen and Opus as well as Argon).
 * Every other provider keeps its provider name, as before.
 */
export function amuxV22ReviewAuthorVendor(provider: string, modelId: string): string {
  if (amuxV22Provider(provider) !== "antigravity") return provider;
  if (modelId.startsWith("gemini-")) return "google";
  if (modelId.startsWith("claude-")) return "anthropic";
  if (modelId.startsWith("gpt-")) return "openai";
  return "unknown";
}
export const amuxV22OneShotRouteSupported = (provider: string, modelId: string) => {
  const known = amuxV22Provider(provider);
  return known !== null && AMUX_V22_PROVIDERS[known].model.test(modelId);
};

/**
 * Whether one more Task may be assigned now. Until 2026-11-13 each lane
 * (normal, parallel, SEV1) held one Task, so nearly every Task, being normal,
 * waited for the one before it and the other workers stayed idle. Since
 * 2026-11-15 the only limit is the verified workers themselves.
 */
export function amuxV22ClaimCapacity(input: {
  verifiedWorkerCount: number;
  totalAssigned: number;
}) {
  const { verifiedWorkerCount, totalAssigned } = input;
  if (![verifiedWorkerCount, totalAssigned].every(
    (value) => Number.isSafeInteger(value) && value >= 0) ||
    verifiedWorkerCount === 0) return { allowed: false as const,
      reason: "capacity_unconfigured" as const };
  if (totalAssigned >= verifiedWorkerCount) return { allowed: false as const,
    reason: "global_capacity_full" as const };
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
 * one is actually available. Then the provider running the fewest Tasks now
 * wins (owner decision 2026-11-13: the workers are flat-rate CLI
 * subscriptions, so the cheapest list price alone sent every Task to one
 * provider while the others sat idle); price then identity break ties
 * deterministically. */
export function chooseAmuxV22WorkerRoute(input: {
  routes: readonly AmuxV22EligibleRoute[];
  priorAuthorWorkers: readonly string[];
  priorAuthorProviders: readonly string[];
  isReview: boolean;
  /** Tasks each provider's workers hold now, keyed by lowercase provider. */
  activeByProvider?: ReadonlyMap<string, number>;
  /** When each worker was last assigned a Task, in ms; a worker never assigned is absent. */
  lastAssignedAtByWorker?: ReadonlyMap<string, number>;
  /**
   * When each provider (lowercase) was last assigned a Task by ANY of its
   * workers, candidates or not: a provider whose worker is busy on the Task it
   * just took has not waited. Absent, it is read from the candidates alone.
   */
  lastAssignedAtByProvider?: ReadonlyMap<string, number>;
  /** A paid API run (the read-only recovery retry): the cheapest route first. */
  preferLowerPrice?: boolean;
  /**
   * The workers, and their providers, that just failed this Task on the
   * platform (lib/amux/infraFailureCore.ts, owner decision 2026-11-15): they
   * go last, so the retry reaches another worker and provider first. They are
   * never excluded; the worker quarantine does that.
   */
  infraFailedWorkers?: readonly string[];
  infraFailedProviders?: readonly string[];
}) {
  const candidates = input.routes.filter((route) =>
    !input.isReview || !input.priorAuthorWorkers.includes(route.workerName));
  const infraWorkers = new Set(input.infraFailedWorkers ?? []);
  const infraProviders = new Set((input.infraFailedProviders ?? []).map((value) => value.toLowerCase()));
  const infraPenalty = (route: AmuxV22EligibleRoute) =>
    infraWorkers.has(route.workerName) ? 2 : infraProviders.has(route.provider.toLowerCase()) ? 1 : 0;
  const active = (provider: string) =>
    input.activeByProvider?.get(provider.toLowerCase()) ?? 0;
  const lastAssigned = (worker: string) => input.lastAssignedAtByWorker?.get(worker) ?? 0;
  // A provider's last assignment is its most recent worker's.
  const providerLast = new Map<string, number>(input.lastAssignedAtByProvider ?? []);
  for (const route of candidates) {
    const key = route.provider.toLowerCase();
    providerLast.set(key, Math.max(providerLast.get(key) ?? 0, lastAssigned(route.workerName)));
  }
  candidates.sort((left, right) => {
    const leftPrior = input.isReview &&
      input.priorAuthorProviders.includes(left.provider) ? 1 : 0;
    const rightPrior = input.isReview &&
      input.priorAuthorProviders.includes(right.provider) ? 1 : 0;
    if (leftPrior !== rightPrior) return leftPrior - rightPrior;
    const infra = infraPenalty(left) - infraPenalty(right);
    if (infra !== 0) return infra;
    const load = active(left.provider) - active(right.provider);
    if (load !== 0) return load;
    if (input.preferLowerPrice === true) {
      const price = BigInt(left.perAttemptMicroUsd) - BigInt(right.perAttemptMicroUsd);
      if (price !== BigInt(0)) return price < 0 ? -1 : 1;
    }
    // Owner decision 2026-11-13: no price competition between the workers.
    // They are flat-rate CLI subscriptions, and the cheapest list price sent
    // nearly every Task to OpenAI although Anthropic and the others serve
    // the same grade. The provider that waited longest takes the next Task,
    // then its worker that waited longest. Price stays the cost ceiling and
    // ledger's measure, never the choice.
    const providerTurn = (providerLast.get(left.provider.toLowerCase()) ?? 0) -
      (providerLast.get(right.provider.toLowerCase()) ?? 0);
    if (providerTurn !== 0) return providerTurn;
    const workerTurn = lastAssigned(left.workerName) - lastAssigned(right.workerName);
    if (workerTurn !== 0) return workerTurn;
    const worker = left.workerName.localeCompare(right.workerName);
    return worker || left.routeId.localeCompare(right.routeId);
  });
  return candidates[0] ?? null;
}

/** A Task resumed after its owner question waits for the worker that asked --
 * busy, offline or out of quota alike -- while the approved routes still name
 * that worker for the Task's current grade. After a grade escalation that
 * worker no longer serves the Task, so every route the claim allows competes
 * and the answer reaches whichever worker takes it. */
export function amuxV22ResumeRoutes<T extends { workerName: string }>(input: {
  resumeWorker: string | null;
  approvedRoutes: readonly { workerName: string }[];
  routes: readonly T[];
  workerServesGrade: (workerName: string) => boolean;
}): readonly T[] {
  const worker = input.resumeWorker;
  if (worker === null || !input.workerServesGrade(worker) ||
      !input.approvedRoutes.some((route) => route.workerName === worker))
    return input.routes;
  return input.routes.filter((route) => route.workerName === worker);
}
