import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { emailAddressDigest } from "@/lib/emailAddressDigest";
import {
  EMAIL_ADDRESS_NORMALIZATION_VERSION,
  normalizeEmailAddress,
} from "@/lib/emailSuppressionCore";
import {
  approvalScopeRefusal,
  cohortMismatchReason,
  type CohortMismatchReason,
} from "@/lib/emailPermissionLedgerCore";
import {
  sealRefusal,
  type ApprovalCohortMember,
} from "@/lib/emailSendApprovalCohortCore";

/**
 * Sealing a `risk_accepted` approval around an exact list of accounts, and
 * reading that list back.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, section 5.6.
 *
 * The owner's decision of 2026-09-16 covers the existing accounts -- described
 * as 78 of them -- and the description is not the scope. This module turns it
 * into a list that a send can be compared against, and then closes it.
 *
 * ## Why the address is stored as a digest
 *
 * The member rows exist to answer one question at send time: is this the same
 * mailbox the approval was about. A digest answers it. Keeping the addresses
 * themselves would mean a second copy of every approved account's email
 * address in a table whose whole purpose is to be permanent, and the data
 * domain registry would have to record it as one.
 */

/**
 * The digest a member row stores and a send compares against.
 *
 * Re-exported rather than defined here so that the cohort and the in-product
 * notice cannot drift apart on how an address becomes a digest.
 */
export const approvalAddressDigest = emailAddressDigest;

export type CohortCandidate = {
  userId: string;
  emailAddress: string;
  /** When they signed up: what the two-year notice counts from (rule 5). */
  signupAt: Date;
};

/**
 * Create the approval, pin its membership and seal it, in one transaction.
 *
 * One transaction because a half-written cohort is worse than none: the
 * approval would look given, and the accounts whose member rows had not landed
 * yet would be quietly outside it with nothing saying so.
 *
 * The seal is what makes the row an approval at all. Before it, the row is a
 * draft being assembled; the database refuses to let a sealed row change, and
 * refuses a withdrawal against an unsealed one.
 *
 * ## The caller does not choose when it was sealed
 *
 * `approvedAt` is a historical fact -- the day the owner decided -- and comes
 * from the caller. The seal is not: it is this transaction, and it is taken
 * from the row's own `createdAt` rather than from any clock this process can
 * read.
 *
 * The constraint is `sealedAt >= approvedAt AND sealedAt >= createdAt`, and
 * `createdAt` defaults to the transaction's start on the database's clock. A
 * caller passing the decision date fails it, and so does a caller passing
 * `new Date()` taken a moment before the transaction opened -- which is the
 * obvious way to write it. Using the row's own timestamp makes both impossible
 * rather than making them somebody's job to remember.
 */
