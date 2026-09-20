import "server-only";

import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { evaluateMarketingSendHealth } from "@/lib/marketingSendHealth";
import { recordProviderComplaint } from "@/lib/emailComplaintSuppression";
import { recordSuppression, type RecordSuppressionInput } from "@/lib/emailSuppression";
import { providerEventEffect } from "@/lib/emailSuppressionCore";
import { providerApiKeyFor, webhookSecretFor } from "@/lib/emailProviderPortCore";
import type { SendingStream } from "@/lib/emailSendingIdentityCore";
import {
  providerEventOccurredAt,
  providerEventRank,
  type ProviderEventKey,
} from "@/lib/emailProviderEventOrderCore";
import {
  recordDeliveredEvent,
  recordProviderStatusEvent,
  recordSoftBounceEvent,
} from "@/lib/emailProviderEvents";

/**
 * Turns one Resend webhook into state, with effects that converge however often
 * it is applied. Not exactly once: a worker whose lease expired may still
 * apply its effects after another has taken the row, and each effect is
 * idempotent by its cause key and the event order, so the state converges.
 *
 * Contract: docs/policy/email-notifications.md §9.6.
 *
 * Two things make this safe to call with a redelivered event:
 *
 *  - the raw event is recorded under the provider's own id (`svix-id`), which
 *    is unique per message and stable across retries, so a second delivery
 *    finds the row: a processed one stops there, an unprocessed one is claimed
 *    and applied again under a lease;
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
  const requested = Number(options?.limit ?? 1_000);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(1, Math.floor(requested)), 1_000) : 1_000;
  // One statement, and never a row a worker holds a live lease on: a row
  // claimed between choosing and deleting would otherwise lose its bookkeeping
  // after its effects were applied. An unprocessed row past retention is
  // purged too -- ninety days on, nothing will apply it, and it still names
  // the recipient.
  const purged = await prisma.$executeRaw`
    DELETE FROM "ProviderWebhookEvent"
     WHERE "id" IN (
             SELECT "id" FROM "ProviderWebhookEvent"
              WHERE "provider" = ${RESEND_PROVIDER}
                AND "receivedAt" < (${cutoff.toISOString()}::timestamptz AT TIME ZONE 'UTC')
                AND NOT ("processingLeaseId" IS NOT NULL
                         AND "processingStartedAt" >= (now() AT TIME ZONE 'UTC') - make_interval(secs => CAST(${WEBHOOK_LEASE_SECONDS} AS integer)))
              ORDER BY "receivedAt" ASC, "id" ASC
              LIMIT CAST(${limit} AS integer)
              FOR UPDATE SKIP LOCKED
           )
       AND NOT ("processingLeaseId" IS NOT NULL
                AND "processingStartedAt" >= (now() AT TIME ZONE 'UTC') - make_interval(secs => CAST(${WEBHOOK_LEASE_SECONDS} AS integer)))
  `;
  return { purged };
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
  /** Another worker holds a live lease on this event; the provider retries. */
  | { handled: false; reason: "in_progress" }
  | { handled: true; effect: string; deliveryId: string | null };

/**
 * The processing state machine for a stored event
 * (docs/policy/email-product-news-redesign-draft.md, section 7.4, webhook
 * reprocessing, C37, C47, C48, C74, C78, C79, C86).
 *
 * A worker claims a row with a random lease id, a start time and one more
 * attempt, all in one conditional UPDATE. Every outcome it records is fenced on
 * that lease id and on the row still being neither processed nor abandoned, so
 * a worker whose lease expired cannot overwrite a newer claim or a terminal
 * state: whichever write commits first wins.
 */
export const WEBHOOK_LEASE_SECONDS = 60;
export const WEBHOOK_MAX_ATTEMPTS = 10;
/** How long an event waits for the delivery it names to be recorded. */
export const WEBHOOK_AWAIT_DELIVERY_MINUTES = 15;

type StoredEvent = {
  id: string;
  /** The account whose endpoint and secret the event arrived through. */
  providerAccount: SendingStream;
  providerEventId: string;
  eventType: string;
  receivedAt: Date;
  payload: ResendEventPayload;
};

type Claim = { leaseId: string; attempts: number; awaitExpired: boolean };

