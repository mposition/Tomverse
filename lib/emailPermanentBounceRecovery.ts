import "server-only";

import { normalizeSuppressionAddress } from "@/lib/emailSuppression";
import { markCauseWriter, recordSuppressionCause } from "@/lib/emailSuppressionCauses";
import {
  holdSuppressionFence,
  lockSuppressionAddress,
} from "@/lib/emailSuppressionAuthority";
import { prisma } from "@/lib/prisma";

/**
 * Records the hard bounces that were stored as soft ones.
 *
 * Until docs/policy/email-notifications.md v18 item 7, a bounce counted as hard
 * only when Resend's `data.bounce.type` was `hard`. Resend reports a hard bounce
 * as `Permanent`, so every real one was handled as a soft bounce: a 24-hour
 * hold at most, and mail kept going to a mailbox that does not exist.
 *
 * Only `Permanent` is in scope. `hard` was always handled correctly, so its
 * events already carry whatever the handler of the day wrote, under keys this
 * cannot enumerate. The raw events are kept for ninety days; older ones are
 * gone and cannot be recovered from here.
 *
 * Conservative by construction -- a recovery that suppressed a working mailbox
 * would be worse than the defect it repairs:
 *
 *  - an event without a trustworthy provider timestamp is not written: its
 *    receipt time says nothing about when the bounce happened relative to
 *    later deliveries;
 *  - an address with any delivery reported at or after five minutes before the
 *    bounce is not written: older delivery times are receipt times, so the
 *    margin keeps a delivery that really came after from reading as before;
 *  - that check is repeated at write time, under the fence and the address lock
 *    every delivered-event writer also takes, so a delivery recorded during
 *    the run is seen;
 *  - what it writes is a cause, and only a cause. It used to also raise the
 *    mirrored entry when that entry was missing or held a soft bounce, and
 *    leave it alone when it held something permanent -- a ranking a single row
 *    forced. A cause replaces nothing: the hard bounce is recorded beside
 *    whatever else is active and the verdict reads them all.
 *
 * A dry run reads only. The report is counts, never an address or an id.
 */

export type PermanentBounceRecoveryReport = {
  mode: "dry_run" | "apply";
  /** Events received up to this instant are in scope; later ones are the live handler's. */
  snapshotAt: string;
  /** Processed `email.bounced` events on file in the snapshot. */
  bounceEvents: number;
  /** Of those, the ones Resend classified as `Permanent`. */
  permanentEvents: number;
  /** Permanent events whose hard bounce is already recorded (by this key or for this message). */
  alreadyRecorded: number;
  /** Permanent events with no address to suppress. */
  unaddressed: number;
  /** Permanent events without a provider timestamp to compare deliveries against. */
  indeterminateTime: number;
  /** Permanent events for an address with a delivery reported since (with margin). */
  deliveredSince: number;
  /** Permanent events whose cause is missing -- what an apply attempts. */
  missing: number;
  /** Distinct addresses among the missing events. */
  missingAddresses: number;
  /** Of those addresses, how many already hold an active hard bounce from another event. */
  missingAddressesAlreadyHardSuppressed: number;
  /** Causes written by this run (apply only). */
  recorded: number;
  /** Apply only: skipped at write time because a delivery had been recorded meanwhile. */
  deliveredDuringRun: number;
  /** Apply only: skipped at write time because this run had already recorded the message. */
  duplicatesInRun: number;
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

const RECOVERED_FROM = "permanent_bounce_misclassified_as_soft";
const DELIVERY_MARGIN_MS = 5 * 60_000;
const BATCH = 500;

const recipientOf = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
};

/** The provider's own time, or null: without it the event cannot be placed. */
const providerTimeOf = (payload: StoredPayload, receivedAt: Date): Date | null => {
  const value = payload.created_at;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  // The same skew bound as the live handler: a timestamp far ahead of receipt is not believed.
  if (parsed > receivedAt.getTime() + 5 * 60_000) return null;
  return new Date(parsed);
};

type Planned = {
  emailAddress: string;
  occurredAt: Date;
  sourceEventKey: string;
  sourceStream: "transactional" | "marketing";
  sourceClassification: string | null;
  sourceDeliveryId: string | null;
  sourceMessageId: string | null;
  sourceDomain: string | null;
  providerAccount: "transactional" | "marketing";
};

const hasDeliverySince = (
  client: Pick<typeof prisma, "emailDelivery">,
  emailAddress: string,
  occurredAt: Date
) =>
  client.emailDelivery.findFirst({
    where: {
      emailAddress,
      deliveredAt: { gte: new Date(occurredAt.getTime() - DELIVERY_MARGIN_MS) },
    },
    select: { id: true },
  });

