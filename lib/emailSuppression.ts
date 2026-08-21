import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import {
  SOFT_BOUNCE_SUPPRESSION_MS,
  SOFT_BOUNCE_SUPPRESSION_THRESHOLD,
  suppressionVerdict,
  type SendClassification,
  type SuppressionReason,
  type SuppressionVerdict,
} from "@/lib/emailSuppressionCore";

/**
 * The suppression list, and the gate every send passes through.
 *
 * Contract: docs/policy/email-notifications.md §13.3, §14.4.
 *
 * Keyed by address rather than by account, because a spam complaint follows the
 * mailbox: deleting an account and signing up again must not clear it. That is
 * also why `ConsentRecord` and this table are the two that survive account
 * deletion, and why the data domain registry records them as retained rather
 * than anonymised.
 *
 * **This list is the gate, and the provider has its own.** Resend suppresses at
 * the account level across every domain in a region (§5.3.1), so a marketing
 * complaint can refuse a login code no matter what this table says. Ours is
 * therefore not a second line of defence behind the provider's -- it is a
 * separate, earlier filter, and the provider's sits *in front of* the send we
 * decided to make. Detecting that is what `EMAIL_PROVIDER_SUPPRESSED` exists
 * for.
 */

export const normalizeSuppressionAddress = (value: string) =>
  value.trim().toLowerCase();

/** The scope-carrying key. `*` for a global entry; never NULL (§10.2). */
export const GLOBAL_PURPOSE_KEY = "*";

export type SuppressionSource =
  | "provider_webhook"
  | "unsubscribe_link"
  | "preference_center"
  | "admin";

export type RecordSuppressionInput = {
  emailAddress: string;
  reason: SuppressionReason;
  source: SuppressionSource;
  purposeKey?: string;
  expiresAt?: Date | null;
  sourceStream?: string | null;
  sourceDomain?: string | null;
  sourceClassification?: string | null;
  sourceDeliveryId?: string | null;
  sourceMessageId?: string | null;
  evidence?: Prisma.InputJsonValue;
  occurredAt?: Date;
};

/**
 * Records a suppression, or strengthens one that already exists.
 *
 * Strengthening rather than overwriting: an address holding a permanent
 * complaint that later soft-bounces must not have its complaint replaced by a
 * hold that expires in a day. The unique key is (address, scope, purposeKey),
 * so the row is the same one either way -- what has to be decided is whether
 * the new event says something worse than the old one.
 */
export async function recordSuppression(input: RecordSuppressionInput) {
  const emailAddress = normalizeSuppressionAddress(input.emailAddress);
  const purposeKey = input.purposeKey ?? GLOBAL_PURPOSE_KEY;
  const scope = purposeKey === GLOBAL_PURPOSE_KEY ? "global" : "purpose";

  const existing = await prisma.suppressionEntry.findUnique({
    where: {
      emailAddress_scope_purposeKey: { emailAddress, scope, purposeKey },
    },
    select: { id: true, reason: true },
  });

  const permanent = (reason: string) =>
    reason === "hard_bounce" ||
    reason === "complaint" ||
    reason === "manual" ||
    reason === "privacy_request";

  if (existing && permanent(existing.reason) && !permanent(input.reason)) {
    // The stored entry already says something stronger. Leaving it alone is the
    // whole point: a permanent suppression that a transient event can downgrade
    // is not a permanent suppression.
    return { id: existing.id, changed: false };
  }

  const data = {
    reason: input.reason,
    source: input.source,
    expiresAt: input.expiresAt ?? null,
    sourceStream: input.sourceStream ?? null,
    sourceDomain: input.sourceDomain ?? null,
    sourceClassification: input.sourceClassification ?? null,
    sourceDeliveryId: input.sourceDeliveryId ?? null,
    sourceMessageId: input.sourceMessageId ?? null,
    occurredAt: input.occurredAt ?? new Date(),
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
  };

  const row = await prisma.suppressionEntry.upsert({
    where: {
      emailAddress_scope_purposeKey: { emailAddress, scope, purposeKey },
    },
    update: data,
    create: { emailAddress, scope, purposeKey, ...data },
    select: { id: true },
  });
  return { id: row.id, changed: true };
}

/**
 * Entries an operator may not lift from this screen.
 *
 * A suppression created by a privacy request is the record of someone
 * exercising a legal right. Lifting it re-enables mail to them, and the process
 * that would be entitled to do that is the privacy process that created it --
 * not a button on an operations screen. Refused here rather than gated behind
 * approval, because there is no operational reason that would make it correct.
 */
export const UNLIFTABLE_SUPPRESSION_REASONS = ["privacy_request"] as const;

/**
 * Entries whose removal needs a second administrator.
 *
 * §13.3 calls these permanent: the provider, or the person, has said stop.
 * Removing one starts mail to an address that said stop, and the cost is not
 * only to them -- complaints and hard bounces are what a receiver measures a
 * sending domain by (§14.5), and a domain's reputation is the part of this
 * system that recovers slowest.
 */
export const APPROVAL_REQUIRED_SUPPRESSION_REASONS = [
  "hard_bounce",
  "complaint",
] as const;

