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
/**
 * The workflow's implement (150 min) and publish (10 min) timeouts plus an hour
 * for queueing between jobs. A run still going past it may overlap a retry; the
 * worst case is a second draft PR for the idea, which a person closes.
 * (Raised from 80 min of implement on 2026-11-04: a real idea timed out.)
 */
export const AMUX_IDEA_LANE_LEASE_MS = 220 * 60_000;
/**
 * The publish fence (ideaLaneService.ts) keeps a run's lease at least this far
 * ahead, longer than the publish job's 10-minute timeout: the owner cannot
 * close the idea between the fence and the push.
 */
export const AMUX_IDEA_LANE_PUBLISH_FENCE_MS = 15 * 60_000;
/** What a finished run may report besides an opened PR (the table's CHECK holds the same words). */
export const AMUX_IDEA_LANE_FAILURES = ["no_change", "cli_failed", "workflow_edit", "binary_change", "secret_in_diff",
  "push_failed", "job_failed"] as const;
export type AmuxIdeaLaneFailure = typeof AMUX_IDEA_LANE_FAILURES[number];

export const amuxIdeaLaneEnabled = (env: NodeJS.ProcessEnv = process.env) => env[AMUX_IDEA_LANE_ENV] === "true";

export function amuxIdeaLaneDailyAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env[AMUX_IDEA_LANE_DAILY_ENV] ?? "");
  return Number.isSafeInteger(value) && value >= 1 && value <= 100 ? value : AMUX_IDEA_LANE_DEFAULT_DAILY_ATTEMPTS;
}

export type AmuxIdeaLaneAttemptFact = {
  claimedAtMs: number; leaseUntilMs: number; outcome: string | null; prNumber: number | null;
  /** Set once the PR observer saw the draft PR merged, or closed unmerged. */
  mergedAtMs?: number | null;
  prClosedAtMs?: number | null;
  /** The run did one part of a larger idea; its PR names the remaining work. */
  continues?: boolean;
};

export type AmuxIdeaLaneState = {
  /**
   * running: a run holds its lease; queued: the next claim retries it; failed: out of attempts;
   * merged / pr_closed: its PR merged, or was closed without a merge.
   */
  state: "running" | "queued" | "pr_open" | "merged" | "pr_closed" | "failed";
  /** Runs of the current part (each part has its own attempt limit). */
  attempts: number;
  prNumber: number | null;
  /** The newest run's outcome, lease_expired for one that never reported, null while it runs. */
  lastOutcome: string | null;
  /** Which part of the idea this is: 1, or more once a part that continues has merged. */
  part: number;
  /** pr_open: the open PR did one part and names the remaining work for the next. */
  continues: boolean;
  /** The merged PR of the part before this one, whose body names this part's work; null for part 1. */
  previousPrNumber: number | null;
};

/** A merged run that did one part and named more: the next part starts after it. */
const isPartBoundary = (item: AmuxIdeaLaneAttemptFact) =>
  item.outcome === "pr_open" && item.continues === true && !!item.mergedAtMs;

export function amuxIdeaLaneState(attempts: readonly AmuxIdeaLaneAttemptFact[], nowMs: number): AmuxIdeaLaneState | null {
  if (attempts.length === 0) return null;
  // A larger idea runs in parts, one PR each, a part only after the one before
  // it merged. Everything before the newest merged part is settled history.
  const boundaries = attempts.filter(isPartBoundary);
  const boundary = boundaries.reduce<AmuxIdeaLaneAttemptFact | null>((last, item) =>
    !last || item.claimedAtMs > last.claimedAtMs ? item : last, null);
  const current = boundary ? attempts.filter((item) => item.claimedAtMs > boundary.claimedAtMs) : attempts;
  const partBase = { part: boundaries.length + 1, previousPrNumber: boundary?.prNumber ?? null, continues: false };
  if (current.length === 0) {
    return { ...partBase, state: "queued", attempts: 0, prNumber: null, lastOutcome: null };
  }
  const newest = current.reduce((last, item) => item.claimedAtMs > last.claimedAtMs ? item : last);
  const live = (item: AmuxIdeaLaneAttemptFact) => item.outcome === null && item.leaseUntilMs > nowMs;
  const lastOutcome = newest.outcome ?? (live(newest) ? null : "lease_expired");
  const opened = current.filter((item) => item.outcome === "pr_open")
    .reduce<AmuxIdeaLaneAttemptFact | null>((last, item) => !last || item.claimedAtMs > last.claimedAtMs ? item : last, null);
  const base = { ...partBase, attempts: current.length, lastOutcome };
  // A retry's second PR may be left open; the one that merged settles the part.
  const merged = current.filter((item) => item.outcome === "pr_open" && item.mergedAtMs)
    .reduce<AmuxIdeaLaneAttemptFact | null>((first, item) => !first || item.mergedAtMs! < first.mergedAtMs! ? item : first, null);
  if (merged) return { ...base, state: "merged", prNumber: merged.prNumber };
  if (opened) {
    return { ...base, state: opened.prClosedAtMs ? "pr_closed" : "pr_open", prNumber: opened.prNumber,
      continues: opened.continues === true };
  }
  if (current.some(live)) return { ...base, state: "running", prNumber: null };
  return { ...base, state: current.length >= AMUX_IDEA_LANE_MAX_ATTEMPTS ? "failed" : "queued", prNumber: null };
}

