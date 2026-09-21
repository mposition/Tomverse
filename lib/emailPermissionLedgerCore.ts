/**
 * The closed lists the permission ledger stores, and the derivations that have
 * to hold for a row to mean what it says.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, sections 5.6, 6,
 * 7.6 and 7.8.
 *
 * Pure and dependency-free. Every list here is also a database CHECK, and
 * `npm run check:enum-constraints` compares the two on every run: a value the
 * database allows and this file does not know is a write the application would
 * answer 500 for.
 */

import {
  EMAIL_CLASSIFICATIONS,
  type EmailClassification,
} from "./emailPurposeClassification";

/**
 * The facts a basis can rest on, other than a consent.
 *
 * `basis_ended` is separate from `relationship_ended` because a basis can end
 * without the relationship doing so -- a country rule changing under an
 * account is not the same event as that account leaving, and a reader
 * reconstructing why we stopped sending needs to tell them apart.
 */
export const EMAIL_PERMISSION_EVENT_KINDS = [
  "notice_shown",
  "objected",
  "relationship_started",
  "relationship_ended",
  "basis_ended",
] as const;

export type EmailPermissionEventKind =
  (typeof EMAIL_PERMISSION_EVENT_KINDS)[number];

/**
 * Where a permission fact was captured.
 *
 * `system` is for a fact we derived rather than observed -- a relationship
 * ending because a subscription lapsed, for instance. It is deliberately not a
 * catch-all: a fact somebody typed belongs to `admin`, and one the person
 * performed belongs to the screen they performed it on.
 */
export const EMAIL_PERMISSION_EVENT_CAPTURE_SOURCES = [
  "signup_form",
  "preference_center",
  "unsubscribe_page",
  "in_product_notice",
  "admin",
  "system",
  "provider_complaint",
] as const;

export type EmailPermissionEventCapture =
  (typeof EMAIL_PERMISSION_EVENT_CAPTURE_SOURCES)[number];

/**
 * The two kinds of human decision, which are not variants of one thing.
 *
 * `risk_accepted` sends without a basis; `obligation_waiver` declines to
 * perform a display or notice duty. They have different scopes, are checked at
 * different points and are refused for different reasons, and merging them
 * would mean one set of scope columns that is half null whichever kind it is.
 */
export const EMAIL_SEND_APPROVAL_TYPES = [
  "risk_accepted",
  "obligation_waiver",
] as const;

export type EmailSendApprovalType = (typeof EMAIL_SEND_APPROVAL_TYPES)[number];

/**
 * The two moments a verdict is taken (draft section 7.6).
 *
 * Rendering is pinned at enqueue; permission is decided again immediately
 * before the provider call. One row cannot describe both, so there are two.
 */
export const EMAIL_PERMISSION_DECISION_PHASES = ["enqueue", "send"] as const;

export type EmailPermissionDecisionPhase =
  (typeof EMAIL_PERMISSION_DECISION_PHASES)[number];

/**
 * Overrides a verdict may record.
 *
 * One value, and the list exists so that adding a second is a decision rather
 * than a string appearing in a call site. `obligation_waiver` is deliberately
 * absent: a waiver changes what a country rule requires, so it is consumed
 * while the obligations are resolved and never appears as the reason a
 * recipient was allowed.
 */
export const EMAIL_PERMISSION_DECISION_OVERRIDE_TYPES = [
  "risk_accepted",
] as const;

export type EmailPermissionDecisionOverrideType =
  (typeof EMAIL_PERMISSION_DECISION_OVERRIDE_TYPES)[number];

/** Re-exported so the constraint registry has one module to name. */
export { EMAIL_CLASSIFICATIONS };
export type { EmailClassification };

/**
 * Whether a verdict's `allowed` follows from the rest of it.
 *
 * The database computes the same expression as a CHECK. Both exist because
 * they fail differently: this one stops a caller building the row, and the
 * constraint stops a row that got built anyway. Neither is the other's test.
 *
 * `overrideApplied` is not `legalAllowed`'s equal. It enters only this
 * expression; the authorities' verdict is recorded as it was.
 */
export const decisionAllowed = (input: {
  legalAllowed: boolean;
  overrideApplied: boolean;
  blockers: readonly unknown[];
}): boolean =>
  (input.legalAllowed || input.overrideApplied) && input.blockers.length === 0;

/**
 * Why a sealed approval does not apply to this send, or null when it does.
 *
 * Every scope member is compared exactly and a mismatch on any one of them is
 * a refusal (draft section 7.8). The order below is not a precedence: each
 * condition is checked, and the first failure is named because a caller needs
 * one reason, not because the others were skipped.
 */
export type ApprovalScopeInput = {
  approvalType: EmailSendApprovalType;
  sealedAt: Date | null;
  revoked: boolean;
  policyVersionId: string | null;
  ruleKey: string | null;
  ruleVersion: number | null;
  country: string | null;
  obligationKey: string | null;
  purposeKey: string | null;
};

export type ApprovalScopeQuery = {
  approvalType: EmailSendApprovalType;
  policyVersionId: string | null;
  ruleKey?: string | null;
  ruleVersion?: number | null;
  country?: string | null;
  obligationKey?: string | null;
  purpose?: string | null;
};

export const approvalScopeRefusal = (
  approval: ApprovalScopeInput,
  query: ApprovalScopeQuery
): string | null => {
  if (approval.sealedAt === null) return "approval_not_sealed";
  if (approval.revoked) return "approval_revoked";
  if (approval.approvalType !== query.approvalType) return "approval_type_mismatch";
  if (approval.policyVersionId !== query.policyVersionId) {
    return "approval_policy_version_mismatch";
  }

  if (approval.approvalType === "obligation_waiver") {
    if (approval.ruleKey !== (query.ruleKey ?? null)) return "approval_rule_mismatch";
    if (approval.ruleVersion !== (query.ruleVersion ?? null)) {
      return "approval_rule_version_mismatch";
    }
    if (approval.country !== (query.country ?? null)) return "approval_country_mismatch";
    if (approval.obligationKey !== (query.obligationKey ?? null)) {
      return "approval_obligation_mismatch";
    }
    return null;
  }

  // risk_accepted. "*" covers every purpose; anything else is exact.
  if (approval.purposeKey !== "*" && approval.purposeKey !== (query.purpose ?? null)) {
    return "approval_purpose_mismatch";
  }
  return null;
};

/**
 * Whether an account is inside a `risk_accepted` approval's cohort.
 *
 * Three digests have to agree with the member row: the account, the address
 * pinned on the delivery at enqueue, and the account's address right now
 * (draft section 5.6). Changing the address after enqueue takes the delivery
 * out of scope even though it still carries the approved address, which is the
 * point -- the approval was for a mailbox somebody has since stopped using.
 */
export const cohortRefusal = (input: {
  member: { userId: string; addressDigest: string } | null;
  userId: string | null;
  deliveryAddressDigest: string | null;
  currentAddressDigest: string | null;
}): string | null => {
  if (input.userId === null) return "approval_member_mismatch";
  if (input.member === null) return "approval_member_mismatch";
  if (input.member.userId !== input.userId) return "approval_member_mismatch";
  if (input.deliveryAddressDigest === null) return "approval_member_mismatch";
  if (input.currentAddressDigest === null) return "approval_member_mismatch";
  if (input.member.addressDigest !== input.deliveryAddressDigest) {
    return "approval_member_mismatch";
  }
  if (input.member.addressDigest !== input.currentAddressDigest) {
    return "approval_member_mismatch";
  }
  return null;
};
