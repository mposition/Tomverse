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
 * A suppression is a delivery fact, at the purpose scope or globally, and
 * sending anyway means mailing a hard-bounced or complained-about address.
 *
 * An undetermined country (`ZZ`) is refused for a reason that is easy to get
 * backwards: it is not that the country might forbid the send, but that we
 * cannot work out which display duties attach to it. Korea's `(광고)` prefix
 * and Singapore's `<ADV>` are decided by the rule, and a message that cannot
 * be told what to put in its own subject line is not a message we can build.
 *
 * A rule with an obligation whose status nobody has decided (section 7.8) is
 * the same shape of gap, one level down.
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
  | "suppressed_globally"
  | "country_undetermined"
  | "obligation_undecided";

export type OverrideInput = {
  hasObjected: boolean;
  consentWithdrawn: boolean;
  suppressedForPurpose: boolean;
  suppressedGlobally: boolean;
  country: string;
  obligationsDecided: boolean;
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
  if (input.suppressedGlobally) blockers.push("suppressed_globally");
  if (input.country === "ZZ" || input.country.trim().length === 0) {
    blockers.push("country_undetermined");
  }
  if (!input.obligationsDecided) blockers.push("obligation_undecided");
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
 */
export const sealRefusal = (input: {
  alreadySealed: boolean;
  members: readonly ApprovalCohortMember[];
  approvedAt: Date;
  sealedAt: Date;
}): SealRefusal | null => {
  if (input.alreadySealed) return "already_sealed";
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
 * These are facts about the approval rather than about the recipient, and they
 * are checked before membership because membership in a withdrawn approval is
 * not a smaller version of being covered -- it is not being covered.
 *
 * `not_sealed` because a row without a seal is a draft being assembled
 * (section 5.6: the approval exists before the send, and it is the seal that
 * makes it exist). `revoked` because section 5.6's rule 6 says withdrawing an
 * approval adds an `EmailSendApprovalRevocation` event and later verdicts are
 * taken without the override. The sends it already authorised stand; the next
 * one does not.
 */
export type ApprovalStandingRefusal = "not_sealed" | "revoked";

export const approvalStandingRefusal = (input: {
  sealedAt: Date | null;
  revocationCount: number;
}): ApprovalStandingRefusal | null => {
  if (input.sealedAt === null) return "not_sealed";
  if (input.revocationCount > 0) return "revoked";
  return null;
};
