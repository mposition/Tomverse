/** Owner request 2026-11-15: bounded retries of known pre-publication failures. */
export const DAILY_PRODUCT_AGENT_RETRY_SWITCH = "DAILY_PRODUCT_AGENT_RETRIES_ENABLED";
export const DAILY_PRODUCT_AGENT_MAX_ATTEMPTS = 3;
export const DAILY_PRODUCT_AGENT_RETRY_DELAY_MS = 24 * 60 * 60_000;

export function automaticDailyRetry(entry: {
  status: string; reason?: string; at: string; finishedAt?: string; leaseUntil?: string;
  attempts?: number; claimId?: string; prUrl?: string; amuxIdeaId?: string;
} | null | undefined, now: number, enabled: boolean): boolean {
  if (!enabled || entry?.status !== "failed" || !["tests", "no_change"].includes(entry.reason ?? "")) return false;
  if (!entry.claimId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(entry.claimId)) return false;
  if (entry.prUrl || entry.amuxIdeaId) return false;
  const attempts = entry.attempts ?? 1;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts >= DAILY_PRODUCT_AGENT_MAX_ATTEMPTS) return false;
  // Legacy Scout records have no completion time. Waiting past their lease is conservative.
  const last = Date.parse(entry.finishedAt ?? entry.leaseUntil ?? entry.at);
  return Number.isFinite(last) && now - last >= DAILY_PRODUCT_AGENT_RETRY_DELAY_MS;
}

export function dailyRetryInstruction(attempts: number, reason?: string): string {
  return attempts > 1
    ? `\nRetry attempt ${attempts}${attempts <= DAILY_PRODUCT_AGENT_MAX_ATTEMPTS ? `/${DAILY_PRODUCT_AGENT_MAX_ATTEMPTS}` : " (owner requested)"}; prior pre-publication outcome: ${reason ?? "owner_retry"}. Verify the blocker on current develop first. If already solved, cite the commit and tests; if blocked by scope or missing facts, report the exact blocker. Do not manufacture a change or weaken a test.\n`
    : "";
}
