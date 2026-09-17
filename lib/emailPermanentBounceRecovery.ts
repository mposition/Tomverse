import "server-only";

import { providerEventOccurredAt } from "@/lib/emailProviderEventOrderCore";
import { normalizeSuppressionAddress, recordSuppression } from "@/lib/emailSuppression";
import { PERMANENT_BOUNCE_TYPES } from "@/lib/emailSuppressionCore";
import { prisma } from "@/lib/prisma";

/**
 * Records the hard bounces that were stored as soft ones.
 *
 * Until docs/policy/email-notifications.md v18 item 7, a bounce counted as hard
 * only when Resend's `data.bounce.type` was `hard`. Resend reports a hard bounce
 * as `Permanent`, so every real one was handled as a soft bounce: a 24-hour
 * hold at most, and mail kept going to a mailbox that does not exist.
 *
 * The raw events are kept for ninety days, so the permanent bounces within that
 * window can be recorded now, each with the cause the corrected handler would
 * have written -- keyed `webhook:<event row id>`, so an event already recorded
 * that way, by the corrected handler or by an earlier run of this, is skipped.
 * Anything older has been purged and cannot be recovered from here.
 *
 * A dry run reads only. The report is counts, never an address.
 */

export type PermanentBounceRecoveryReport = {
  mode: "dry_run" | "apply";
  /** Processed `email.bounced` events on file (ninety days at most). */
  bounceEvents: number;
  /** Of those, the ones Resend classified as permanent. */
  permanentEvents: number;
  /** Permanent events already carrying their hard bounce cause. */
  alreadyRecorded: number;
  /** Permanent events with no address to suppress. */
  unaddressed: number;
  /**
   * Permanent events for an address that has had a delivery reported since:
   * the mailbox accepts mail now, and suppressing it would stop a working one.
   * Not written.
   */
  deliveredSince: number;
  /** Permanent events whose cause is missing -- what an apply writes. */
  missing: number;
  /** Distinct addresses among the missing events. */
  missingAddresses: number;
  /** Of those addresses, how many already hold an active hard bounce from another event. */
  missingAddressesAlreadyHardSuppressed: number;
  /** Causes written by this run (apply only). */
  recorded: number;
  /** Receipt time of the oldest bounce event on file, so the window is visible. */
  oldestEventReceivedAt: string | null;
};

type StoredPayload = {
  created_at?: unknown;
  data?: {
    email_id?: unknown;
    to?: unknown;
    bounce?: { type?: unknown } | null;
  } | null;
};

const recipientOf = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
};

const BATCH = 500;

export async function recoverPermanentBounces(input: { apply: boolean }): Promise<PermanentBounceRecoveryReport> {
  const report: PermanentBounceRecoveryReport = {
    mode: input.apply ? "apply" : "dry_run",
    bounceEvents: 0,
    permanentEvents: 0,
    alreadyRecorded: 0,
    unaddressed: 0,
    deliveredSince: 0,
    missing: 0,
    missingAddresses: 0,
    missingAddressesAlreadyHardSuppressed: 0,
    recorded: 0,
    oldestEventReceivedAt: null,
  };
  const missingAddresses = new Set<string>();
  // Planned first and written after the counts, so the report describes the
  // state before this run whichever mode it is in.
  const planned: Array<Parameters<typeof recordSuppression>[0]> = [];

  let cursor: string | undefined;
  for (;;) {
    const events = await prisma.providerWebhookEvent.findMany({
      where: { provider: "resend", eventType: "email.bounced", processedAt: { not: null } },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, providerAccount: true, receivedAt: true, payload: true },
    });
    if (events.length === 0) break;
    cursor = events[events.length - 1].id;

    for (const event of events) {
      report.bounceEvents += 1;
      if (
        !report.oldestEventReceivedAt ||
        event.receivedAt.toISOString() < report.oldestEventReceivedAt
      ) {
        report.oldestEventReceivedAt = event.receivedAt.toISOString();
      }
      const payload = (event.payload ?? {}) as StoredPayload;
      const bounceType = payload.data?.bounce?.type;
      if (typeof bounceType !== "string" || !PERMANENT_BOUNCE_TYPES.has(bounceType.toLowerCase())) {
        continue;
      }
      report.permanentEvents += 1;

      const sourceEventKey = `webhook:${event.id}`;
      const existing = await prisma.suppressionCause.findFirst({
        where: { sourceEventKey, reason: "hard_bounce" },
        select: { id: true },
      });
      if (existing) {
        report.alreadyRecorded += 1;
        continue;
      }

      const providerAccount = event.providerAccount === "marketing" ? "marketing" : "transactional";
      const messageId = typeof payload.data?.email_id === "string" ? payload.data.email_id : null;
      // The delivery the event names, only when exactly one matches in its
      // account -- the same rule the handler applies.
      const deliveries = messageId
        ? await prisma.emailDelivery.findMany({
            where: { providerAccount, providerMessageId: messageId },
            take: 2,
            select: {
              id: true,
              emailAddress: true,
              sentDomain: true,
              templateVersion: { select: { classification: true } },
            },
          })
        : [];
      const delivery = deliveries.length === 1 ? deliveries[0] : null;
      const rawAddress = delivery?.emailAddress ?? recipientOf(payload.data?.to);
      if (!rawAddress) {
        report.unaddressed += 1;
        continue;
      }
      const emailAddress = normalizeSuppressionAddress(rawAddress);
      const occurredAt = providerEventOccurredAt({
        createdAt: payload.created_at,
        receivedAt: event.receivedAt,
      });
      const laterDelivery = await prisma.emailDelivery.findFirst({
        where: { emailAddress, deliveredAt: { gt: occurredAt } },
        select: { id: true },
      });
      if (laterDelivery) {
        report.deliveredSince += 1;
        continue;
      }
      report.missing += 1;
      missingAddresses.add(emailAddress);

      const classification = delivery?.templateVersion.classification ?? null;
      planned.push({
        emailAddress,
        reason: "hard_bounce",
        source: "provider_webhook",
        sourceStream: classification
          ? classification === "marketing"
            ? "marketing"
            : "transactional"
          : providerAccount,
        sourceClassification: classification,
        sourceDeliveryId: delivery?.id ?? null,
        sourceMessageId: messageId,
        sourceDomain: delivery?.sentDomain ?? null,
        providerAccount,
        occurredAt,
        evidence: { recoveredFrom: "permanent_bounce_misclassified_as_soft" },
        sourceEventKey,
      });
    }
    if (events.length < BATCH) break;
  }

  report.missingAddresses = missingAddresses.size;
  if (missingAddresses.size > 0) {
    const addresses = [...missingAddresses];
    for (let index = 0; index < addresses.length; index += BATCH) {
      const slice = addresses.slice(index, index + BATCH);
      const held = await prisma.suppressionCause.findMany({
        where: { emailAddress: { in: slice }, reason: "hard_bounce", releasedAt: null },
        distinct: ["emailAddress"],
        select: { emailAddress: true },
      });
      report.missingAddressesAlreadyHardSuppressed += held.length;
    }
  }

  if (input.apply) {
    for (const suppression of planned) {
      const written = await recordSuppression(suppression);
      if (!written.duplicate) report.recorded += 1;
    }
  }
  return report;
}