/** Claims an unprocessed row whose lease is absent or expired. Null when not claimable. */
const claimStoredEvent = async (id: string): Promise<Claim | null> => {
  const leaseId = randomUUID();
  const rows = await prisma.$queryRaw<Array<{ attempts: number; awaitExpired: boolean }>>`
    UPDATE "ProviderWebhookEvent"
       SET "processingLeaseId" = ${leaseId},
           "processingStartedAt" = (now() AT TIME ZONE 'UTC'),
           "processingAttempts" = "processingAttempts" + 1
     WHERE "id" = ${id}
       AND "processedAt" IS NULL
       AND "abandonedAt" IS NULL
       AND "processingAttempts" < CAST(${WEBHOOK_MAX_ATTEMPTS} AS integer)
       AND ("processingLeaseId" IS NULL
            OR "processingStartedAt" < (now() AT TIME ZONE 'UTC') - make_interval(secs => CAST(${WEBHOOK_LEASE_SECONDS} AS integer)))
    RETURNING "processingAttempts" AS "attempts",
              ("receivedAt" <= (now() AT TIME ZONE 'UTC') - make_interval(mins => CAST(${WEBHOOK_AWAIT_DELIVERY_MINUTES} AS integer))) AS "awaitExpired"
  `;
  const row = rows[0];
  return row ? { leaseId, attempts: Number(row.attempts), awaitExpired: row.awaitExpired } : null;
};

/** Success: processed, lease cleared. False when the lease was lost. */
const completeClaim = async (id: string, leaseId: string) =>
  (await prisma.$executeRaw`
    UPDATE "ProviderWebhookEvent"
       SET "processedAt" = (now() AT TIME ZONE 'UTC'),
           "processingLeaseId" = NULL,
           "processingStartedAt" = NULL,
           "processingError" = NULL
     WHERE "id" = ${id} AND "processingLeaseId" = ${leaseId}
       AND "processedAt" IS NULL AND "abandonedAt" IS NULL
  `) === 1;

/**
 * No delivery to bind to yet: back to waiting, with the attempt this claim added
 * given back -- waiting is not a failure, and the sweeper claims the row again.
 */
const releaseToAwaiting = async (id: string, leaseId: string) =>
  (await prisma.$executeRaw`
    UPDATE "ProviderWebhookEvent"
       SET "processingLeaseId" = NULL,
           "processingStartedAt" = NULL,
           "processingAttempts" = GREATEST("processingAttempts" - 1, 0)
     WHERE "id" = ${id} AND "processingLeaseId" = ${leaseId}
       AND "processedAt" IS NULL AND "abandonedAt" IS NULL
  `) === 1;

/**
 * Failure: lease cleared at once so the event can be claimed again, and
 * abandoned in the same write when this was the last attempt.
 */
const failClaim = async (id: string, leaseId: string, errorKind: string) => {
  const rows = await prisma.$queryRaw<Array<{ abandoned: boolean }>>`
    UPDATE "ProviderWebhookEvent"
       SET "processingLeaseId" = NULL,
           "processingStartedAt" = NULL,
           "processingError" = ${errorKind},
           "abandonedAt" = CASE WHEN "processingAttempts" >= CAST(${WEBHOOK_MAX_ATTEMPTS} AS integer)
                                THEN (now() AT TIME ZONE 'UTC') ELSE NULL END
     WHERE "id" = ${id} AND "processingLeaseId" = ${leaseId}
       AND "processedAt" IS NULL AND "abandonedAt" IS NULL
    RETURNING ("abandonedAt" IS NOT NULL) AS "abandoned"
  `;
  return rows[0] ? (rows[0].abandoned ? "abandoned" : "failed") : "lease_lost";
};

const reportAbandoned = (count: number) =>
  reportOperationalIncident({
    code: "EMAIL_WEBHOOK_ABANDONED",
    title: "Email provider events were abandoned after repeated failures",
    error: `${count} provider event(s) failed ${WEBHOOK_MAX_ATTEMPTS} times; marked abandoned and not retried automatically, though their effects may already have been applied`,
    severity: "error",
    cooldownMs: 30 * 60 * 1_000,
    context: { component: "email-webhook", abandoned: count },
  });

