import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { deliverEmailOnce } from "@/lib/email";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { suppressionCheck } from "@/lib/emailSuppression";
import { sendWithAddressLock } from "@/lib/emailSendLock";
import {
  CREDENTIAL_SEND_LOCK_TIMEOUT_MS,
  CREDENTIAL_SEND_RESERVE_MS,
} from "@/lib/emailSendLockCore";
import { sentDomainOf } from "@/lib/emailSentIdentityCore";
import {
  AUTH_LOGIN_CODE_TEMPLATE,
  emailTemplateDefinition,
} from "@/lib/emailTemplateDefinitions";
import {
  EMAIL_AUDIT_HASH_KEY_VERSION,
  renderedBodyHash,
} from "@/lib/emailAuditHash";
import {
  classifyProviderStatus,
  CREDENTIAL_SEND_BUDGET_MS,
  classifyTransportError,
  isCredentialStillSendable,
  isProviderAuthFailure,
  nextCredentialSendAttempt,
  SUPPRESSION_REFUSAL_STATUSES,
  type ProviderSendOutcome,
} from "@/lib/emailSendRetryCore";

/**
 * The credential synchronous lane.
 *
 * Contract: docs/policy/email-notifications.md §9.4a.
 *
 * A login code lives for at most ten minutes -- `CODE_TTL_MINUTES` in
 * lib/emailLogin.ts is clamped to a ceiling of 10, so no environment variable
 * can lengthen it -- while the standard queue drains on the fifteen-minute
 * reconciliation cron. A retry curve finer than the drain interval does not
 * exist, so the first design here, "enqueue it and let a worker recover it",
 * would have recovered nothing: by the first retry the code was already dead.
 *
 * The deeper reason a worker cannot do this job is that nothing in the database
 * can rebuild the message. `EmailLoginAttempt` stores an HMAC of the code and
 * of the link token and never the values, which is correct -- a plain digest of
 * a six-digit code is reversible in a million tries. Approach B was approved:
 * **the credential is not stored anywhere**, so the only place the message can
 * be sent from is the request that minted it.
 *
 * What this module therefore provides is not durability of the send. It is:
 *
 *  - a durable *record* that we tried, written in the caller's transaction;
 *  - a small, budgeted retry inside the request, for the failures that a second
 *    attempt actually fixes;
 *  - a refusal to deliver a credential that died while we were retrying;
 *  - a truthful answer to the caller, so the sign-in screen can stop claiming
 *    it sent an email it did not send.
 */

/** The one template this lane carries. Adding a second needs a reason. */
export const CREDENTIAL_TEMPLATE_KEY = AUTH_LOGIN_CODE_TEMPLATE;

export const CREDENTIAL_LANE = "credential_sync";

/**
 * The sender a login code goes out as.
 *
 * Derived from the template definition, not restated: a login code is the one
 * message where a recipient most needs to recognise the sender, and two places
 * naming it is how they come to disagree.
 */
const CREDENTIAL_SENDER_ROLE =
  emailTemplateDefinition(CREDENTIAL_TEMPLATE_KEY).senderRole;

export type CredentialEnqueueInput = {
  /** The EmailLoginAttempt this message carries a credential for. */
  attemptId: string;
  emailAddress: string;
  language: string;
  policyVersionId: string;
  templateVersionId: string;
};

/**
 * Writes the outbox rows for one credential message inside the caller's
 * transaction, and reports the ids it created.
 *
 * Runs in the caller's transaction rather than its own so the two rows land
 * with the `EmailLoginAttempt` atomically, as §9.4a-3 requires: an attempt that
 * exists without a record of the send would report a code we never tried to
 * deliver, and a record without an attempt would reference a credential that
 * was never minted.
 *
 * Ids come from the database's own defaults rather than being generated ahead
 * of time, which is why this is a function and not a list of operations -- the
 * delivery's idempotency key is derived from the event id, so the event has to
 * exist first.
 *
 * `recipientKey` is always the address form. A login request is answered
 * identically whether or not an account exists, so resolving a user id would
 * make this row the one place that knows -- and rows are readable.
 */
