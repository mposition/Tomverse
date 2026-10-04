// The pure half of scripts/seal-risk-accepted-cohort.mjs: which accounts a seal
// at `approvedAt` covers, and the digest of that exact scope.
//
// Contract: docs/policy/email-product-news-redesign-draft.md section 5.6 -- the
// (userId, address digest) list, not its size, is the approval's scope. Kept
// apart so tests/sealRiskAcceptedCohort.test.mjs can pin it without a database.
import { createHash } from "node:crypto";

/** Covered: an address and a signup date at or before `approvedAt`. */
export const coveredAt = (account, approvedAt) =>
  Boolean(account.email) &&
  Boolean(account.createdAt) &&
  account.createdAt.getTime() <= approvedAt.getTime();

/**
 * SHA-256 of the scope a seal writes: approvedAt, the purpose, the address
 * normalisation version and every (userId, address digest) pair, sorted by
 * userId so the order the database returns rows in does not matter.
 */
export const cohortDigest = ({ approvedAt, purposeKey, addressNormalizationVersion, members }) => {
  const pairs = members
    .map((member) => [member.userId, member.addressDigest])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256")
    .update(
      JSON.stringify({
        approvedAt: approvedAt.toISOString(),
        purposeKey,
        addressNormalizationVersion,
        members: pairs,
      })
    )
    .digest("hex");
};
