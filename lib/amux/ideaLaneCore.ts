/**
 * The idea lane (owner decision 2026-11-02): an owner idea goes straight to
 * one GitHub Actions job (.github/workflows/amux-idea-lane.yml) that runs a
 * Claude Code session on develop and opens a draft PR. No execution approval,
 * plan approval or recovery proof: a failed or vanished run is simply tried
 * again, and the irreversible boundaries are kept by
 * - the attempt limits below (per idea, and per day for spending),
 * - the PR being a draft that a person reviews and merges.
 *
 * Pure: the service (ideaLaneService.ts) reads the attempts, this decides.
 */

export const AMUX_IDEA_LANE_ENV = "AMUX_IDEA_LANE_ENABLED";
export const AMUX_IDEA_LANE_SECRET_ENV = "AMUX_IDEA_LANE_SYNC_SECRET";
export const AMUX_IDEA_LANE_DAILY_ENV = "AMUX_IDEA_LANE_MAX_ATTEMPTS_PER_DAY";
/** Runs one idea may use before the lane gives up on it. */
export const AMUX_IDEA_LANE_MAX_ATTEMPTS = 3;
export const AMUX_IDEA_LANE_DEFAULT_DAILY_ATTEMPTS = 10;
/** Longer than the workflow job's 90-minute timeout, so a live run never looks dead. */
export const AMUX_IDEA_LANE_LEASE_MS = 100 * 60_000;
/** What a finished run may report besides an opened PR (the table's CHECK holds the same words). */
export const AMUX_IDEA_LANE_FAILURES = ["no_change", "cli_failed", "workflow_edit", "secret_in_diff",
  "push_failed", "job_failed"] as const;
export type AmuxIdeaLaneFailure = typeof AMUX_IDEA_LANE_FAILURES[number];

export const amuxIdeaLaneEnabled = (env: NodeJS.ProcessEnv = process.env) => env[AMUX_IDEA_LANE_ENV] === "true";

export function amuxIdeaLaneDailyAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env[AMUX_IDEA_LANE_DAILY_ENV] ?? "");
  return Number.isSafeInteger(value) && value >= 1 && value <= 100 ? value : AMUX_IDEA_LANE_DEFAULT_DAILY_ATTEMPTS;
}

export type AmuxIdeaLaneAttemptFact = {
  claimedAtMs: number; leaseUntilMs: number; outcome: string | null; prNumber: number | null;
};

export type AmuxIdeaLaneState = {
  /** running: a run holds its lease; queued: the next claim retries it; failed: out of attempts. */
  state: "running" | "queued" | "pr_open" | "failed";
  attempts: number;
  prNumber: number | null;
  /** The newest run's outcome, lease_expired for one that never reported, null while it runs. */
  lastOutcome: string | null;
};

export function amuxIdeaLaneState(attempts: readonly AmuxIdeaLaneAttemptFact[], nowMs: number): AmuxIdeaLaneState | null {
  if (attempts.length === 0) return null;
  const newest = attempts.reduce((last, item) => item.claimedAtMs > last.claimedAtMs ? item : last);
  const live = (item: AmuxIdeaLaneAttemptFact) => item.outcome === null && item.leaseUntilMs > nowMs;
  const lastOutcome = newest.outcome ?? (live(newest) ? null : "lease_expired");
  const opened = attempts.filter((item) => item.outcome === "pr_open")
    .reduce<AmuxIdeaLaneAttemptFact | null>((last, item) => !last || item.claimedAtMs > last.claimedAtMs ? item : last, null);
  const base = { attempts: attempts.length, lastOutcome };
  if (opened) return { ...base, state: "pr_open", prNumber: opened.prNumber };
  if (attempts.some(live)) return { ...base, state: "running", prNumber: null };
  return { ...base, state: attempts.length >= AMUX_IDEA_LANE_MAX_ATTEMPTS ? "failed" : "queued", prNumber: null };
}

export const amuxIdeaLaneClaimable = (state: AmuxIdeaLaneState | null) => state === null || state.state === "queued";

/** The public branch a run pushes: the attempt id only, never idea text. */
export const amuxIdeaLaneBranch = (attemptId: string) => `amux-idea/${attemptId}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type AmuxIdeaLaneResult = { attemptId: string; outcome: "pr_open" | AmuxIdeaLaneFailure; prNumber: number | null };

/** A result body as the workflow sends it, or null when it is not one. */
export function inspectAmuxIdeaLaneResult(body: unknown): AmuxIdeaLaneResult | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { attemptId, outcome, prNumber, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof attemptId !== "string" || !UUID.test(attemptId)) return null;
  if (outcome === "pr_open") {
    return Number.isSafeInteger(prNumber) && (prNumber as number) > 0 && (prNumber as number) < 10_000_000
      ? { attemptId, outcome, prNumber: prNumber as number } : null;
  }
  if (prNumber !== undefined && prNumber !== null) return null;
  return (AMUX_IDEA_LANE_FAILURES as readonly unknown[]).includes(outcome)
    ? { attemptId, outcome: outcome as AmuxIdeaLaneFailure, prNumber: null } : null;
}