export const sealRiskAcceptedApproval = async (input: {
  approvedById: string;
  approvedByEmail: string;
  approvedAt: Date;
  reason: string;
  reviewCondition: string;
  policyVersionId: string;
  /** The purpose covered, or "*" for every one of them. */
  purposeKey: string;
  candidates: readonly CohortCandidate[];
  client?: Prisma.TransactionClient;
}) => {
  const members: ApprovalCohortMember[] = input.candidates.map((candidate) => ({
    userId: candidate.userId,
    addressDigest: approvalAddressDigest(candidate.emailAddress),
    addressNormalizationVersion: EMAIL_ADDRESS_NORMALIZATION_VERSION,
  }));

  // Everything that does not need the row yet, so a malformed cohort costs no
  // transaction. The seal time is checked again below, once the row exists and
  // can say when it was created.
  const shapeRefusal = sealRefusal({
    alreadySealed: false,
    reason: input.reason,
    reviewCondition: input.reviewCondition,
    members,
    approvedAt: input.approvedAt,
    sealedAt: input.approvedAt,
  });
  if (shapeRefusal) {
    throw new Error(`A risk_accepted approval cannot be sealed: ${shapeRefusal}.`);
  }

  const run = async (tx: Prisma.TransactionClient) => {
    const approval = await tx.emailSendApproval.create({
      data: {
        approvalType: "risk_accepted",
        approvedById: input.approvedById,
        approvedByEmail: normalizeEmailAddress(input.approvedByEmail),
        approvedAt: input.approvedAt,
        reason: input.reason,
        reviewCondition: input.reviewCondition,
        policyVersionId: input.policyVersionId,
        purposeKey: input.purposeKey,
      },
    });

    await tx.emailSendApprovalMember.createMany({
      data: input.candidates.map((candidate, index) => ({
        approvalId: approval.id,
        userId: candidate.userId,
        addressDigest: members[index]!.addressDigest,
        addressNormalizationVersion: EMAIL_ADDRESS_NORMALIZATION_VERSION,
        // Rule 5: the signup date is deemed the date the two-year
        // confirmation notice counts from. Deemed rather than known, which is
        // why the source says so rather than leaving a bare date behind.
        noticeAnchorAt: candidate.signupAt,
        noticeAnchorSource: "signup_date_deemed",
      })),
    });

    // The row's own creation instant, on the database's clock. An approval
    // dated in the future would fail the constraint here; refusing it by name
    // first means the operator reads why rather than a CHECK violation.
    const sealedAt = approval.createdAt;
    const refusal = sealRefusal({
      alreadySealed: approval.sealedAt !== null,
      reason: approval.reason,
      reviewCondition: approval.reviewCondition,
      members,
      approvedAt: input.approvedAt,
      sealedAt,
    });
    if (refusal) {
      throw new Error(`A risk_accepted approval cannot be sealed: ${refusal}.`);
    }

    return tx.emailSendApproval.update({
      where: { id: approval.id },
      data: { sealedAt },
    });
  };

  return input.client ? run(input.client) : prisma.$transaction(run);
};

export type CohortStanding =
  | { inCohort: true; approvalId: string }
  | { inCohort: false; reason: CohortMismatchReason | string };

/**
 * Whether this delivery is inside the sealed cohort, and why not when it is
 * not.
 *
 * Both digests are recomputed here rather than trusted from the caller: the
 * point of the check is that the address has not moved, and an address the
 * caller hands us is one it already decided about.
 *
 * The approval is checked before the membership, because being a member of a
 * withdrawn approval is not a weaker form of being covered -- it is not being
 * covered. Section 5.6's rule 6: withdrawing adds an
 * `EmailSendApprovalRevocation` and later verdicts are taken without the
 * override. Reading membership alone would keep sending to the same 78
 * addresses after the decision had been reversed, and the admin screen's
 * "revoked" would sit next to a send that ignored it.
 */
