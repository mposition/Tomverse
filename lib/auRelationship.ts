import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  EMAIL_ADDRESS_NORMALIZATION_VERSION,
  normalizeEmailAddress,
} from "@/lib/emailSuppressionCore";
import {
  auRelationshipStanding,
  relationshipDisclosedBy,
  relationshipEndedSourceEventKey,
  relationshipStartedSourceEventKey,
  type AuRelationshipStanding,
} from "@/lib/auRelationshipCore";

/**
 * The Australian relationship's two events, and the read the send verdict uses.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 4.4 and
 * lib/auRelationshipCore.ts. Both events go through the append-only permission
 * ledger, scoped to the marketing classification, so a verdict can cite the
 * start as the evidence its inferred consent rests on.
 */

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Records that a relationship started at signup, inside the caller's
 * transaction.
 *
 * Written only when all three hold, and otherwise silently not written: the
 * amendment is in force, the sign-up notice the person saw discloses
 * relationship sending (`relationshipDisclosedBy()`), and the address is the
 * one on the account. Not writing is the safe answer -- the account then simply
 * has no inferred consent.
 */
export async function recordRelationshipStarted(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    emailAddress: string;
    copyVersion: string;
    copyHash: string;
    channel: string;
    amendmentInForce: boolean;
    jurisdiction: string | null;
    jurisdictionSource: string | null;
    occurredAt: Date;
  }
): Promise<{ recorded: boolean; eventId: string | null }> {
  if (!input.amendmentInForce || !relationshipDisclosedBy(input.copyVersion)) {
    return { recorded: false, eventId: null };
  }
  const sourceEventKey = relationshipStartedSourceEventKey(input.userId);
  const existing = await tx.emailPermissionEvent.findUnique({
    where: { kind_sourceEventKey: { kind: "relationship_started", sourceEventKey } },
    select: { id: true },
  });
  if (existing) return { recorded: false, eventId: existing.id };

  // Inside the caller's transaction, so the active version is read rather than
  // bootstrapped: a row pinned to a version that exists only because we wrote
  // the row is not evidence of the policy that applied.
  const policyVersion = await tx.emailPolicyVersion.findFirst({
    where: { status: "active" },
    select: { id: true },
  });
  if (!policyVersion) {
    throw new Error("No email policy version is active; a relationship cannot be recorded.");
  }
  const created = await tx.emailPermissionEvent.create({
    data: {
      userId: input.userId,
      emailAddress: normalizeEmailAddress(input.emailAddress),
      addressNormalizationVersion: EMAIL_ADDRESS_NORMALIZATION_VERSION,
      kind: "relationship_started",
      scopeKey: "marketing",
      occurredAt: input.occurredAt,
      capturedVia: "signup_form",
      sourceEventKey,
      jurisdiction: input.jurisdiction,
      jurisdictionSource: input.jurisdictionSource,
      policyVersionId: policyVersion.id,
      evidence: {
        copyVersion: input.copyVersion,
        copyHash: input.copyHash,
        channel: input.channel,
      },
    },
    select: { id: true },
  });
  return { recorded: true, eventId: created.id };
}

/**
 * Ends the account's relationship, if it has one that has not ended.
 *
 * Called where section 4.4's end events happen -- a deletion request -- in the
 * same transaction as that change. An end is final: nothing restarts it.
 */
export async function recordRelationshipEnded(
  tx: Prisma.TransactionClient,
  input: { userId: string; reason: "account_deletion_requested"; occurredAt: Date }
): Promise<{ recorded: boolean }> {
  const started = await tx.emailPermissionEvent.findUnique({
    where: {
      kind_sourceEventKey: {
        kind: "relationship_started",
        sourceEventKey: relationshipStartedSourceEventKey(input.userId),
      },
    },
    select: {
      id: true,
      emailAddress: true,
      addressNormalizationVersion: true,
      policyVersionId: true,
      jurisdiction: true,
      jurisdictionSource: true,
      occurredAt: true,
    },
  });
  if (!started) return { recorded: false };
  const sourceEventKey = relationshipEndedSourceEventKey(started.id);
  const existing = await tx.emailPermissionEvent.findUnique({
    where: { kind_sourceEventKey: { kind: "relationship_ended", sourceEventKey } },
    select: { id: true },
  });
  if (existing) return { recorded: false };
  await tx.emailPermissionEvent.create({
    data: {
      userId: input.userId,
      emailAddress: started.emailAddress,
      addressNormalizationVersion: started.addressNormalizationVersion,
      kind: "relationship_ended",
      scopeKey: "marketing",
      // Never before the start it ends.
      occurredAt: input.occurredAt < started.occurredAt ? started.occurredAt : input.occurredAt,
      capturedVia: "system",
      sourceEventKey,
      jurisdiction: started.jurisdiction,
      jurisdictionSource: started.jurisdictionSource,
      policyVersionId: started.policyVersionId,
      evidence: { reason: input.reason, startedEventId: started.id },
    },
  });
  return { recorded: true };
}

/**
 * Whether this account's recorded relationship stands for a message to
 * `deliveryAddress` now. Reads only; the decision is the pure function's.
 */
export async function auRelationshipForSend(input: {
  userId: string;
  deliveryAddress: string;
  consentWithdrawn: boolean;
  amendmentInForce: boolean;
  now: Date;
  db?: Db;
}): Promise<AuRelationshipStanding> {
  const db = input.db ?? prisma;
  const started = await db.emailPermissionEvent.findUnique({
    where: {
      kind_sourceEventKey: {
        kind: "relationship_started",
        sourceEventKey: relationshipStartedSourceEventKey(input.userId),
      },
    },
    select: { id: true, userId: true, emailAddress: true, occurredAt: true },
  });
  // A start whose account was detached is not this account's relationship.
  if (!started || started.userId !== input.userId) {
    return auRelationshipStanding({
      started: null,
      ended: false,
      deliveryAddress: input.deliveryAddress,
      lastLoginAt: null,
      accountDeletionRequestedAt: null,
      consentWithdrawn: input.consentWithdrawn,
      amendmentInForce: input.amendmentInForce,
      now: input.now,
    });
  }
  const [ended, user] = await Promise.all([
    db.emailPermissionEvent.findUnique({
      where: {
        kind_sourceEventKey: {
          kind: "relationship_ended",
          sourceEventKey: relationshipEndedSourceEventKey(started.id),
        },
      },
      select: { id: true },
    }),
    db.user.findUnique({
      where: { id: input.userId },
      select: { lastLoginAt: true, accountDeletionRequestedAt: true },
    }),
  ]);
  return auRelationshipStanding({
    started: {
      id: started.id,
      emailAddress: started.emailAddress,
      occurredAt: started.occurredAt,
    },
    // No account row is an ended relationship, not a missing fact.
    ended: ended !== null || user === null,
    deliveryAddress: input.deliveryAddress,
    lastLoginAt: user?.lastLoginAt ?? null,
    accountDeletionRequestedAt: user?.accountDeletionRequestedAt ?? null,
    consentWithdrawn: input.consentWithdrawn,
    amendmentInForce: input.amendmentInForce,
    now: input.now,
  });
}
