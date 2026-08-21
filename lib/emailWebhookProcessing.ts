import "server-only";

import { prisma } from "@/lib/prisma";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { recordSoftBounce, recordSuppression } from "@/lib/emailSuppression";
import { providerEventEffect } from "@/lib/emailSuppressionCore";

/**
 * Turns one Resend webhook into state, exactly once.
 *
 * Contract: docs/policy/email-notifications.md §9.6.
 *
 * Two things make this safe to call with a redelivered event:
 *
 *  - the raw event is recorded under the provider's own id (`svix-id`), which
 *    is unique per message and stable across retries, so a second delivery
 *    collides on the unique index and stops before touching anything;
 *  - the state changes it applies are writes of a known value rather than
 *    increments, so even a race that got past the first check converges.
 *
 * `StripeWebhookEventLog` already establishes this shape in the repository, for
 * the same reason and against the same class of provider behaviour.
 */

export const RESEND_PROVIDER = "resend";

/**
 * How long the raw events are kept.
 *
 * They exist to make a redelivery a no-op and to let an operator see what
 * actually arrived, and both of those are answered within days. What they also
 * contain is the recipient's address, so keeping them indefinitely would build
 * a second, unmanaged copy of who we mail -- §13.2 sets ninety days and this is
 * that number, applied by the drain rather than left as an intention.
 */
export const WEBHOOK_EVENT_RETENTION_DAYS = 90;

/**
 * Removes events past their retention.
 *
 * Safe to run alongside the replay guard: the guard only has to cover the
 * window a provider retries in, which is hours, and ninety days is far outside
 * it. An event old enough to be purged is one no provider will send again.
 */
export async function purgeExpiredWebhookEvents(options?: {
  now?: Date;
  limit?: number;
}) {
  const now = options?.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - WEBHOOK_EVENT_RETENTION_DAYS * 24 * 60 * 60_000
  );
  const stale = await prisma.providerWebhookEvent.findMany({
    where: { provider: RESEND_PROVIDER, receivedAt: { lt: cutoff } },
    select: { id: true },
    take: options?.limit ?? 1_000,
  });
  if (stale.length === 0) return { purged: 0 };
  const result = await prisma.providerWebhookEvent.deleteMany({
    where: { id: { in: stale.map((row) => row.id) } },
  });
  return { purged: result.count };
}

type ResendEventPayload = {
  type?: unknown;
  created_at?: unknown;
  data?: {
    email_id?: unknown;
    to?: unknown;
    subject?: unknown;
    bounce?: { type?: unknown; subType?: unknown } | null;
  } | null;
};

const firstRecipient = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
};

export type WebhookProcessResult =
  | { handled: false; reason: "duplicate" }
  | { handled: true; effect: string; deliveryId: string | null };

/**
 * Records the event and applies it.
 *
 * The recording happens first and in its own statement rather than inside the
 * transaction that applies the effect: if applying fails, the event is still on
 * file with its error, which is what makes a failed webhook something an
 * operator can find rather than something the provider retried into a log.
 */
export async function processResendWebhook(input: {
  providerEventId: string;
  payload: ResendEventPayload;
  receivedAt?: Date;
}): Promise<WebhookProcessResult> {
  const receivedAt = input.receivedAt ?? new Date();
  const eventType = typeof input.payload.type === "string" ? input.payload.type : "unknown";

  try {
    await prisma.providerWebhookEvent.create({
      data: {
        provider: RESEND_PROVIDER,
        providerEventId: input.providerEventId,
        eventType,
        receivedAt,
        payload: input.payload as never,
      },
    });
  } catch (error) {
    // The unique index is the replay guard. A redelivery is normal provider
    // behaviour, not a fault, so it answers 200 and changes nothing.
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "P2002"
    ) {
      return { handled: false, reason: "duplicate" };
    }
    throw error;
  }

  try {
    const result = await applyResendEvent({ eventType, payload: input.payload, receivedAt });
    await prisma.providerWebhookEvent.update({
      where: {
        provider_providerEventId: {
          provider: RESEND_PROVIDER,
          providerEventId: input.providerEventId,
        },
      },
      data: { processedAt: new Date() },
    });
    return { handled: true, ...result };
  } catch (error) {
    await prisma.providerWebhookEvent.update({
      where: {
        provider_providerEventId: {
          provider: RESEND_PROVIDER,
          providerEventId: input.providerEventId,
        },
      },
      // A short classification, never the provider's body: it names the
      // recipient.
      data: {
        processingError:
          error instanceof Error ? error.name.slice(0, 60) : "unknown",
      },
    });
    throw error;
  }
}