/** Applies one claimed event and records the outcome under its lease. */
const runClaimedEvent = async (
  event: StoredEvent,
  claim: Claim
): Promise<{ handled: true; effect: string; deliveryId: string | null }> => {
  try {
    const result = await applyResendEvent({
      eventType: event.eventType,
      payload: event.payload,
      receivedAt: event.receivedAt,
      webhookEventId: event.id,
      providerAccount: event.providerAccount,
      providerEventId: event.providerEventId,
      awaitDelivery: !claim.awaitExpired,
    });
    const recorded = result.effect === AWAITING_DELIVERY
      ? await releaseToAwaiting(event.id, claim.leaseId)
      : await completeClaim(event.id, claim.leaseId);
    if (!recorded) {
      // A worker whose lease expired mid-run: the effects are idempotent, and
      // the newer claim owns the row's bookkeeping.
      console.warn(JSON.stringify({ event: "email_webhook_lease_lost", at: new Date().toISOString() }));
    }
    return { handled: true, ...result };
  } catch (error) {
    // A short classification, never the provider's body: it names the
    // recipient.
    const errorKind = error instanceof Error ? error.name.slice(0, 60) : "unknown";
    const outcome = await failClaim(event.id, claim.leaseId, errorKind);
    if (outcome === "abandoned") await reportAbandoned(1);
    throw error;
  }
};

/**
 * Records the event and applies it.
 *
 * The row is written first, already claimed, so an event whose application
 * fails is still on file and is retried -- by the provider redelivering it, or
 * by the sweeper when the provider has given up.
 */