export async function createCredentialDeliveryRows(
  tx: Prisma.TransactionClient,
  input: CredentialEnqueueInput & { templateId: string }
): Promise<{ eventId: string; deliveryId: string; idempotencyKey: string }> {
  const event = await tx.emailEvent.create({
    data: {
      kind: "auth.login_code",
      templateId: input.templateId,
      referenceType: "EmailLoginAttempt",
      referenceId: input.attemptId,
      // The attempt id and the language, and nothing else. The code and the
      // link token are the entire content of this message, so a payload
      // carrying them would be the stored credential that approach B exists to
      // avoid.
      payload: { attemptId: input.attemptId, language: input.language },
      audienceKind: "single_user",
      status: "expanded",
    },
    select: { id: true },
  });

  const recipientKey = `addr:${input.emailAddress}`;
  const idempotencyKey = `${event.id}:${recipientKey}`;

  const delivery = await tx.emailDelivery.create({
    data: {
      eventId: event.id,
      userId: null,
      recipientKey,
      lane: CREDENTIAL_LANE,
      emailAddress: input.emailAddress,
      language: input.language,
      // A login code is answered identically whether or not an account
      // exists, so resolving a jurisdiction here would make this row the one
      // place that knows. Transactional mail branches on no jurisdiction rule
      // anyway -- no advertising label, no quiet hours -- so `ZZ` costs it
      // nothing (§6.3).
      jurisdictionCountry: "ZZ",
      jurisdictionProfileKey: "ZZ",
      policyVersionId: input.policyVersionId,
      templateVersionId: input.templateVersionId,
      idempotencyKey,
      status: "pending",
      attempts: 0,
    },
    select: { id: true },
  });

  return { eventId: event.id, deliveryId: delivery.id, idempotencyKey };
}

export type CredentialSendResult =
  | { sent: true; providerMessageId: string | null }
  | { sent: false; reason: "credential_expired" }
  /**
   * The address cannot receive mail at all -- a hard bounce, or an operator or
   * data-subject decision. A spam complaint does not produce this: see §13.3.
   */
  | { sent: false; reason: "suppressed"; skipReason: string }
  | { sent: false; reason: "send_failed"; errorKind: string };

/**
 * Sends the message inside the request, retrying only what a retry fixes.
 *
 * Re-reads the attempt before every attempt, not once at the start: a message
 * that waited out a 700ms backoff may now be carrying a code that expired, was
 * consumed by the sign-in link, or was superseded by a newer request. A login
 * code that arrives dead is worse than one that never arrives -- the recipient
 * types it, is refused, and concludes the account is broken.
 */
