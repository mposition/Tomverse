import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import {
  markCauseWriter,
  recordSuppressionCause,
  releaseSelectorCauses,
} from "@/lib/emailSuppressionCauses";
import {
  holdSuppressionFence,
  lockSuppressionAddress,
  readSuppressionAuthority,
} from "@/lib/emailSuppressionAuthority";
import {
  isActiveCause,
  releasableBy,
  removalNeedsApproval,
} from "@/lib/emailSuppressionAuthorityCore";
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
  /**
   * `classification` records a cause that stops every message of that
   * classification (only `marketing`, named by `purposeKey`). It has no entry:
   * the entry table knows only global and purpose scopes, so the cause is the
   * whole record and it decides once causes are the read authority
   * (docs/policy/email-product-news-redesign-draft.md, section 7.4).
   */
  scope?: "classification";
  expiresAt?: Date | null;
  sourceStream?: string | null;
  sourceDomain?: string | null;
  sourceClassification?: string | null;
  sourceDeliveryId?: string | null;
  sourceMessageId?: string | null;
  evidence?: Prisma.InputJsonValue;
  occurredAt?: Date;
  /**
   * Stable per writer, so a retried event records one cause
   * (docs/policy/email-product-news-redesign-draft.md, section 7.4):
   * webhook:<eventId>, softbounce:<deliveryId>, preference:<transitionId>,
   * admin:<idempotency key>, privacy:<requestId>:intake|completed.
   */
  sourceEventKey: string;
  sourceRequestId?: string | null;
  providerAccount?: string | null;
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
export async function recordSuppression(
  input: RecordSuppressionInput,
  // A transaction when the suppression must commit with the change that caused
  // it -- a withdrawal and its hold are one fact. Without one, the entry and its
  // cause still commit together in a transaction of their own.
  client?: Prisma.TransactionClient
): Promise<{ id: string | null; changed: boolean; duplicate?: true }> {
  if (!client) {
    return prisma.$transaction((tx) => recordSuppression(input, tx));
  }
  const emailAddress = normalizeSuppressionAddress(input.emailAddress);
  const purposeKey = input.purposeKey ?? GLOBAL_PURPOSE_KEY;
  const scope =
    input.scope === "classification"
      ? "classification"
      : purposeKey === GLOBAL_PURPOSE_KEY
        ? "global"
        : "purpose";
  if (scope === "classification" && purposeKey !== "marketing") {
    throw new Error("A classification suppression names the marketing classification.");
  }
  const occurredAt = input.occurredAt ?? new Date();

  // Shared fence first: no suppression write may straddle the read-authority
  // cutover (docs/policy/email-product-news-redesign-draft.md, section 7.4).
  await holdSuppressionFence(client);
  await lockSuppressionAddress(client, emailAddress);

  // The cause first and unconditionally: every event is its own fact, including
  // one the entry's merge rule below declines to record. Marked so the entry
  // trigger does not add a second cause for the same write.
  await markCauseWriter(client);
  const recorded = await recordSuppressionCause(client, {
    emailAddress,
    scope,
    purposeKey,
    reason: input.reason,
    source: input.source,
    sourceEventKey: input.sourceEventKey,
    sourceStream: input.sourceStream ?? null,
    sourceDomain: input.sourceDomain ?? null,
    sourceClassification: input.sourceClassification ?? null,
    sourceDeliveryId: input.sourceDeliveryId ?? null,
    sourceMessageId: input.sourceMessageId ?? null,
    sourceRequestId: input.sourceRequestId ?? null,
    providerAccount: input.providerAccount ?? null,
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    occurredAt,
    expiresAt: input.expiresAt ?? null,
  });

  // No entry for a classification cause; see RecordSuppressionInput.scope.
  if (scope === "classification") {
    return recorded ? { id: null, changed: true } : { id: null, changed: false, duplicate: true };
  }

  // The same event again -- a redelivered webhook, a retried admin request. It
  // is a no-op for the entry too: re-merging it would restamp the entry with the
  // retry's time and provenance while the cause keeps the first, and the two
  // records would disagree about one event.
  if (!recorded) {
    const current = await client.suppressionEntry.findUnique({
      where: { emailAddress_scope_purposeKey: { emailAddress, scope, purposeKey } },
      select: { id: true },
    });
    return { id: current?.id ?? null, changed: false, duplicate: true };
  }

  const existing = await client.suppressionEntry.findUnique({
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

  if (existing?.reason === "privacy_request") {
    // A data-subject request is never overwritten, not by another permanent
    // reason and not by a later request restamping it: the entry would then read as liftable and the only record of the
    // request would be gone (docs/policy/email-product-news-redesign-draft.md,
    // section 7.4). The new event is still its own cause above.
    return { id: existing.id, changed: false };
  }

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
    occurredAt,
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
  };

  const row = await client.suppressionEntry.upsert({
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

/**
 * `authority_changed`: the read authority moved between choosing a lift path
 * and taking the fence. Nothing was released; asking again takes the other path.
 */
export type SuppressionRemovalRefusal = "not_found" | "unliftable" | "authority_changed";

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
    await holdSuppressionFence(tx);
    // Read under the fence: a cutover that committed after the caller chose
    // this path means entries no longer decide, and lifting a whole selector
    // here would release causes the release matrix keeps.
    if ((await readSuppressionAuthority(tx)) !== "entry") {
      return { removed: false as const, refusal: "authority_changed" as const };
    }
    const found = await tx.suppressionEntry.findUnique({
      where: { id: input.id },
      select: { emailAddress: true },
    });
    if (!found) return { removed: false as const, refusal: "not_found" as const };
    await lockSuppressionAddress(tx, found.emailAddress);
    const entry = await tx.suppressionEntry.findUnique({
      where: { id: input.id },
    });
    if (!entry) return { removed: false as const, refusal: "not_found" as const };
    if (
      (UNLIFTABLE_SUPPRESSION_REASONS as readonly string[]).includes(entry.reason)
    ) {
      return { removed: false as const, refusal: "unliftable" as const };
    }
    // While sends are decided from entries, lifting the row lifts everything
    // behind it, so every active cause of the selector is released with it.
    await markCauseWriter(tx);
    await releaseSelectorCauses(tx, {
      emailAddress: entry.emailAddress,
      scope: entry.scope as "global" | "purpose",
      purposeKey: entry.purposeKey,
      releaseKind: "entry_removed",
      releaseEvidence: { kind: "entry_removed", entryId: entry.id },
      releasedAt: new Date(),
    });
    await tx.suppressionEntry.delete({ where: { id: entry.id } });
    return { removed: true as const, entry };
  });
}

/**
 * The active causes behind one entry's selector, for deciding how an
 * administrator may lift it once causes decide.
 */
export async function activeCausesForEntry(entryId: string, now: Date = new Date()) {
  const entry = await prisma.suppressionEntry.findUnique({
    where: { id: entryId },
    select: { emailAddress: true, scope: true, purposeKey: true },
  });
  if (!entry) return null;
  const causes = await prisma.suppressionCause.findMany({
    where: { ...entry, releasedAt: null },
    select: { id: true, reason: true, expiresAt: true, releasedAt: true },
    orderBy: { id: "asc" },
  });
  const active = causes.filter((cause) => isActiveCause(cause, now));
  return {
    entry,
    causeIds: active.map((cause) => cause.id),
    reasons: active.map((cause) => cause.reason),
    needsApproval: removalNeedsApproval(active.map((cause) => cause.reason)),
  };
}

export type CauseLiftResult =
  | {
      removed: true;
      entry: Prisma.SuppressionEntryGetPayload<object>;
      released: Array<{ id: string; reason: string }>;
      remaining: Array<{ id: string; reason: string }>;
    }
  | { removed: false; refusal: SuppressionRemovalRefusal | "approval_stale" };

/**
 * Lifts an entry's causes by the release matrix, once causes decide.
 *
 * Run inside the approved operation. Everything is re-read under the fence and
 * compared with the cause set the approval was granted for: a cause that
 * appeared since -- a soft bounce strengthened to a hard bounce -- was not
 * approved, so the lift is refused and has to be asked for again. The audit
 * entry and the release are one transaction, so a rolled-back lift leaves no
 * record of a release that did not happen.
 *
 * The entry itself is removed only when no cause remains active; while an
 * older build may still read entries, an entry with a live cause behind it
 * keeps blocking there too.
 */
export async function liftSuppressionCauses(input: {
  entryId: string;
  approvedCauseIds: readonly string[];
  action: "admin" | "approved_admin";
  evidence:
    | { kind: "admin" }
    | { kind: "dual_approval"; approvalId: string; authorizationAuditLogId: string }
    | { kind: "sole_admin"; authorizationAuditLogId: string };
  writeReleaseAudit: (tx: Prisma.TransactionClient) => Promise<string>;
  now?: Date;
}): Promise<CauseLiftResult> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    await holdSuppressionFence(tx);
    if ((await readSuppressionAuthority(tx)) !== "causes") {
      return { removed: false as const, refusal: "authority_changed" as const };
    }
    const found = await tx.suppressionEntry.findUnique({
      where: { id: input.entryId },
      select: { emailAddress: true },
    });
    if (!found) return { removed: false as const, refusal: "not_found" as const };
    // The address lock before the causes are read, so no cause can appear
    // between the read and the decision to remove the entry.
    await lockSuppressionAddress(tx, found.emailAddress);
    const entry = await tx.suppressionEntry.findUnique({ where: { id: input.entryId } });
    if (!entry) return { removed: false as const, refusal: "not_found" as const };

    const causes = (
      await tx.suppressionCause.findMany({
        where: {
          emailAddress: entry.emailAddress,
          scope: entry.scope,
          purposeKey: entry.purposeKey,
          releasedAt: null,
        },
        select: { id: true, reason: true, expiresAt: true, releasedAt: true },
        orderBy: { id: "asc" },
      })
    ).filter((cause) => isActiveCause(cause, now));

    const current = causes.map((cause) => cause.id).join(",");
    if (current !== [...input.approvedCauseIds].sort().join(",")) {
      return { removed: false as const, refusal: "approval_stale" as const };
    }

    const releasable = causes.filter((cause) => releasableBy(input.action, cause.reason));
    const remaining = causes.filter((cause) => !releasableBy(input.action, cause.reason));
    if (releasable.length === 0 && causes.length > 0) {
      return { removed: false as const, refusal: "unliftable" as const };
    }

    const releaseAuditLogId = await input.writeReleaseAudit(tx);
    await markCauseWriter(tx);
    if (releasable.length > 0) {
      await tx.suppressionCause.updateMany({
        where: { id: { in: releasable.map((cause) => cause.id) }, releasedAt: null },
        data: {
          releasedAt: now,
          releaseKind: input.action,
          releaseEvidence: { ...input.evidence, releaseAuditLogId },
        },
      });
    }
    if (remaining.length === 0) {
      await tx.suppressionEntry.delete({ where: { id: entry.id } });
    }
    return {
      removed: true as const,
      entry,
      released: releasable.map(({ id, reason }) => ({ id, reason })),
      remaining: remaining.map(({ id, reason }) => ({ id, reason })),
    };
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
  // Which record decides is read on every call; see lib/emailSuppressionAuthority.ts.
  const authority = await readSuppressionAuthority();
  const records =
    authority === "causes"
      ? await prisma.suppressionCause.findMany({
          where: {
            emailAddress,
            releasedAt: null,
            OR: [
              { scope: "global" },
              // A classification-scope cause stops every message of that
              // classification, whatever its purpose.
              { scope: "classification", purposeKey: input.classification },
              ...(input.purpose ? [{ scope: "purpose", purposeKey: input.purpose }] : []),
            ],
          },
          // Expired soft bounces are filtered by the verdict itself.
          select: { reason: true, sourceStream: true, expiresAt: true },
        })
      : await prisma.suppressionEntry.findMany({
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
  /** The webhook event, for the cause key when there is no delivery. */
  webhookEventId: string;
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
    sourceEventKey: input.deliveryId
      ? `softbounce:${input.deliveryId}`
      : `softbounce:webhook:${input.webhookEventId}`,
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