const applyResendEvent = async (input: {
  eventType: string;
  payload: ResendEventPayload;
  receivedAt: Date;
}): Promise<{ effect: string; deliveryId: string | null }> => {
  const bounceType =
    typeof input.payload.data?.bounce?.type === "string"
      ? input.payload.data.bounce.type
      : null;
  const effect = providerEventEffect({ type: input.eventType, bounceType });
  if (effect.kind === "ignored") {
    return { effect: "ignored", deliveryId: null };
  }

  const providerMessageId =
    typeof input.payload.data?.email_id === "string"
      ? input.payload.data.email_id
      : null;
  const recipient = firstRecipient(input.payload.data?.to);

  // Matched by the provider's own message id. Falling back to the address
  // would attach a bounce to whichever message happened to be most recent,
  // which is a different message from the one that bounced.
  const delivery = providerMessageId
    ? await prisma.emailDelivery.findFirst({
        where: { providerMessageId },
        select: {
          id: true,
          emailAddress: true,
          lane: true,
          templateVersion: {
            select: { template: { select: { classification: true } } },
          },
        },
      })
    : null;

  const emailAddress = delivery?.emailAddress ?? recipient;

  if (effect.kind === "delivery_status") {
    if (!delivery) return { effect: "unmatched", deliveryId: null };
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: effect.status,
        ...(effect.status === "delivered" ? { deliveredAt: input.receivedAt } : {}),
      },
    });
    return { effect: effect.status, deliveryId: delivery.id };
  }

  if (!emailAddress) {
    // Nothing to suppress and nothing to update. Recorded as handled rather
    // than retried: the provider will send the same unusable event again.
    return { effect: "unaddressed", deliveryId: null };
  }

  const stream =
    delivery?.lane === "credential_sync" ? "transactional" : "standard";
  const classification =
    delivery?.templateVersion.template.classification ?? null;

  if (effect.kind === "soft_bounce") {
    if (delivery) {
      await prisma.emailDelivery.update({
        where: { id: delivery.id },
        data: { status: "bounced", lastErrorKind: "soft_bounce" },
      });
    }
    const outcome = await recordSoftBounce({
      emailAddress,
      deliveryId: delivery?.id ?? null,
      sourceStream: classification === "marketing" ? "marketing" : "transactional",
      sourceMessageId: providerMessageId,
      now: input.receivedAt,
    });
    return {
      effect: outcome.suppressed ? "soft_bounce_suppressed" : "soft_bounce",
      deliveryId: delivery?.id ?? null,
    };
  }

  if (delivery) {
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: { status: effect.deliveryStatus },
    });
  }

  await recordSuppression({
    emailAddress,
    reason: effect.reason,
    source: "provider_webhook",
    // Which stream drew the complaint is what §13.3 decides on, so it is
    // recorded from the message rather than inferred later.
    sourceStream: classification === "marketing" ? "marketing" : "transactional",
    sourceClassification: classification,
    sourceDeliveryId: delivery?.id ?? null,
    sourceMessageId: providerMessageId,
    occurredAt: input.receivedAt,
  });

  if (effect.reason === "complaint" && classification && classification !== "marketing") {
    // Someone reported a receipt or a security alert as spam. Either an account
    // takeover is under way and they are reporting our own warning, or we are
    // sending something as transactional that they do not experience that way.
    await reportOperationalIncident({
      code: "EMAIL_TRANSACTIONAL_COMPLAINT",
      title: "A transactional message was reported as spam",
      error: `A ${classification} message drew a spam complaint`,
      severity: "warning",
      cooldownMs: 30 * 60 * 1_000,
      context: {
        component: "email-webhook",
        classification,
        stream,
      },
    });
  }

  return { effect: effect.reason, deliveryId: delivery?.id ?? null };
};
