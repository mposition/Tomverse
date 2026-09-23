import "server-only";

import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  EMAIL_ADDRESS_NORMALIZATION_VERSION,
  normalizeEmailAddress,
} from "@/lib/emailSuppressionCore";
import {
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
 * Normalised first, always through the same function the suppression list
 * uses. Digesting an un-normalised address would make `Someone@example.com`
 * and `someone@example.com` two different members, and only one of them would
 * ever match.
 */
export const approvalAddressDigest = (emailAddress: string): string =>
  createHash("sha256")
    .update(normalizeEmailAddress(emailAddress))
    .digest("hex");

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
 */
export const sealRiskAcceptedApproval = async (input: {
  approvedById: string;
  approvedByEmail: string;
  approvedAt: Date;
  sealedAt: Date;
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

  const refusal = sealRefusal({
    alreadySealed: false,
    members,
    approvedAt: input.approvedAt,
    sealedAt: input.sealedAt,
  });
  if (refusal) {
    throw new Error(`A risk_accepted approval cannot be sealed: ${refusal}.`);
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

    return tx.emailSendApproval.update({
      where: { id: approval.id },
      data: { sealedAt: input.sealedAt },
    });
  };

  return input.client ? run(input.client) : prisma.$transaction(run);
};

export type CohortStanding =
  | { inCohort: true; approvalId: string }
  | { inCohort: false; reason: CohortMismatchReason };

/**
 * Whether this delivery is inside the sealed cohort, and why not when it is
 * not.
 *
 * Both digests are recomputed here rather than trusted from the caller: the
 * point of the check is that the address has not moved, and an address the
 * caller hands us is one it already decided about.
 */
export const cohortStanding = async (input: {
  approvalId: string;
  userId: string | null;
  /** The address the delivery was pinned to at enqueue. */
  deliveryEmailAddress: string | null;
  client?: Prisma.TransactionClient;
}): Promise<CohortStanding> => {
  const db = input.client ?? prisma;

  if (!input.userId) {
    return { inCohort: false, reason: "no_account" };
  }

  const [member, user] = await Promise.all([
    db.emailSendApprovalMember.findUnique({
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
    }),
    db.user.findUnique({
      where: { id: input.userId },
      select: { email: true },
    }),
  ]);

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
  if (!approval) return null;

  return {
    ...approval,
    memberCount: approval._count.members,
    // A withdrawn approval is still a row, and the screen says so rather than
    // showing nothing: the sends it authorised already happened.
    revoked: approval._count.revocations > 0,
  };
};