export const cohortStanding = async (input: {
  approvalId: string;
  userId: string | null;
  /** The address the delivery was pinned to at enqueue. */
  deliveryEmailAddress: string | null;
  /**
   * The purpose and policy version this send is being judged under.
   *
   * Required, and checked against the approval's own scope. An approval
   * sealed for one purpose does not cover another, and one given under an
   * earlier policy version does not carry forward -- section 7.6. Leaving
   * them out was how a newsletter approval came to answer "covered" for a
   * promotions send.
   */
  purpose: string;
  policyVersionId: string;
  client?: Prisma.TransactionClient;
}): Promise<CohortStanding> => {
  const db = input.client ?? prisma;

  // The approval is read last, and that ordering is the whole guarantee.
  //
  // It cannot be one statement. A nested relation read is a single Prisma call
  // but two SQL statements unless the `relationJoins` preview feature is on,
  // and this schema does not enable it -- so under READ COMMITTED, which takes
  // a fresh snapshot per statement, an `include` buys nothing here. Claiming
  // one instant in a comment would have been worse than the gap it described.
  //
  // What makes the order sufficient is that the two facts age differently. A
  // sealed approval's membership is immutable: the database refuses to change
  // a member row or add one after the seal. So a membership read taken a
  // moment ago is as true as one taken now, and the only row that can have
  // moved underneath us is the approval itself -- which is therefore the one
  // read last. A withdrawal committed before that read is seen.
  //
  // A withdrawal committed after it is not, and no single read could see it.
  // That is what section 7.6 is for: permission is decided again immediately
  // before the provider call rather than carried from enqueue.
  const member = input.userId
    ? await db.emailSendApprovalMember.findUnique({
        where: {
          approvalId_userId: {
            approvalId: input.approvalId,
            userId: input.userId,
          },
        },
        select: {
          userId: true,
          addressDigest: true,
          addressNormalizationVersion: true,
        },
      })
    : null;

  const user = input.userId
    ? await db.user.findUnique({
        where: { id: input.userId },
        select: { email: true },
      })
    : null;

  const approval = await db.emailSendApproval.findUnique({
    where: { id: input.approvalId },
    select: {
      approvalType: true,
      sealedAt: true,
      policyVersionId: true,
      ruleKey: true,
      ruleVersion: true,
      country: true,
      obligationKey: true,
      purposeKey: true,
      _count: { select: { revocations: true } },
    },
  });

  // The approval is judged before the account: being a member of a withdrawn
  // or out-of-scope approval is not a weaker form of being covered, and
  // answering "no account" about one names the wrong fact.
  if (!approval) return { inCohort: false, reason: "no_approval" };
  const scope = approvalScopeRefusal(
    {
      approvalType: approval.approvalType as "risk_accepted" | "obligation_waiver",
      sealedAt: approval.sealedAt,
      revoked: approval._count.revocations > 0,
      policyVersionId: approval.policyVersionId,
      ruleKey: approval.ruleKey,
      ruleVersion: approval.ruleVersion,
      country: approval.country,
      obligationKey: approval.obligationKey,
      purposeKey: approval.purposeKey,
    },
    {
      approvalType: "risk_accepted",
      policyVersionId: input.policyVersionId,
      purpose: input.purpose,
    }
  );
  if (scope) return { inCohort: false, reason: scope };

  if (!input.userId) {
    return { inCohort: false, reason: "no_account" };
  }

  const reason = cohortMismatchReason({
    member,
    userId: input.userId,
    deliveryAddressDigest: input.deliveryEmailAddress
      ? approvalAddressDigest(input.deliveryEmailAddress)
      : null,
    currentAddressDigest: user?.email
      ? approvalAddressDigest(user.email)
      : null,
    addressNormalizationVersion: EMAIL_ADDRESS_NORMALIZATION_VERSION,
  });

  return reason === null
    ? { inCohort: true, approvalId: input.approvalId }
    : { inCohort: false, reason };
};

/**
 * What the admin screen shows about an approval.
 *
 * Section 5.6, rule 3: it is visible, in full, because hiding it is how the
 * next person reads a decision to send without a basis as though it were
 * consent. So the reason and the review condition come back with the counts
 * rather than only the counts.
 */
export const riskAcceptedApprovalSummary = async (input: {
  approvalId: string;
  client?: Prisma.TransactionClient;
}) => {
  const db = input.client ?? prisma;
  // An obligation waiver has no membership, so summarising one produces a
  // cohort of nobody -- which on a screen headed "who this covers" reads as a
  // decision that covers nobody rather than as the wrong kind of row.
  const approval = await db.emailSendApproval.findUnique({
    where: { id: input.approvalId },
    select: {
      id: true,
      approvalType: true,
      approvedByEmail: true,
      approvedAt: true,
      sealedAt: true,
      reason: true,
      reviewCondition: true,
      purposeKey: true,
      policyVersionId: true,
      _count: { select: { members: true, revocations: true } },
    },
  });
  if (!approval || approval.approvalType !== "risk_accepted") return null;

  return {
    ...approval,
    memberCount: approval._count.members,
    // A withdrawn approval is still a row, and the screen says so rather than
    // showing nothing: the sends it authorised already happened.
    revoked: approval._count.revocations > 0,
  };
};
