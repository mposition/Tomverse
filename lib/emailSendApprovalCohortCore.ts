/**
 * Who a `risk_accepted` approval actually covers, and what it cannot cross.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, sections 5.6,
 * 6 and 7.6.
 *
 * ## The approval is a decision, not a permission
 *
 * The owner decided on 2026-09-16 to send to the 78 existing accounts with no
 * legal basis in any jurisdiction, and to record that as what it is: a
 * business decision taken because detection is unlikely, not because a rule
 * allows it. `risk_accepted` is the name for having written that down.
 *
 * So the verdict a send produces still says `legalAllowed: false`. The
 * override sits beside it rather than replacing it, and the admin screen shows
 * both -- because a screen that showed only the outcome would read, to the
 * next person, as though these accounts had consented.
 *
 * ## "78" is the description; the list is the scope
 *
 * A count cannot be compared against at send time, and an approval scoped by a
 * count would silently grow every time somebody signed up. So the approval
 * pins the exact accounts, each as a `userId` and a digest of the normalised
 * address at approval time, and it is sealed: after that nothing about it
 * moves, in the database as well as here.
 *
 * ## What is here and what is not
 *
 * Comparing a subject against the sealed membership is
 * `cohortMismatchReason()` in `lib/emailPermissionLedgerCore.ts`, and it stays
 * there: it was written with the ledger's closed lists and a second copy of
 * the same three-digest comparison is how the admin screen and the send come
 * to disagree about who is in the cohort.
 *
 * This file holds the two things that module does not: what an override cannot
 * cross whoever approved it, and whether a membership may be sealed at all.
 *
 * Pure and dependency-free. Digests are computed by the server module that
 * owns `node:crypto`.
 */

import { profileForCountry } from "./emailJurisdictionCore";
import type { CohortQuery } from "./emailPermissionLedgerCore";

/** A member row as the seal check sees it. */
export type ApprovalCohortMember = NonNullable<CohortQuery["member"]>;

/**
 * What an override cannot cross, whoever approved it.
 *
 * Section 5.6's second table. The left column -- an absent basis -- is exactly
 * what `risk_accepted` exists to step over. The right column is not a stronger
 * version of the same thing; each entry is a different kind of fact, and none
 * of them is about whether we have a legal basis:
 *
 * `objected` and a withdrawal are the recipient's own decision, and an
 * approval that crossed one would be the TAB failure -- continuing to send
 * down a channel somebody refused.
 *
 * A suppression is a delivery fact, and it comes at three scopes, not two.
 * Purpose and global are the obvious ones. The third is the classification,
 * and leaving it out had a specific consequence: section 7.4 writes a
 * `marketing` classification suppression when a deletion request is accepted,
 * and it says why in the same breath -- withdrawing consent alone does not
 * stop a `risk_accepted` send, so the suppression is what does. With only two
 * booleans the deletion request mapped to neither and this function answered
 * "no blockers", so the address of somebody who had asked to be deleted would
 * have been mailed under the override.
 *
 * An undetermined country is refused for a reason that is easy to get
 * backwards: it is not that the country might forbid the send, but that we
 * cannot work out which display duties attach to it. Korea's `(광고)` prefix
 * and Singapore's `<ADV>` are decided by the rule, and a message that cannot
 * be told what to put in its own subject line is not a message we can build.
 *
 * Which is why the test is the *profile*, not the string `ZZ`. It was `ZZ`,
 * and `JP` and `XX` are two-letter codes with no reviewed profile that sailed
 * through it -- so an override ran on an account whose display duties had
 * never been worked out, which is the one thing this entry exists to stop.
 * `profileForCountry()` answers `ZZ` for an unknown country, an unreviewed
 * one, and a blank, so it covers all three at once.
 *
 * A rule with an obligation whose status nobody has decided (section 7.8) is
 * the same shape of gap, one level down.
 *
 * And a person who has been shown the in-product notice has been told, in
 * writing, that we have not sent product news and will not unless asked. From
 * then on the override cannot apply to them, whatever else is true -- because
 * `notice_shown` is written once per account and cannot be withdrawn, and an
 * override after it turns that row into a permanent record of a broken
 * promise. The case that makes this more than theoretical: a cohort member
 * moves off the approved address, falls out of the override, is shown the
 * notice and dismisses it; then moves back, and the three digests match again.
 * Nothing about the membership has changed. The promise has.
 *
 * The kill switch, the send flag and readiness are not here: they are not
 * properties of this recipient, they are checked before any of this, and
 * folding them in would let a reader think an approval could be weighed
 * against them.
 */
export type OverrideBlocker =
  | "objected"
  | "consent_withdrawn"
  | "suppressed_purpose"
  | "suppressed_classification"
  | "suppressed_globally"
  | "country_undetermined"
  | "obligation_undecided"
  | "promised_no_unrequested_send";

