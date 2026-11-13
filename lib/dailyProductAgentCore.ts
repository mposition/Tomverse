import { z } from "zod";

import { RECOMMENDATION_FAILURE_REASONS } from "@/lib/autoRouterRecommendationsCore";

export const DAILY_PRODUCT_AGENT_SWITCH = "DAILY_PRODUCT_AGENT_ENABLED";
export const DAILY_PRODUCT_AGENT_HEADER = "x-autorec-work-mode";
export const DAILY_PRODUCT_AGENT_MODE = "daily-product";
export const DAILY_PRODUCT_AGENT_PREFIX = "auto.dailyProductAgent.";
export const DAILY_PRODUCT_AGENT_CURSOR = `${DAILY_PRODUCT_AGENT_PREFIX}cursor`;
export const DAILY_PRODUCT_AGENT_DAY = `${DAILY_PRODUCT_AGENT_PREFIX}day`;
export const DAILY_PRODUCT_AGENT_TASK_CAP = 24;
/** These outcomes are known to precede any push or PR request. */
const RETRYABLE_FAILURES = ["out_of_scope", "no_change", "tests", "review_reject",
  "agent_error", "timeout", "lease_expired", "setup_failed", "runner_error", "rate_limited"] as const;
export const DAILY_PRODUCT_SOURCES = ["research", "routing", "memory"] as const;
export type DailyProductSource = (typeof DAILY_PRODUCT_SOURCES)[number];
export const scoutAgentId = (id: string) => `scout.${id}`;
export const scoutIdFromAgentId = (id: string): string | null =>
  /^scout\.([a-zA-Z0-9_-]{1,64})$/.exec(id)?.[1] ?? null;
export const dailyProductAgentKey = (id: string) => `${DAILY_PRODUCT_AGENT_PREFIX}${id}`;

export const dailyProductAgentEnabled = (env: Readonly<Record<string, string | undefined>>) =>
  env[DAILY_PRODUCT_AGENT_SWITCH] === "true";

export function sourceOrder(cursor: string | null | undefined): DailyProductSource[] {
  const index = DAILY_PRODUCT_SOURCES.indexOf(cursor as DailyProductSource);
  const start = index < 0 ? 0 : index;
  return [...DAILY_PRODUCT_SOURCES.slice(start), ...DAILY_PRODUCT_SOURCES.slice(0, start)];
}

export function followingSource(source: DailyProductSource): DailyProductSource {
  return DAILY_PRODUCT_SOURCES[(DAILY_PRODUCT_SOURCES.indexOf(source) + 1) % DAILY_PRODUCT_SOURCES.length];
}

const claim = z.object({
  claimId: z.string().uuid(),
  at: z.string().datetime(),
  leaseUntil: z.string().datetime(),
  source: z.enum(DAILY_PRODUCT_SOURCES),
}).strict();

const prUrl = z.string().regex(/^https:\/\/github\.com\/mposition\/Tomverse\/pull\/[1-9][0-9]{0,8}$/);
export const dailyProductResultSchema = z.discriminatedUnion("outcome", [
  z.object({ id: z.string().max(80), claimId: z.string().uuid(), outcome: z.literal("pr_opened"),
    prUrl }).strict(),
  z.object({ id: z.string().max(80), claimId: z.string().uuid(), outcome: z.literal("failed"),
    reason: z.enum(RECOMMENDATION_FAILURE_REASONS) }).strict(),
]);
export type DailyProductResult = z.infer<typeof dailyProductResultSchema>;

const state = z.discriminatedUnion("status", [
  claim.extend({ status: z.literal("claimed") }).strict(),
  claim.extend({ status: z.literal("pr_opened"), prUrl }).strict(),
  claim.extend({ status: z.literal("failed"), reason: z.enum(RECOMMENDATION_FAILURE_REASONS) }).strict(),
  claim.extend({ status: z.literal("retry_ready"), reason: z.enum(RETRYABLE_FAILURES) }).strict(),
]);
export type DailyProductAgentState = z.infer<typeof state>;
export const canRetryDailyProductTask = (current: DailyProductAgentState | null) =>
  current?.status === "failed" && RETRYABLE_FAILURES.some((reason) => reason === current.reason);
export const canHandOffDailyProductTask = (current: DailyProductAgentState | null) =>
  current?.status === "retry_ready" || canRetryDailyProductTask(current);

/** Corrupt state is not an invitation to claim again. Callers also test row existence. */
export function parseDailyProductState(value: string | null | undefined): DailyProductAgentState | null {
  try {
    const parsed = state.safeParse(JSON.parse(value ?? "null"));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export function dailyProductResultDecision(current: DailyProductAgentState | null, result: DailyProductResult) {
  if (!current || current.claimId !== result.claimId) return "not_claimed";
  if (current.status === "claimed") return "record";
  if (current.status === "pr_opened" && result.outcome === "pr_opened" && current.prUrl === result.prUrl) return "replay";
  if (current.status === "failed" && result.outcome === "failed" && current.reason === result.reason) return "replay";
  return "not_claimed";
}

export function dailyProductDisplayState(value: string, now: number) {
  const current = parseDailyProductState(value);
  if (!current || (current.status === "claimed" && Date.parse(current.leaseUntil) <= now)) {
    return { status: "needs_lookup" as const };
  }
  return { status: current.status, retryable: canRetryDailyProductTask(current),
    ...(current.status === "pr_opened" ? { prUrl: current.prUrl } : {}),
    ...(current.status === "failed" ? { reason: current.reason } : {}) };
}