export async function processResendWebhook(input: {
  /** The account whose endpoint and signing secret verified the event. */
  providerAccount: SendingStream;
  providerEventId: string;
  payload: ResendEventPayload;
  receivedAt?: Date;
}): Promise<WebhookProcessResult> {
  const eventType = typeof input.payload.type === "string" ? input.payload.type : "unknown";
  const providerAccount = input.providerAccount;

  // Written with the database's clock, like every later lease and waiting
  // decision, so an application host whose clock drifts cannot make a fresh
  // lease look expired or a fresh event look fifteen minutes old. The claim is
  // part of the insert; a conflict is a redelivery.
  const leaseId = randomUUID();
  const inserted = await prisma.$queryRaw<
    Array<{ id: string; receivedAt: Date; awaitExpired: boolean }>
  >`
    INSERT INTO "ProviderWebhookEvent" (
      "id", "provider", "providerAccount", "providerEventId", "eventType", "receivedAt", "payload",
      "processingLeaseId", "processingStartedAt", "processingAttempts"
    ) VALUES (
      ${randomUUID()}, ${RESEND_PROVIDER}, ${providerAccount}, ${input.providerEventId}, ${eventType},
      COALESCE((${input.receivedAt?.toISOString() ?? null}::timestamptz AT TIME ZONE 'UTC'),
               (now() AT TIME ZONE 'UTC')),
      ${JSON.stringify(input.payload)}::jsonb,
      ${leaseId}, (now() AT TIME ZONE 'UTC'), 1
    )
    -- No conflict target. The contraction (20260920100100) left one arbiter,
    -- so naming it would behave identically -- and not naming it stays right if
    -- a second one is ever added, which is what went wrong while the old
    -- (provider, providerEventId) unique sat beside the per-account one: a
    -- target names one arbiter and a conflict on the other raises instead of
    -- doing nothing. Which row conflicted is established by the lookup below.
    ON CONFLICT DO NOTHING
    RETURNING "id", "receivedAt",
              ("receivedAt" <= (now() AT TIME ZONE 'UTC') - make_interval(mins => CAST(${WEBHOOK_AWAIT_DELIVERY_MINUTES} AS integer))) AS "awaitExpired"
  `;
  const created = inserted[0];
  if (created) {
    return runClaimedEvent(
      {
        id: created.id,
        providerAccount,
        providerEventId: input.providerEventId,
        eventType,
        receivedAt: created.receivedAt,
        payload: input.payload,
      },
      { leaseId, attempts: 1, awaitExpired: created.awaitExpired }
    );
  }

  // The same event again. Processed or abandoned: nothing to do. Otherwise it
  // failed or is waiting for its delivery, and this redelivery is a chance to
  // apply it -- unless a live lease says another worker is on it now.
  const existing = await prisma.providerWebhookEvent.findUnique({
    where: {
      provider_providerAccount_providerEventId: {
        provider: RESEND_PROVIDER,
        providerAccount,
        providerEventId: input.providerEventId,
      },
    },
    select: {
      id: true,
      eventType: true,
      receivedAt: true,
      payload: true,
      processedAt: true,
      abandonedAt: true,
    },
  });
  if (!existing) {
    // The insert stored nothing and the lookup finds nothing, which after the
    // contraction (20260920100100) has no ordinary explanation: the unique an
    // event id conflicts on is `(provider, providerAccount, providerEventId)`,
    // so a conflict there means this account's own event is on file and the
    // lookup above finds it. Not *impossible* -- the primary key is an arbiter
    // too, a future unique would be another, and a row can be deleted between
    // the insert and the read -- which is the reason to fail loudly rather than
    // to claim the state cannot occur.
    //
    // Until that migration the old `(provider, providerEventId)` unique made
    // this the ordinary way a marketing event carrying a transactional event's
    // id was refused -- which is the behaviour the contraction exists to end.
    // The answer is the same as it was: not a duplicate to acknowledge, because
    // nothing was recorded. It fails, the provider retries, and somebody is
    // told.
    await reportOperationalIncident({
      code: "EMAIL_WEBHOOK_EVENT_ID_COLLISION",
      title: "A provider event was neither stored nor found",
      error:
        "A provider event conflicted on insert and was absent on the read that followed; the account-aware unique leaves no ordinary explanation for that",
      severity: "error",
      cooldownMs: 30 * 60 * 1_000,
      context: { component: "email-webhook", account: providerAccount },
    });
    throw new Error("Provider event was neither stored nor found");
  }
  if (existing.processedAt || existing.abandonedAt) return { handled: false, reason: "duplicate" };
  const claim = await claimStoredEvent(existing.id);
  if (!claim) {
    // Read again, with the database's clock: the row may have been completed,
    // abandoned or claimed since it was read above.
    const [now] = await prisma.$queryRaw<
      Array<{ terminal: boolean; leaseLive: boolean; exhausted: boolean }>
    >`
      SELECT ("processedAt" IS NOT NULL OR "abandonedAt" IS NOT NULL) AS "terminal",
             ("processingLeaseId" IS NOT NULL
              AND "processingStartedAt" >= (now() AT TIME ZONE 'UTC') - make_interval(secs => CAST(${WEBHOOK_LEASE_SECONDS} AS integer))) AS "leaseLive",
             ("processingAttempts" >= CAST(${WEBHOOK_MAX_ATTEMPTS} AS integer)) AS "exhausted"
        FROM "ProviderWebhookEvent" WHERE "id" = ${existing.id}
    `;
    // Finished, or out of attempts with nobody holding it (the sweeper records
    // the abandonment): nothing for the provider to retry. A live lease is work
    // in progress whatever the attempt count.
    if (!now || now.terminal) return { handled: false, reason: "duplicate" };
    if (now.leaseLive) return { handled: false, reason: "in_progress" };
    return now.exhausted ? { handled: false, reason: "duplicate" } : { handled: false, reason: "in_progress" };
  }
  return runClaimedEvent(
    {
      id: existing.id,
      providerAccount,
      providerEventId: input.providerEventId,
      eventType: existing.eventType,
      receivedAt: existing.receivedAt,
      payload: existing.payload as ResendEventPayload,
    },
    claim
  );
}

/**
 * Picks up what the provider will not redeliver: failed events with attempts
 * left, events waiting for their delivery, and leases that expired. Records
 * abandonment for rows out of attempts, and raises an incident for anything
 * unprocessed an hour after receipt.
 *
 * Runs on the 15-minute runner. Oldest first, at most 50 events, and no new
 * event is started once the 20-second budget is spent. The budget admits work
 * rather than cutting it off: an event already started runs to completion under
 * its own transaction timeouts, so a pass can overrun by at most one event.
 */