export const amuxIdeaLaneClaimable = (state: AmuxIdeaLaneState | null) => state === null || state.state === "queued";

/** What the claim's candidate query (ideaLaneService.ts) filters an idea on. */
export type AmuxIdeaLaneCandidateFacts = {
  submissionOrigin: "owner" | "session"; state: string; cancelled: boolean;
  /** The raw text is kept: rawPurgedAt is null and the ciphertext, its key and digest are set. */
  rawReadable: boolean;
  analysisDeadlineMs: number;
  /** currentSourcePlanRevisionId is set. */
  sourcePlan: boolean;
  chunks: number;
};

/**
 * The lane state the Ideas list shows. An idea the lane has not run yet is
 * queued while the lane is on and its claim would take the idea: it waits for
 * the lane's turn, not for an execution approval it never needs. The attempt
 * conditions of the claim hold trivially with no attempts.
 */
export function amuxIdeaLaneView(attempts: readonly AmuxIdeaLaneAttemptFact[], nowMs: number,
  candidate: AmuxIdeaLaneCandidateFacts, enabled: boolean): AmuxIdeaLaneState | null {
  const state = amuxIdeaLaneState(attempts, nowMs);
  if (state || !enabled) return state;
  const takes = candidate.submissionOrigin === "owner" && candidate.state === "submitted" && !candidate.cancelled &&
    candidate.rawReadable && candidate.analysisDeadlineMs > nowMs && !candidate.sourcePlan && candidate.chunks === 0;
  return takes ? { state: "queued", attempts: 0, prNumber: null, lastOutcome: null, part: 1,
    continues: false, previousPrNumber: null } : null;
}

/** The public branch a run pushes: the attempt id only, never idea text. */
export const amuxIdeaLaneBranch = (attemptId: string) => `amux-idea/${attemptId}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The attempt id of a fence request, or null. */
export function inspectAmuxIdeaLaneFence(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { attemptId, ...rest } = body as Record<string, unknown>;
  return Object.keys(rest).length === 0 && typeof attemptId === "string" && UUID.test(attemptId) ? attemptId : null;
}

export type AmuxIdeaLaneResult = {
  attemptId: string; outcome: "pr_open" | AmuxIdeaLaneFailure; prNumber: number | null;
  /** pr_open only: the run did one part and its PR names the remaining work. */
  continues?: boolean;
};

/** A result body as the workflow sends it, or null when it is not one. */
export function inspectAmuxIdeaLaneResult(body: unknown): AmuxIdeaLaneResult | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { attemptId, outcome, prNumber, continues, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof attemptId !== "string" || !UUID.test(attemptId)) return null;
  if (continues !== undefined && typeof continues !== "boolean") return null;
  if (outcome === "pr_open") {
    return Number.isSafeInteger(prNumber) && (prNumber as number) > 0 && (prNumber as number) < 10_000_000
      ? { attemptId, outcome, prNumber: prNumber as number, continues: continues === true } : null;
  }
  if (continues === true) return null;
  if (prNumber !== undefined && prNumber !== null) return null;
  return (AMUX_IDEA_LANE_FAILURES as readonly unknown[]).includes(outcome)
    ? { attemptId, outcome: outcome as AmuxIdeaLaneFailure, prNumber: null } : null;
}