export type OverrideInput = {
  hasObjected: boolean;
  consentWithdrawn: boolean;
  suppressedForPurpose: boolean;
  /** Section 7.4's deletion-request suppression arrives at this scope. */
  suppressedForClassification: boolean;
  suppressedGlobally: boolean;
  country: string;
  obligationsDecided: boolean;
  /** A `notice_shown` exists for this account (the in-product notice). */
  shownNoUnrequestedSendPromise: boolean;
};

/**
 * Every reason this override does not apply, not just the first.
 *
 * A list rather than one answer because this is what the admin screen shows
 * and what the verdict stores. Fixing a suppression only to be refused again
 * for an undetermined country, one round trip at a time, is how an operator
 * comes to believe the system is broken.
 */
export const overrideBlockers = (input: OverrideInput): OverrideBlocker[] => {
  const blockers: OverrideBlocker[] = [];
  if (input.hasObjected) blockers.push("objected");
  if (input.consentWithdrawn) blockers.push("consent_withdrawn");
  if (input.suppressedForPurpose) blockers.push("suppressed_purpose");
  if (input.suppressedForClassification) {
    blockers.push("suppressed_classification");
  }
  if (input.suppressedGlobally) blockers.push("suppressed_globally");
  if (profileForCountry(input.country) === "ZZ") {
    blockers.push("country_undetermined");
  }
  if (!input.obligationsDecided) blockers.push("obligation_undecided");
  if (input.shownNoUnrequestedSendPromise) {
    blockers.push("promised_no_unrequested_send");
  }
  return blockers;
};

/**
 * Whether consent has made the override unnecessary (section 5.6, rule 4).
 *
 * Not a blocker and not an optimisation. A person who consents through the
 * in-product notice or the preference centre stands on `express_consent`, the
 * verdict becomes `legalAllowed: true`, and the override is simply not
 * consulted. Recording it anyway would leave a permanent row saying we sent
 * without a basis to somebody who had given us one.
 */
export const overrideNeeded = (legalAllowed: boolean): boolean => !legalAllowed;

export type SealRefusal =
  | "already_sealed"
  | "no_reason"
  | "no_review_condition"
  | "no_members"
  | "duplicate_user"
  | "mixed_normalization_versions"
  | "seals_before_approval";

/**
 * Whether this approval may be sealed with this membership.
 *
 * The database enforces that a sealed row never changes and that the seal does
 * not precede the approval. This adds what the database cannot see in one
 * statement: that the membership is internally coherent before it becomes
 * permanent.
 *
 * `no_members` is refused rather than allowed as an empty scope. An approval
 * covering nobody is indistinguishable from one whose member writes failed,
 * and sealing it makes that ambiguity permanent.
 *
 * `mixed_normalization_versions` is refused because a cohort built under two
 * rules cannot be compared under either; the mismatch would surface later, at
 * send time, as individual members mysteriously dropping out.
 *
 * The reason and the review condition are required to be words. The schema
 * accepts an empty string for both, and once sealed neither can be corrected,
 * so an approval could exist permanently without saying why it was given or
 * what would make us look again -- the pair section 5.6 is built around. A
 * screen would refuse an empty box; this is also reachable from a script.
 */
export const sealRefusal = (input: {
  alreadySealed: boolean;
  reason: string;
  reviewCondition: string;
  members: readonly ApprovalCohortMember[];
  approvedAt: Date;
  sealedAt: Date;
}): SealRefusal | null => {
  if (input.alreadySealed) return "already_sealed";
  if (input.reason.trim().length === 0) return "no_reason";
  if (input.reviewCondition.trim().length === 0) return "no_review_condition";
  if (input.members.length === 0) return "no_members";

  const seen = new Set<string>();
  for (const member of input.members) {
    if (seen.has(member.userId)) return "duplicate_user";
    seen.add(member.userId);
  }

  const versions = new Set(
    input.members.map((member) => member.addressNormalizationVersion)
  );
  if (versions.size > 1) return "mixed_normalization_versions";

  if (input.sealedAt.getTime() < input.approvedAt.getTime()) {
    return "seals_before_approval";
  }
  return null;
};

/**
 * Why an approval does not authorise anything, whoever is in its cohort.
 *
 * There is no such function here, and that is the point. It was
 * `approvalStandingRefusal()`, which looked at the seal and the withdrawal --
 * and `approvalScopeRefusal()` in `lib/emailPermissionLedgerCore.ts` already
 * looked at those two plus the type, the policy version and the purpose.
 *
 * Having both meant the send used the narrower one, so an approval sealed for
 * `purposeKey: "newsletter"` answered "covered" for a promotions send: a
 * decision taken about one kind of mail silently covered every other kind.
 * Section 7.6 requires the scope to match, and a second function that checks
 * two of the five fields is not a smaller version of that -- it is a way to
 * skip three.
 */