export type SuppressionRemovalRefusal = "not_found" | "unliftable";

/**
 * Lifts one suppression, returning what it was so the audit entry can hold it.
 *
 * The row is read and deleted in one transaction: an audit entry describing a
 * row that a concurrent lift already removed would be a record of something
 * that did not happen, and the reason column is the only trace of why mail to
 * this address was re-enabled (§13.7).
 */
export async function removeSuppression(input: {
  id: string;
}): Promise<
  | { removed: true; entry: Prisma.SuppressionEntryGetPayload<object> }
  | { removed: false; refusal: SuppressionRemovalRefusal }
> {
  return prisma.$transaction(async (tx) => {
    const entry = await tx.suppressionEntry.findUnique({
      where: { id: input.id },
    });
    if (!entry) return { removed: false as const, refusal: "not_found" as const };
    if (
      (UNLIFTABLE_SUPPRESSION_REASONS as readonly string[]).includes(entry.reason)
    ) {
      return { removed: false as const, refusal: "unliftable" as const };
    }
    await tx.suppressionEntry.delete({ where: { id: entry.id } });
    return { removed: true as const, entry };
  });
}

/**
 * Whether this message may go out.
 *
 * Reads every entry for the address -- global and per-purpose -- and hands them
 * to the pure decision in emailSuppressionCore. The split exists so the table
 * in §13.3 can be exercised exhaustively without a database, which matters
 * because it is the table most likely to be quietly inverted later.
 */
export async function suppressionCheck(input: {
  emailAddress: string;
  classification: SendClassification;
  purpose?: string | null;
  now?: Date;
}): Promise<SuppressionVerdict> {
  const emailAddress = normalizeSuppressionAddress(input.emailAddress);
  const records = await prisma.suppressionEntry.findMany({
    where: {
      emailAddress,
      OR: [
        { scope: "global" },
        ...(input.purpose ? [{ scope: "purpose", purposeKey: input.purpose }] : []),
      ],
    },
    select: { reason: true, sourceStream: true, expiresAt: true },
  });

  return suppressionVerdict({
    classification: input.classification,
    records: records as Parameters<typeof suppressionVerdict>[0]["records"],
    ...(input.now ? { now: input.now } : {}),
  });
}

/**
 * Counts a soft bounce and suppresses once a run of them says the mailbox is
 * not accepting mail.
 *
 * A run rather than a count: one deferral is a full mailbox or a greylisting
 * pass and means nothing, so any successful delivery resets the tally. Without
 * the reset a long-lived address would creep toward suppression over months of
 * unrelated hiccups.
 *
 * The counter lives in the delivery history rather than in its own table --
 * consecutive soft bounces are exactly the recent rows for this address, and a
 * separate counter would be a second source of truth to keep in step.
 */
export async function recordSoftBounce(input: {
  emailAddress: string;
  deliveryId?: string | null;
  sourceStream?: string | null;
  sourceMessageId?: string | null;
  now?: Date;
}) {
  const emailAddress = normalizeSuppressionAddress(input.emailAddress);
  const now = input.now ?? new Date();

  const recent = await prisma.emailDelivery.findMany({
    where: { emailAddress, status: { in: ["bounced", "delivered", "sent"] } },
    orderBy: { createdAt: "desc" },
    take: SOFT_BOUNCE_SUPPRESSION_THRESHOLD,
    select: { status: true },
  });

  const consecutive = recent.findIndex((row) => row.status !== "bounced");
  const run = consecutive === -1 ? recent.length : consecutive;
  if (run < SOFT_BOUNCE_SUPPRESSION_THRESHOLD) {
    return { suppressed: false, run };
  }

  await recordSuppression({
    emailAddress,
    reason: "soft_bounce",
    source: "provider_webhook",
    expiresAt: new Date(now.getTime() + SOFT_BOUNCE_SUPPRESSION_MS),
    sourceStream: input.sourceStream ?? null,
    sourceDeliveryId: input.deliveryId ?? null,
    sourceMessageId: input.sourceMessageId ?? null,
    occurredAt: now,
  });
  return { suppressed: true, run };
}

/**
 * Raised when the provider refuses a message our own gate allowed.
 *
 * The gap this covers is specific to §5.3.1: Resend's suppression is
 * account-wide, so a complaint about a newsletter can silently stop a login
 * code even though this table says the send was fine. Without a signal the
 * symptom is "sign-in emails do not arrive for one person" with nothing in our
 * logs to explain it.
 */
export async function reportProviderSuppression(input: {
  emailAddress: string;
  classification: string;
  deliveryId: string;
}) {
  await reportOperationalIncident({
    code: "EMAIL_PROVIDER_SUPPRESSED",
    title: "The provider refused a message our own suppression list allowed",
    error:
      `A ${input.classification} message was refused for an address we consider ` +
      "sendable. Resend suppression is account-wide across a region, so a " +
      "marketing complaint can refuse transactional mail.",
    severity: "error",
    cooldownMs: 30 * 60 * 1_000,
    context: {
      component: "email-suppression",
      classification: input.classification,
      deliveryId: input.deliveryId,
    },
  });
}