export async function sendCredentialEmailNow(input: {
  deliveryId: string;
  attemptId: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<CredentialSendResult> {
  const now = input.now ?? (() => Date.now());
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // Checked once, before the first attempt, so a mailbox that cannot receive
  // anything costs no provider call. A hard bounce means the mailbox does not
  // exist, so no amount of retrying inside this request reaches it -- and a
  // complaint deliberately does *not* stop this lane, because refusing to send
  // a login code to someone who reported a newsletter locks them out of the
  // account they were trying to leave (§13.3).
  //
  // It is not the decision each attempt is made on: this lane retries for up
  // to three seconds, and a privacy request committed during that window has
  // to stop the next attempt. Every attempt below re-asks under the address
  // lock (lib/emailSendLock.ts).
  const verdict = await suppressionCheck({
    emailAddress: input.to,
    classification: "transactional",
    now: new Date(now()),
  });
  if (!verdict.allowed) {
    await prisma.emailDelivery.update({
      where: { id: input.deliveryId },
      data: {
        status: "suppressed",
        skipReason: verdict.skipReason,
        lastAttemptAt: new Date(now()),
      },
    });
    return { sent: false, reason: "suppressed", skipReason: verdict.skipReason };
  }

  const startedAt = now();
  const renderedHash = renderedBodyHash(input);

  let attemptsMade = 0;
  let lastErrorKind = "unknown";
  let retryAfterMs: number | undefined;

  for (;;) {
    const decision = nextCredentialSendAttempt({
      attemptsMade,
      elapsedMs: now() - startedAt,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
    if (!decision.retry) break;
    if (decision.delayMs > 0) await sleep(decision.delayMs);

    const credential = await prisma.emailLoginAttempt.findUnique({
      where: { id: input.attemptId },
      select: { expiresAt: true, consumedAt: true, invalidatedAt: true },
    });
    if (
      !credential ||
      !isCredentialStillSendable({ ...credential, now: new Date(now()) })
    ) {
      await prisma.emailDelivery.update({
        where: { id: input.deliveryId },
        data: {
          status: "skipped",
          skipReason: "credential_expired",
          attempts: attemptsMade,
          lastAttemptAt: new Date(now()),
        },
      });
      return { sent: false, reason: "credential_expired" };
    }

    attemptsMade += 1;
    retryAfterMs = undefined;

    // The address lock, the last suppression word and this attempt, in one
    // scope (docs/policy/email-product-news-redesign-draft.md section 7.4).
    // The waits are this lane's own: 300ms for the lock and whatever is left
    // of the three-second request budget for the provider, so a busy address
    // costs a retry rather than the person's sign-in.
    const submitted = await sendWithAddressLock({
      emailAddress: input.to,
      classification: "transactional",
      now: new Date(now()),
      lockTimeoutMs: CREDENTIAL_SEND_LOCK_TIMEOUT_MS,
      // Long enough to outlast what it protects -- the lock wait and the one
      // attempt it admits -- both of which are already inside the request
      // budget. A transaction that expired first would abandon a submission
      // that had already reached the provider.
      transactionTimeoutMs:
        CREDENTIAL_SEND_LOCK_TIMEOUT_MS + decision.timeoutMs + 500,
      submit: async () => {
        // Recomputed now the lock is held: waiting for it spent part of the
        // budget this timeout was cut from. The reserve leaves the transaction
        // room to commit after the provider answers.
        const remaining =
          CREDENTIAL_SEND_BUDGET_MS - (now() - startedAt) - CREDENTIAL_SEND_RESERVE_MS;
        // The budget went while we waited for the address. Starting a request
        // that cannot finish inside it would put a message on the wire after
        // the person has already been told the sign-in failed.
        if (remaining <= 0) return { expired: true } as const;
        return {
          expired: false,
          response: await deliverEmailOnce({
            to: input.to,
            subject: input.subject,
            html: input.html,
            text: input.text,
            idempotencyKey: input.idempotencyKey,
            timeoutMs: Math.min(decision.timeoutMs, remaining),
            // Read from the one template this lane carries rather than written
            // here. Every attempt inside this request, and the record of it,
            // then names the same sender as the standard lane would for the
            // same template (docs/policy/email-notifications.md §14.1a).
            senderRole: CREDENTIAL_SENDER_ROLE,
          }),
        } as const;
      },
    });

    if (submitted.ok === false && submitted.reason === "lock_unavailable") {
      // A writer holds the address. Nothing was submitted, so this is an
      // attempt that can be made again inside the budget -- the loop decides
      // whether there is room for it (section 7.4, time budgets).
      lastErrorKind = "send_lock_unavailable";
      continue;
    }

    if (submitted.ok === false) {
      // A suppression committed while this request was retrying: a privacy
      // request or an operator stop, the two this lane honours mid-flight.
      await prisma.emailDelivery.update({
        where: { id: input.deliveryId },
        data: {
          status: "suppressed",
          skipReason: submitted.skipReason,
          attempts: attemptsMade,
          lastAttemptAt: new Date(now()),
        },
      });
      return { sent: false, reason: "suppressed", skipReason: submitted.skipReason };
    }

    if (submitted.value.expired) {
      // Nothing was submitted and there is no room for another attempt. The
      // loop would refuse the next one anyway; saying so here keeps the reason
      // truthful rather than reporting a provider timeout we never made.
      lastErrorKind = "budget_exhausted";
      break;
    }

    if (submitted.raiseIncident === "transactional_complaint") {
      // The verdict taken under the lock, so a complaint recorded while this
      // request was retrying is still reported. The code goes out either way --
      // withholding it would lock the account holder out (§13.3).
      await reportOperationalIncident({
        code: "EMAIL_TRANSACTIONAL_COMPLAINT_SEND",
        title: "Sending to an address that reported transactional mail as spam",
        error:
          "A login code is going out anyway -- withholding it would lock the " +
          "account holder out -- but the complaint needs a person to look at it.",
        severity: "warning",
        cooldownMs: 60 * 60 * 1_000,
        context: { component: "credential-email-lane", classification: "transactional" },
      });
    }

    const response = submitted.value.response;

    const outcome: ProviderSendOutcome = response.ok
      ? { kind: "delivered", providerMessageId: response.providerMessageId }
      : response.notConfigured
        ? { kind: "permanent", errorKind: "not_configured" }
        : response.status === null
        ? classifyTransportError(response.transportError)
        : classifyProviderStatus(response.status, {
            ...(response.retryAfterMs === undefined
              ? {}
              : { retryAfterMs: response.retryAfterMs }),
          });

    if (outcome.kind === "delivered") {
      // Both axes and the address the provider accepted. Nothing here that
      // could carry the credential: the code and the link token are the entire
      // content of this message and neither the subject nor the body is logged
      // (docs/policy/email-notifications.md §14.1a, §10.3).
      console.info(
        JSON.stringify({
          event: "credential_email_sent",
          deliveryId: input.deliveryId,
          templateKey: CREDENTIAL_TEMPLATE_KEY,
          stream: "transactional",
          senderRole: CREDENTIAL_SENDER_ROLE,
          ...(response.ok ? { from: response.from } : {}),
          attempts: attemptsMade,
        })
      );
      await prisma.emailDelivery.update({
        where: { id: input.deliveryId },
        data: {
          status: "sent",
          attempts: attemptsMade,
          lastAttemptAt: new Date(now()),
          sentAt: new Date(now()),
          providerMessageId: outcome.providerMessageId,
          renderedSubject: input.subject,
          renderedHash,
          renderedHashKeyVersion: EMAIL_AUDIT_HASH_KEY_VERSION,
          // Fixed at send: the account and the identity the provider accepted.
          providerAccount: "transactional",
          ...(response.ok
            ? { sentFrom: response.from, sentDomain: sentDomainOf(response.from) }
            : {}),
        },
      });
      return { sent: true, providerMessageId: outcome.providerMessageId };
    }

    lastErrorKind = outcome.errorKind;

    if (outcome.kind === "permanent") {
      const status = response.ok ? null : response.status;

      if (status !== null && isProviderAuthFailure(status)) {
        // Never the user's fault and never self-healing. Raised here rather
        // than left to a failure-rate alarm because every sign-in is broken
        // until someone fixes the key.
        await reportOperationalIncident({
          code: "EMAIL_PROVIDER_AUTH_FAILED",
          title: "The mail provider rejected our credentials",
          error: `Login code send refused with ${outcome.errorKind}`,
          severity: "error",
          context: { component: "credential-email-lane" },
        });
      }

      const suppressed =
        status !== null && SUPPRESSION_REFUSAL_STATUSES.has(status);

      await prisma.emailDelivery.update({
        where: { id: input.deliveryId },
        data: {
          // A provider-side suppression is not a failure of ours; it is a
          // decision already made about this address, and §5.3.1 is why it can
          // reach transactional mail at all.
          status: suppressed ? "suppressed" : "failed",
          ...(suppressed ? { skipReason: "suppressed_complaint" } : {}),
          attempts: attemptsMade,
          lastAttemptAt: new Date(now()),
          lastErrorKind: outcome.errorKind,
        },
      });
      return { sent: false, reason: "send_failed", errorKind: outcome.errorKind };
    }

    retryAfterMs = outcome.retryAfterMs;
  }

  await prisma.emailDelivery.update({
    where: { id: input.deliveryId },
    data: {
      status: "failed",
      attempts: attemptsMade,
      lastAttemptAt: new Date(now()),
      lastErrorKind,
    },
  });
  return { sent: false, reason: "send_failed", errorKind: lastErrorKind };
}

/**
 * Closes out credential rows whose credential has since died.
 *
 * Only rows the request could not finish reach this: a process killed between
 * the transaction and the send leaves `pending`, and nothing else will ever
 * pick it up. Left alone they would sit in the console as sends still waiting
 * to happen, which is the opposite of what this lane promises.
 *
 * It does not resend. There is nothing to resend from.
 */
export async function sweepExpiredCredentialDeliveries(options?: {
  now?: Date;
  limit?: number;
}) {
  const now = options?.now ?? new Date();
  const stale = await prisma.emailDelivery.findMany({
    where: {
      lane: CREDENTIAL_LANE,
      status: "pending",
      event: {
        referenceType: "EmailLoginAttempt",
      },
      createdAt: { lt: new Date(now.getTime() - 60_000) },
    },
    select: { id: true, event: { select: { referenceId: true } } },
    take: options?.limit ?? 500,
    orderBy: { createdAt: "asc" },
  });
  if (stale.length === 0) return { swept: 0 };

  const attemptIds = stale
    .map((row) => row.event.referenceId)
    .filter((value): value is string => Boolean(value));
  const live = await prisma.emailLoginAttempt.findMany({
    where: {
      id: { in: attemptIds },
      consumedAt: null,
      invalidatedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true },
  });
  const liveIds = new Set(live.map((row) => row.id));

  const expired = stale.filter(
    (row) => !row.event.referenceId || !liveIds.has(row.event.referenceId)
  );
  if (expired.length === 0) return { swept: 0 };

  const result = await prisma.emailDelivery.updateMany({
    where: { id: { in: expired.map((row) => row.id) }, status: "pending" },
    data: {
      status: "skipped",
      skipReason: "credential_expired",
      lastAttemptAt: now,
    },
  });
  return { swept: result.count };
}
