/** The review server is a signal for v4 Tasks, not a PR approval. */
export type AmuxV52ReviewVerdict = "accept" | "reject" | "unknown";

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
      !["accept", "reject", "unknown"].includes(value.verdict) ||
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

/** A first rejection returns to the same grade; a second needs a person. */
export function decideAmuxV52ReviewDisposition(
  verdict: AmuxV52ReviewVerdict, priorRejections: number,
): { status: "review" | "todo" | "blocked"; reason: string } {
  if (!Number.isSafeInteger(priorRejections) || priorRejections < 0)
    return { status: "blocked", reason: "review_history_unavailable" };
  if (verdict === "accept")
    return { status: "review", reason: "review_server_accepted" };
  if (verdict === "reject" && priorRejections === 0)
    return { status: "todo", reason: "review_server_rejected" };
  if (verdict === "reject")
    return { status: "blocked", reason: "review_server_rejected_twice" };
  return { status: "blocked", reason: "review_server_unknown" };
}
