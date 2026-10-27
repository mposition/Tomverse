/**
 * The CI auto-fix as CI admission shows it (owner, 2026-10-27: "a failed or
 * conflicting pull request should be analysed and fixed"). The fixing runs on
 * the AMUX review server (tools/review-orchestrator/lib/ci-fix.mjs, the
 * Claude CLI on its subscription) and is published by
 * .github/workflows/pr-ci-auto-fix.yml; this module only reads the server's
 * status report (lib/reviewOrchestratorStatusCore.ts) and says, per pull
 * request in the line, what became of the try on its current head.
 *
 * The operator's "Analyse again" puts CI_FIX_AGAIN_LABEL on the pull
 * request; the server tries that head once more, and the admission round
 * takes the label off once the report shows the retry. Pure.
 */
// Types only: the Admin screen imports this module, and the status core holds node:crypto.
import type { ReviewStatusSnapshot, StoredReviewStatus } from "./reviewOrchestratorStatusCore.ts";

/** tools/review-orchestrator/lib/ci-fix.mjs CI_FIX_AGAIN_LABEL. */
export const CI_FIX_AGAIN_LABEL = "ci:fix-again";

type ReportEntry = NonNullable<ReviewStatusSnapshot["ciFix"]>["entries"][number];

export type CiFixTry = {
  head: string;
  kind: ReportEntry["kind"];
  outcome: ReportEntry["outcome"];
  reason: ReportEntry["reason"];
  retried: boolean;
  /** When the server recorded it, by the app's receipt clock less its age. */
  at: string;
};

export type CiFixView = {
  /** A report arrived within the status core's stale window. */
  connected: boolean;
  receivedAt: string | null;
  /** Null when the server keeps no auto-fix ledger (or none was read). */
  queuedLastHour: number | null;
  /** The Claude CLI's account quota as the server last read it: a pass needs 30%. */
  claude: { state: string; remainingPercent: number | null } | null;
  /** The newest try per pull request number. */
  byPull: Record<number, CiFixTry>;
};

export const emptyCiFixView = (): CiFixView => ({ connected: false, receivedAt: null, queuedLastHour: null, claude: null, byPull: {} });

/** `staleAfterMs` is REVIEW_ORCHESTRATOR_STALE_AFTER_MS, passed in by the server side. */
export function ciFixView(stored: StoredReviewStatus | null, nowMs: number, staleAfterMs: number): CiFixView {
  if (!stored || stored.state !== "observed") return emptyCiFixView();
  const receivedMs = Date.parse(stored.receivedAt);
  const quota = stored.snapshot.providers.find((provider) => provider.id === "claude")?.quota;
  const byPull: Record<number, CiFixTry> = {};
  // Newest first: the first entry per pull request is its latest try.
  for (const entry of stored.snapshot.ciFix?.entries ?? []) {
    if (byPull[entry.pr]) continue;
    byPull[entry.pr] = {
      head: entry.head,
      kind: entry.kind,
      outcome: entry.outcome,
      reason: entry.reason,
      retried: entry.retried,
      at: new Date(receivedMs - entry.ageSeconds * 1000).toISOString(),
    };
  }
  return {
    connected: Number.isFinite(receivedMs) && nowMs - receivedMs <= staleAfterMs,
    receivedAt: stored.receivedAt,
    queuedLastHour: stored.snapshot.ciFix?.queuedLastHour ?? null,
    claude: quota ? { state: quota.state, remainingPercent: quota.unit === "percent" ? quota.remaining : null } : null,
    byPull,
  };
}

/**
 * What the screen says about a pull request's auto-fix, or null for nothing:
 * - analysing: the model works on the current head;
 * - sent: a fix is on its way to the workflow, which re-checks and pushes it;
 * - pushed: the server saw the fix's own commit become the head -- CI runs
 *   on it (a head moved by anything else says nothing here);
 * - not_fixed: the model changed nothing (its result code says why);
 * - failed: the model run failed or timed out;
 * - refused: the fix broke a rule here (a secret, a binary) or did not fit;
 * - exhausted: two auto-fix commits already, no more tries.
 * A try on an older head says nothing unless it was the fix that moved it.
 */
export type CiFixState = "analysing" | "sent" | "pushed" | "not_fixed" | "failed" | "refused" | "exhausted";

export function ciFixState(fix: CiFixTry | undefined, headSha: string): CiFixState | null {
  if (!fix) return null;
  if (fix.head !== headSha) return fix.outcome === "pushed" ? "pushed" : null;
  switch (fix.outcome) {
    case "started":
      return "analysing";
    case "queued":
      return "sent";
    case "no_change":
      return "not_fixed";
    case "model_failed":
    case "model_timeout":
    case "error":
    case "unknown":
      return "failed";
    case "patch_refused":
    case "patch_too_large":
      return "refused";
    case "attempts_exhausted":
      return "exhausted";
    case "pushed":
    case "superseded":
      // Settled only once the head moved: not this head's state.
      return null;
  }
}

/** Whether "Analyse again" can help: the current head was tried, not fixed, and not retried yet. */
export function ciFixRetryable(fix: CiFixTry | undefined, headSha: string): boolean {
  const state = ciFixState(fix, headSha);
  return fix !== undefined && !fix.retried && (state === "not_fixed" || state === "failed" || state === "refused");
}

/**
 * Open pull requests whose "try again" label has done its work: the report
 * shows the retry started on their current head. Only that confirmation
 * takes a label off -- a report that is missing, unread or lacks the entry
 * says nothing, and the operator's request stays. A label left on from an
 * earlier head is harmless: the server acts only on one put on after the
 * head's try, and "Analyse again" puts it on afresh.
 */
export function ciFixLabelsToClear(
  pulls: readonly { number: number; headSha: string; labels?: readonly string[] }[],
  view: CiFixView,
): number[] {
  return pulls
    .filter((pull) => (pull.labels ?? []).includes(CI_FIX_AGAIN_LABEL))
    .filter((pull) => {
      const fix = view.byPull[pull.number];
      return fix !== undefined && fix.head === pull.headSha && fix.retried;
    })
    .map((pull) => pull.number);
}
