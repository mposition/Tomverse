/** The review server is a signal for v4 Tasks, not a PR approval. */
export const AMUX_V52_REVIEW_VERDICTS = ["accept", "reject", "unknown"] as const;
export type AmuxV52ReviewVerdict = (typeof AMUX_V52_REVIEW_VERDICTS)[number];

// The scope travels inside one SSH command argument to the review server (131,072 bytes
// per argument on Linux, base64url-expanded by a third), so its bound is the transport's,
// not a policy one: 20,000 characters are at most 60,000 bytes (owner decision 2026-11-15
// lifted the old 8,192; the review server's own cut is gone).
export const AMUX_V52_REVIEW_SCOPE_MAX_CHARS = 20_000;

export function formatAmuxV52ReviewScope(title: string,
  completionCriteria: string[]): string {
  const scope = `Title: ${title}\nCompletion criteria:\n` +
    completionCriteria.map((item) => `- ${item}`).join("\n");
  if (scope.length > AMUX_V52_REVIEW_SCOPE_MAX_CHARS)
    throw new Error("v52 review scope exceeds server limit");
  return scope;
}

export type AmuxV52ReviewEvidence = {
  jobId: string | null;
  baseSha: string;
  commitSha: string;
  verdict: AmuxV52ReviewVerdict;
  authorVendor: string;
  reviewerVendors: string[];
  touchesContract: boolean;
};

const SHA = /^[0-9a-f]{40}$/;
const JOB_ID = /^r-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/;
const VENDOR = /^[a-z][a-z0-9-]{0,63}$/;

/** A request failure has no reliable job id and must be blocked, never resent. */
export function validAmuxV52ReviewEvidence(value: AmuxV52ReviewEvidence) {
  if (!SHA.test(value.baseSha) || !SHA.test(value.commitSha) ||
      value.baseSha === value.commitSha ||
      !AMUX_V52_REVIEW_VERDICTS.includes(value.verdict) ||
      !VENDOR.test(value.authorVendor) ||
      !Array.isArray(value.reviewerVendors) ||
      value.reviewerVendors.length > 4 ||
      value.reviewerVendors.some((vendor) => !VENDOR.test(vendor) ||
        vendor === value.authorVendor) ||
      new Set(value.reviewerVendors).size !== value.reviewerVendors.length ||
      typeof value.touchesContract !== "boolean") return false;
  if (value.verdict === "unknown")
    return value.jobId === null || JOB_ID.test(value.jobId);
  return !!value.jobId && JOB_ID.test(value.jobId) &&
    value.reviewerVendors.length >= (value.touchesContract ? 2 : 1);
}

export const AMUX_V52_REVIEW_REJECTED_TWICE_REASON =
  "review_server_rejected_twice";

/**
 * Owner decision 2026-11-14 (AMUX process audit bundle 2, AMUXFLOW/B2): a
 * review is an internal signal and merging has its own gate, so a rejection
 * returns the Task to `todo` with the findings attached to the next run; the
 * attempt budget (lib/amux/executionBudgetCore.ts) bounds the runs and a spent
 * budget blocks the Task for the owner queue and the Decision Maker.
 *
 * Owner decision 2026-11-15 (an internal development flow has no reason for a
 * fixed limit): this is now on by default; TOMVERSE_AMUX_V52_REJECT_RETRY_IN_BUDGET
 * set to `disabled` brings back the old rule (a second rejection blocks).
 * Neither a second rejection nor an `unknown` review blocks a Task by count: an
 * unknown review runs again (the next run is reviewed anew), and a rejection
 * goes to a person or the Decision Maker, with the reason, only when the same
 * reviewer rejects for the same blocking finding again.
 */
export const AMUX_V52_REJECT_RETRY_IN_BUDGET_ENV = "TOMVERSE_AMUX_V52_REJECT_RETRY_IN_BUDGET";
export const amuxV52RejectRetryInBudgetEnabled = (
  value: string | undefined = process.env[AMUX_V52_REJECT_RETRY_IN_BUDGET_ENV],
) => value?.trim() !== "disabled";

/**
 * Owner decision 2026-11-15: when the same reviewer vendor rejected a Task's
 * two newest reviews, the next review prefers another vendor. The delivery
 * names the vendors to avoid in `review_avoid_vendors`, a field only a
 * bridge built after this change reads (its profile refuses unknown fields),
 * so it is sent only when TOMVERSE_AMUX_V52_REVIEW_AVOID_VENDORS is exactly
 * `enabled`, which the operator sets once the bridge and the review launcher
 * are deployed. Default off.
 */
export const AMUX_V52_REVIEW_AVOID_VENDORS_ENV = "TOMVERSE_AMUX_V52_REVIEW_AVOID_VENDORS";
export const amuxV52ReviewAvoidVendorsEnabled = (
  value: string | undefined = process.env[AMUX_V52_REVIEW_AVOID_VENDORS_ENV],
) => value?.trim() === "enabled";

/** A first rejection returns to the same grade; a second needs a person.
 * `priorRejections` counts the Task's other rejected attempts since the
 * owner last retried a twice-rejected run (lib/amux/execution.ts), so an
 * owner retry gets one automatic return again rather than blocking on its
 * first rejection. */
export function decideAmuxV52ReviewDisposition(
  verdict: AmuxV52ReviewVerdict, priorRejections: number,
  rejectRetryInBudget: boolean = amuxV52RejectRetryInBudgetEnabled(),
  /** The rejection repeats the previous one (same reviewer, same blocking finding). */
  repeatedFinding: boolean = false,
): { status: "review" | "todo" | "blocked"; reason: string } {
  if (!Number.isSafeInteger(priorRejections) || priorRejections < 0)
    return { status: "blocked", reason: "review_history_unavailable" };
  if (verdict === "accept")
    return { status: "review", reason: "review_server_accepted" };
  // The same finding rejected again: running the Task again would repeat it, so a
  // person or the Decision Maker decides (the count since an owner retry decides
  // whether there is an earlier rejection at all).
  if (verdict === "reject" && repeatedFinding && priorRejections > 0)
    return { status: "blocked", reason: AMUX_V52_REVIEW_REJECTED_TWICE_REASON };
  if (verdict === "reject" && (priorRejections === 0 || rejectRetryInBudget))
    return { status: "todo", reason: "review_server_rejected" };
  if (verdict === "reject")
    return { status: "blocked", reason: AMUX_V52_REVIEW_REJECTED_TWICE_REASON };
  // An unknown review is asked for again by running the Task again: the next
  // run is submitted to the review server anew.
  if (verdict === "unknown" && rejectRetryInBudget)
    return { status: "todo", reason: "review_server_unknown" };
  return { status: "blocked", reason: "review_server_unknown" };
}