export async function recoverPermanentBounces(input: {
  apply: boolean;
  now?: Date;
}): Promise<PermanentBounceRecoveryReport> {
  const snapshotAt = input.now ?? new Date();
  const report: PermanentBounceRecoveryReport = {
    mode: input.apply ? "apply" : "dry_run",
    snapshotAt: snapshotAt.toISOString(),
    bounceEvents: 0,
    permanentEvents: 0,
    alreadyRecorded: 0,
    unaddressed: 0,
    indeterminateTime: 0,
    deliveredSince: 0,
    missing: 0,
    missingAddresses: 0,
    missingAddressesAlreadyHardSuppressed: 0,
    recorded: 0,
    deliveredDuringRun: 0,
    duplicatesInRun: 0,
    oldestEventReceivedAt: null,
  };
  const planned: Planned[] = [];

  let cursor: string | undefined;
  for (;;) {
    const events = await prisma.providerWebhookEvent.findMany({
      where: {
        provider: "resend",
        eventType: "email.bounced",
        processedAt: { not: null },
        // A fixed snapshot: an event arriving during the run is the live
        // handler's, and the cursor cannot skip or revisit rows.
        receivedAt: { lte: snapshotAt },
      },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, providerAccount: true, receivedAt: true, payload: true },
    });
    if (events.length === 0) break;
    cursor = events[events.length - 1].id;

    for (const event of events) {
      report.bounceEvents += 1;
      const received = event.receivedAt.toISOString();
      if (!report.oldestEventReceivedAt || received < report.oldestEventReceivedAt) {
        report.oldestEventReceivedAt = received;
      }
      const payload = (event.payload ?? {}) as StoredPayload;
      const bounceType = payload.data?.bounce?.type;
      if (typeof bounceType !== "string" || bounceType.toLowerCase() !== "permanent") continue;
      report.permanentEvents += 1;

      const sourceEventKey = `webhook:${event.id}`;
      const messageId = typeof payload.data?.email_id === "string" ? payload.data.email_id : null;
      const recorded = await prisma.suppressionCause.findFirst({
        where: {
          reason: "hard_bounce",
          OR: [{ sourceEventKey }, ...(messageId ? [{ sourceMessageId: messageId }] : [])],
        },
        select: { id: true },
      });
      if (recorded) {
        report.alreadyRecorded += 1;
        continue;
      }

      const providerAccount = event.providerAccount === "marketing" ? "marketing" : "transactional";
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
      const occurredAt = providerTimeOf(payload, event.receivedAt);
      if (!occurredAt) {
        report.indeterminateTime += 1;
        continue;
      }
      const emailAddress = normalizeSuppressionAddress(rawAddress);
      if (await hasDeliverySince(prisma, emailAddress, occurredAt)) {
        report.deliveredSince += 1;
        continue;
      }
      report.missing += 1;
      const classification = delivery?.templateVersion.classification ?? null;
      planned.push({
        emailAddress,
        occurredAt,
        sourceEventKey,
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
      });
    }
    if (events.length < BATCH) break;
  }

  const addresses = [...new Set(planned.map((item) => item.emailAddress))];
  report.missingAddresses = addresses.length;
  for (let index = 0; index < addresses.length; index += BATCH) {
    const held = await prisma.suppressionCause.findMany({
      where: {
        emailAddress: { in: addresses.slice(index, index + BATCH) },
        reason: "hard_bounce",
        releasedAt: null,
      },
      distinct: ["emailAddress"],
      select: { emailAddress: true },
    });
    report.missingAddressesAlreadyHardSuppressed += held.length;
  }

  if (!input.apply) return report;

  // Newest bounce first: the first write for an address raises its entry, and
  // later (older) ones find a hard bounce there and leave it -- so the entry
  // describes the most recent bounce.
  planned.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  for (const item of planned) {
    const outcome = await prisma.$transaction(
      async (tx) => {
        await holdSuppressionFence(tx);
        await lockSuppressionAddress(tx, item.emailAddress);
        // Again, under the lock a delivered-event writer takes.
        if (await hasDeliverySince(tx, item.emailAddress, item.occurredAt)) {
          return "delivered" as const;
        }
        // And again for the bounce itself: two events in this run can name one
        // message, and the first one's cause is visible only now.
        const recorded = await tx.suppressionCause.findFirst({
          where: {
            reason: "hard_bounce",
            OR: [
              { sourceEventKey: item.sourceEventKey },
              ...(item.sourceMessageId ? [{ sourceMessageId: item.sourceMessageId }] : []),
            ],
          },
          select: { id: true },
        });
        if (recorded) return "duplicate" as const;
        await markCauseWriter(tx);
        const written = await recordSuppressionCause(tx, {
          emailAddress: item.emailAddress,
          scope: "global",
          purposeKey: "*",
          reason: "hard_bounce",
          source: "provider_webhook",
          sourceEventKey: item.sourceEventKey,
          sourceStream: item.sourceStream,
          sourceDomain: item.sourceDomain,
          sourceClassification: item.sourceClassification,
          sourceDeliveryId: item.sourceDeliveryId,
          sourceMessageId: item.sourceMessageId,
          providerAccount: item.providerAccount,
          evidence: { recoveredFrom: RECOVERED_FROM },
          occurredAt: item.occurredAt,
        });
        if (!written) return "duplicate" as const;

        // The cause is the whole record now. What used to follow here was the
        // mirrored entry -- raised when there was none or when it held a soft
        // bounce, left alone when it held something permanent -- and that
        // ranking is what a single row forced. A cause does not replace
        // anything: the hard bounce is written beside whatever else is active,
        // and the verdict reads them all.
        return "recorded" as const;
      },
      { timeout: 20_000 }
    );
    if (outcome === "delivered") report.deliveredDuringRun += 1;
    if (outcome === "duplicate") report.duplicatesInRun += 1;
    if (outcome === "recorded") report.recorded += 1;
  }
  return report;
}