export async function sweepProviderWebhookEvents(options?: { limit?: number; timeBudgetMs?: number }) {
  const requestedLimit = Number(options?.limit ?? 50);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(1, Math.floor(requestedLimit)), 50) : 50;
  const budget = Number(options?.timeBudgetMs ?? 20_000);
  const deadline = Date.now() + (Number.isFinite(budget) ? Math.min(Math.max(budget, 0), 20_000) : 20_000);

  // At most `limit` rows, oldest first, skipping any a worker holds right now.
  const abandonedRows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "ProviderWebhookEvent"
       SET "abandonedAt" = (now() AT TIME ZONE 'UTC'),
           "processingLeaseId" = NULL,
           "processingStartedAt" = NULL
     WHERE "id" IN (
             SELECT "id" FROM "ProviderWebhookEvent"
              WHERE "processedAt" IS NULL AND "abandonedAt" IS NULL
                AND "processingAttempts" >= CAST(${WEBHOOK_MAX_ATTEMPTS} AS integer)
                AND ("processingLeaseId" IS NULL
                     OR "processingStartedAt" < (now() AT TIME ZONE 'UTC') - make_interval(secs => CAST(${WEBHOOK_LEASE_SECONDS} AS integer)))
              ORDER BY "receivedAt" ASC, "id" ASC
              LIMIT CAST(${limit} AS integer)
              FOR UPDATE SKIP LOCKED
           )
       AND "processedAt" IS NULL AND "abandonedAt" IS NULL
       AND "processingAttempts" >= CAST(${WEBHOOK_MAX_ATTEMPTS} AS integer)
       AND ("processingLeaseId" IS NULL
            OR "processingStartedAt" < (now() AT TIME ZONE 'UTC') - make_interval(secs => CAST(${WEBHOOK_LEASE_SECONDS} AS integer)))
    RETURNING "id"
  `;
  if (abandonedRows.length > 0) await reportAbandoned(abandonedRows.length);

  const due = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "ProviderWebhookEvent"
     WHERE "provider" = ${RESEND_PROVIDER}
       AND "processedAt" IS NULL AND "abandonedAt" IS NULL
       AND "processingAttempts" < CAST(${WEBHOOK_MAX_ATTEMPTS} AS integer)
       AND ("processingLeaseId" IS NULL
            OR "processingStartedAt" < (now() AT TIME ZONE 'UTC') - make_interval(secs => CAST(${WEBHOOK_LEASE_SECONDS} AS integer)))
     ORDER BY "receivedAt" ASC, "id" ASC
     LIMIT CAST(${limit} AS integer)
  `;

  let processed = 0;
  let awaiting = 0;
  let failed = 0;
  let claimed = 0;
  for (const { id } of due) {
    if (Date.now() >= deadline) break;
    const claim = await claimStoredEvent(id);
    if (!claim) continue;
    claimed += 1;
    const row = await prisma.providerWebhookEvent.findUnique({
      where: { id },
      select: { providerAccount: true, providerEventId: true, eventType: true, receivedAt: true, payload: true },
    });
    if (!row) continue;
    try {
      const result = await runClaimedEvent(
        {
          id,
          providerAccount: row.providerAccount === "marketing" ? "marketing" : "transactional",
          providerEventId: row.providerEventId,
          eventType: row.eventType,
          receivedAt: row.receivedAt,
          payload: row.payload as ResendEventPayload,
        },
        claim
      );
      if (result.effect === AWAITING_DELIVERY) awaiting += 1;
      else processed += 1;
    } catch {
      // Recorded against the row by runClaimedEvent; the next pass retries it.
      failed += 1;
    }
  }

  const [backlog] = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) AS "count" FROM "ProviderWebhookEvent"
     WHERE "processedAt" IS NULL AND "abandonedAt" IS NULL
       AND "receivedAt" < (now() AT TIME ZONE 'UTC') - interval '1 hour'
  `;
  const stale = Number(backlog?.count ?? 0);
  if (stale > 0) {
    await reportOperationalIncident({
      code: "EMAIL_WEBHOOK_BACKLOG",
      title: "Email provider events are still unprocessed an hour after receipt",
      error: `${stale} provider event(s) received over an hour ago are not processed`,
      severity: "warning",
      cooldownMs: 60 * 60 * 1_000,
      context: { component: "email-webhook", stale },
    });
  }

  const silent = await silentProviderAccounts();
  for (const account of silent) {
    await reportOperationalIncident({
      code: `EMAIL_WEBHOOK_SILENT_${account.stream.toUpperCase()}`,
      title: "An email provider account sent mail but reported no events in a day",
      error: `The ${account.stream} account sent ${account.sent} message(s) in 24 hours and no webhook arrived; its endpoint may have been disabled`,
      severity: "warning",
      cooldownMs: 6 * 60 * 60 * 1_000,
      context: { component: "email-webhook", account: account.stream, sent: account.sent },
    });
  }

  return {
    claimed,
    processed,
    awaiting,
    failed,
    abandoned: abandonedRows.length,
    stale,
    silentAccounts: silent.map((account) => account.stream),
  };
}

/** At least this many sends in the window before silence is worth an incident. */
export const WEBHOOK_SILENCE_MIN_SENDS = 5;

/**
 * Accounts that sent mail in the last day and received no webhook in it -- the
 * shape of a provider that has disabled the endpoint after repeated failures
 * (docs/policy/email-product-news-redesign-draft.md, section 7.4, C67, C94).
 *
 * Sends are deliveries this system recorded as sent, by the account fixed on
 * the delivery; mail with no delivery row (operator notifications, the admin
 * test mail) does not count. One database clock for both sides of the window.
 * Only accounts with both an API key and a webhook secret are judged: an
 * account that cannot send, or has nowhere to report, is not silent.
 */
export async function silentProviderAccounts(env: Readonly<Record<string, string | undefined>> = process.env) {
  const streams: SendingStream[] = ["transactional", "marketing"];
  const silent: Array<{ stream: SendingStream; sent: number }> = [];
  for (const stream of streams) {
    if (!providerApiKeyFor(stream, env) || !webhookSecretFor(stream, env)) continue;
    const [row] = await prisma.$queryRaw<Array<{ sent: bigint; received: bigint }>>`
      SELECT
        (SELECT count(*) FROM "EmailDelivery"
          WHERE "providerAccount" = ${stream}
            AND "sentAt" >= (now() AT TIME ZONE 'UTC') - interval '24 hours'
            AND "sentAt" < (now() AT TIME ZONE 'UTC')) AS "sent",
        (SELECT count(*) FROM "ProviderWebhookEvent"
          WHERE "provider" = ${RESEND_PROVIDER}
            AND "providerAccount" = ${stream}
            AND "receivedAt" >= (now() AT TIME ZONE 'UTC') - interval '24 hours'
            AND "receivedAt" < (now() AT TIME ZONE 'UTC')) AS "received"
    `;
    const sent = Number(row?.sent ?? 0);
    if (sent >= WEBHOOK_SILENCE_MIN_SENDS && Number(row?.received ?? 0) === 0) {
      silent.push({ stream, sent });
    }
  }
  return silent;
}

/** The effect of an event whose delivery is not recorded yet; see awaitDelivery. */
export const AWAITING_DELIVERY = "awaiting_delivery";

const applyResendEvent = async (input: {
  eventType: string;
  payload: ResendEventPayload;
  receivedAt: Date;
  /** The stored event row; keys the suppression cause so a replay adds none. */
  webhookEventId: string;
  /** The account the event came through; scopes the delivery lookup. */
  providerAccount: SendingStream;
  /** The provider's event id, the last tie-break of the event order. */
  providerEventId: string;
  /**
   * True while the event may still wait for its delivery. The provider's
   * message id is recorded only after its response, so a webhook can arrive
   * first; for fifteen minutes after receipt such an event waits rather than
   * settling for the address-only effect.
   */
  awaitDelivery: boolean;
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
  const candidates = providerMessageId
    ? await prisma.emailDelivery.findMany({
        // Within the account that sent it: message ids are the provider's, and
        // two accounts can issue the same one.
        where: { providerAccount: input.providerAccount, providerMessageId },
        // Two rows means the message id does not identify a delivery.
        take: 2,
        select: {
          id: true,
          userId: true,
          emailAddress: true,
          lane: true,
          providerAccount: true,
          sentDomain: true,
          policyVersionId: true,
          jurisdictionCountry: true,
          templateVersion: {
            // The version it was sent under, not the template row: the row is
            // history and may carry a classification the code has since moved off.
            select: { classification: true, purpose: true },
          },
        },
      })
    : [];

  // Two deliveries for one message id in one account cannot be told apart, and
  // guessing would attribute a complaint to the wrong person. The event settles
  // on its address alone, and somebody is told.
  if (candidates.length > 1) {
    await reportOperationalIncident({
      code: "EMAIL_WEBHOOK_AMBIGUOUS_DELIVERY",
      title: "A provider event matched more than one delivery",
      error: "Two deliveries share a provider message id within one account; the event was applied to its address only",
      severity: "error",
      cooldownMs: 30 * 60 * 1_000,
      context: { component: "email-webhook", account: input.providerAccount },
    });
  }
  const delivery = candidates.length === 1 ? candidates[0] : null;

  if (!delivery && candidates.length === 0 && providerMessageId && input.awaitDelivery) {
    return { effect: AWAITING_DELIVERY, deliveryId: null };
  }

  const emailAddress = delivery?.emailAddress ?? recipient;

  // Applied in the provider's order, not in arrival order: the event's own
  // time, then how blocking it is, then its id
  // (docs/policy/email-product-news-redesign-draft.md, section 7.4).
  const key: ProviderEventKey = {
    occurredAt: providerEventOccurredAt({
      createdAt: input.payload.created_at,
      receivedAt: input.receivedAt,
    }),
    rank: providerEventRank(effect) ?? 0,
    eventId: input.providerEventId,
  };

  if (effect.kind === "delivery_status") {
    if (!delivery) return { effect: "unmatched", deliveryId: null };
    if (effect.status === "delivered") {
      await recordDeliveredEvent({
        emailAddress: delivery.emailAddress,
        deliveryId: delivery.id,
        key,
        webhookEventId: input.webhookEventId,
      });
    } else {
      await recordProviderStatusEvent({
        emailAddress: delivery.emailAddress,
        deliveryId: delivery.id,
        key,
        status: effect.status,
      });
    }
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
    delivery?.templateVersion.classification ?? null;

  if (effect.kind === "soft_bounce") {
    const outcome = await recordSoftBounceEvent({
      emailAddress,
      deliveryId: delivery?.id ?? null,
      key,
      webhookEventId: input.webhookEventId,
    });
    return {
      effect: outcome.suppressed ? "soft_bounce_suppressed" : "soft_bounce",
      deliveryId: delivery?.id ?? null,
    };
  }

  // The status moves only for a later event; the cause below is recorded
  // either way. A hard bounce or a complaint is true of the address whatever
  // order it arrived in.
  if (delivery) {
    await recordProviderStatusEvent({
      emailAddress: delivery.emailAddress,
      deliveryId: delivery.id,
      key,
      status: effect.deliveryStatus,
    });
  }

  const suppression: RecordSuppressionInput = {
    emailAddress,
    reason: effect.reason,
    source: "provider_webhook",
    // Which stream drew the complaint is what §13.3 decides on, so it is
    // recorded from the message rather than inferred later.
    // An event matched to no delivery takes its stream from the verified account.
    sourceStream: classification
      ? classification === "marketing"
        ? "marketing"
        : "transactional"
      : input.providerAccount,
    sourceClassification: classification,
    sourceDeliveryId: delivery?.id ?? null,
    sourceMessageId: providerMessageId,
    // The domain and account the message actually went out through, fixed on
    // the delivery at send; NULL for a message sent before they were recorded.
    sourceDomain: delivery?.sentDomain ?? null,
    providerAccount: delivery?.providerAccount ?? input.providerAccount,
    occurredAt: key.occurredAt,
    sourceEventKey: `webhook:${input.webhookEventId}`,
  };

  if (effect.reason === "complaint") {
    // A complaint is also an opt-out from the purpose of the message, recorded
    // with the suppression in one transaction
    // (docs/policy/email-product-news-redesign-draft.md, section 7.4).
    await recordProviderComplaint({
      suppression,
      delivery: delivery
        ? {
            id: delivery.id,
            userId: delivery.userId,
            emailAddress: delivery.emailAddress,
            purpose: delivery.templateVersion.purpose,
            policyVersionId: delivery.policyVersionId,
            jurisdictionCountry: delivery.jurisdictionCountry,
          }
        : null,
      webhookEventId: input.webhookEventId,
      occurredAt: key.occurredAt,
    });
  } else {
    await recordSuppression(suppression);
  }

  if (classification === "marketing") {
    // Evaluated here as well as before each send, so the switch trips on the
    // event that crossed the threshold rather than on whenever the next drain
    // happens to run. Idempotent, and it never un-halts (EM-09).
    await evaluateMarketingSendHealth(input.receivedAt).catch((error) => {
      console.error("Marketing send health evaluation failed:", error);
    });
  }

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
