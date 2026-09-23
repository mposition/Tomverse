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

    // The signup dates come from the accounts, not from the caller.
    //
    // Rule 5 deems the signup date the date Korea's two-year confirmation
    // notice counts from, and the member row is sealed a moment later, so a
    // date somebody typed or derived wrongly becomes a statutory reference
    // date that can never be corrected. The addresses are different: a wrong
    // one takes the account out of the cohort at send time and nothing goes
    // out. A wrong anchor sends a notice on the wrong day, silently.
    const accounts = await tx.user.findMany({
      where: { id: { in: input.candidates.map((candidate) => candidate.userId) } },
      select: { id: true, createdAt: true },
    });
    const signupAt = new Map(
      accounts.map((account) => [account.id, account.createdAt])
    );
    const missing = input.candidates
      .map((candidate) => candidate.userId)
      .filter((userId) => !signupAt.has(userId));
    if (missing.length > 0) {
      throw new Error(
        `${missing.length} account(s) named by this approval do not exist.`
      );
    }

    // An account that signed up after the decision is not covered by it.
    //
    // Section 5.6: accounts created after the approval do not enter the cohort
    // by any route -- and sealing is a route. The seal is what makes this
    // permanent: the trigger refuses to remove a member afterwards, so the
    // only way to take one account back out is to withdraw the whole approval
    // and every send it covers with it.
    //
    // The decision was taken about the people who existed when it was taken.
    // Somebody who arrived four days later was not among them, whatever a
    // list handed to this function says.
    // A null signup date is its own refusal, not a crash.
    //
    // `User.createdAt` is nullable, so the map holds the key with no date and
    // the missing-account check above passes. Calling `.getTime()` on it threw
    // inside the transaction -- which rolled the seal back, so no wrong anchor
    // was written, but the message said nothing about what had happened and
    // one such account killed the seal for all the others with it.
    const undated = input.candidates
      .map((candidate) => candidate.userId)
      .filter((userId) => !signupAt.get(userId));
    if (undated.length > 0) {
      throw new Error(
        `${undated.length} account(s) have no signup date, so the two-year notice has no reference date.`
      );
    }

    const tooLate = input.candidates.filter((candidate) => {
      const createdAt = signupAt.get(candidate.userId)!;
      return createdAt.getTime() > input.approvedAt.getTime();
    });
    if (tooLate.length > 0) {
      throw new Error(
        `${tooLate.length} account(s) signed up after this approval was given and cannot be covered by it.`
      );
    }

    await tx.emailSendApprovalMember.createMany({
      data: input.candidates.map((candidate, index) => ({
        approvalId: approval.id,
        userId: candidate.userId,
        addressDigest: members[index]!.addressDigest,
        addressNormalizationVersion: EMAIL_ADDRESS_NORMALIZATION_VERSION,
        // Deemed rather than known, which is why the source says so rather
        // than leaving a bare date behind.
        noticeAnchorAt: signupAt.get(candidate.userId)!,
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

  // Every fact in one statement, in SQL, because ordering could not do it.
  //
  // Prisma cannot: `relationLoadStrategy: "join"` is behind the
  // `relationJoins` preview feature and this schema does not enable it, so a
  // nested relation read is one Prisma call and two SQL statements. Under READ
  // COMMITTED each takes its own snapshot.
  //
  // Ordering the reads instead got closer and still did not arrive. A sealed
  // approval's membership is genuinely immutable -- the trigger at
  // migration.sql line 561 refuses any insert, update or delete on a member row
  // once `sealedAt` is set -- so reading it early is safe. But two of the three
  // facts can move, not one: the approval can be withdrawn, and `User.email`
  // can change, and no ordering makes both of them last. Whichever came second
  // to last left a window, and for the address that window let a delivery go
  // out to a mailbox the account had already left.
  //
  // One SELECT gives all three from one snapshot. It does not make the answer
  // permanent, and nothing could: section 7.6 is why permission is decided
  // again immediately before the provider call rather than carried from
  // enqueue.
  const [row] = await db.$queryRaw<
    {
      approvalType: string;
      sealedAt: Date | null;
      policyVersionId: string | null;
      ruleKey: string | null;
      ruleVersion: number | null;
      country: string | null;
      purposeKey: string | null;
      obligationKey: string | null;
      revocationCount: bigint;
      memberUserId: string | null;
      memberAddressDigest: string | null;
      memberNormalizationVersion: string | null;
      currentEmail: string | null;
    }[]
  >`
    SELECT
      a."approvalType"                   AS "approvalType",
      a."sealedAt"                       AS "sealedAt",
      a."policyVersionId"                AS "policyVersionId",
      a."ruleKey"                        AS "ruleKey",
      a."ruleVersion"                    AS "ruleVersion",
      a."country"                        AS "country",
      a."purposeKey"                     AS "purposeKey",
      a."obligationKey"                  AS "obligationKey",
      (SELECT COUNT(*) FROM "EmailSendApprovalRevocation" r
        WHERE r."approvalId" = a."id")   AS "revocationCount",
      m."userId"                         AS "memberUserId",
      m."addressDigest"                  AS "memberAddressDigest",
      m."addressNormalizationVersion"    AS "memberNormalizationVersion",
      u."email"                          AS "currentEmail"
    FROM "EmailSendApproval" a
    LEFT JOIN "EmailSendApprovalMember" m
      ON m."approvalId" = a."id" AND m."userId" = ${input.userId}
    LEFT JOIN "User" u
      ON u."id" = ${input.userId}
    WHERE a."id" = ${input.approvalId}
  `;

  // The approval is judged before the account: being a member of a withdrawn
  // or out-of-scope approval is not a weaker form of being covered, and
  // answering "no account" about one names the wrong fact.
  if (!row) return { inCohort: false, reason: "no_approval" };
  const scope = approvalScopeRefusal(
    {
      approvalType: row.approvalType as "risk_accepted" | "obligation_waiver",
      sealedAt: row.sealedAt,
      revoked: Number(row.revocationCount) > 0,
      policyVersionId: row.policyVersionId,
      ruleKey: row.ruleKey,
      ruleVersion: row.ruleVersion,
      country: row.country,
      obligationKey: row.obligationKey,
      purposeKey: row.purposeKey,
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

  const member =
    row.memberUserId && row.memberAddressDigest && row.memberNormalizationVersion
      ? {
          userId: row.memberUserId,
          addressDigest: row.memberAddressDigest,
          addressNormalizationVersion: row.memberNormalizationVersion,
        }
      : null;
  const user = row.currentEmail ? { email: row.currentEmail } : null;

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
