import "server-only";

import { createHash, createHmac } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { deliverEmailOnce } from "@/lib/email";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import {
  classifyProviderStatus,
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
 * Contract: .github/audits/email-notification-architecture-2026-08-21.md §9.4a.
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
export const CREDENTIAL_TEMPLATE_KEY = "auth_login_code";

export const CREDENTIAL_LANE = "credential_sync";

/**
 * Stand-ins used to register the template, never to send.
 *
 * The registry stores the template, not the message: hashing a rendered login
 * code would mint a new TemplateVersion on every sign-in and fill the table
 * with one row per request. Rendering with these placeholders yields the copy
 * with its variables still in place, which is both hash-stable and a truthful
 * artefact of what shipped.
 */
export const CREDENTIAL_TEMPLATE_PLACEHOLDERS = {
  code: "{{code}}",
  verifyUrl: "{{verifyUrl}}",
} as const;

const BOOTSTRAP_POLICY_VERSION = "2026-08-21.1";

/**
 * The key the audit hash is computed with.
 *
 * Separate from `NEXTAUTH_SECRET` because the two rotate for different reasons
 * and on different clocks: rotating the auth secret signs everyone out, while
 * rotating this one must never invalidate a record -- which is why the version
 * that produced each hash is stored beside it and old versions stay readable
 * for as long as the record does (§10.3-7).
 */
const auditHashKey = () => {
  const value =
    process.env.EMAIL_AUDIT_HASH_KEY || process.env.NEXTAUTH_SECRET || "";
  if (!value) throw new Error("EMAIL_AUDIT_HASH_KEY is not configured.");
  return value;
};

export const EMAIL_AUDIT_HASH_KEY_VERSION =
  process.env.EMAIL_AUDIT_HASH_KEY_VERSION || "v1";

/**
 * Keyed, not plain.
 *
 * The body being hashed contains the six-digit code, and a digest of it is a
 * million guesses away from the code itself -- so an audit column would become
 * the thing an attacker reads. lib/emailLogin.ts already establishes the
 * pattern with `createHmac("sha256", secret())`; this follows it, and applies
 * it on every lane rather than only where a credential is expected, because a
 * rule that depends on classifying the message correctly fails on the day the
 * classification is wrong.
 */
export const renderedBodyHash = (parts: {
  subject: string;
  html: string;
  text: string;
}) =>
  createHmac("sha256", auditHashKey())
    .update(`${parts.subject}\n${parts.html}\n${parts.text}`)
    .digest("hex");

/**
 * Prisma reports a unique-constraint conflict as P2002 regardless of which
 * index caught it, which is all the caller below needs to know.
 */
const isUniqueViolation = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === "P2002";

/** Unkeyed on purpose: this detects template drift, it guards nothing. */
const templateContentHash = (parts: {
  subject: string;
  html: string;
  text: string;
}) =>
  createHash("sha256")
    .update(`${parts.subject}\n${parts.html}\n${parts.text}`)
    .digest("hex");

/**
 * The policy version deliveries resolve against.
 *
 * Bootstrap only: it carries no jurisdiction profile beyond the fallback,
 * because transactional mail branches on none of them -- no advertising label,
 * no unsubscribe SLA, no quiet hours. The eight real profiles arrive with M7 as
 * a *new* version that a human approves, which is the only way a policy version
 * is ever supposed to become active (§12.5). This one exists so the delivery
 * row has something truthful to point at in the meantime.
 */
export async function ensureBootstrapPolicyVersion(): Promise<string> {
  const active = await prisma.emailPolicyVersion.findFirst({
    where: { status: "active" },
    select: { id: true },
  });
  if (active) return active.id;

  const created = await prisma.emailPolicyVersion.upsert({
    where: { version: BOOTSTRAP_POLICY_VERSION },
    update: {},
    create: {
      version: BOOTSTRAP_POLICY_VERSION,
      status: "active",
      activatedAt: new Date(),
      changeSummary:
        "Bootstrap: transactional-only. Jurisdiction profiles land with M7 " +
        "as a separately approved version.",
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * The published TemplateVersion for this template and language, creating it if
 * the copy in code has no matching row yet.
 *
 * Published versions are immutable, so a changed template is a *new* version
 * rather than an update. That is deliberate, and it is the difference between
 * this and the seeding pattern AGENTS.md warns about with `creditWeight`: there,
 * `skipDuplicates` left existing rows holding a value the code no longer said,
 * and nothing reported the divergence. Here the content hash is part of the
 * lookup, so code that has moved on cannot silently keep pointing at the old
 * row -- it gets a new one, and the deliveries that referenced the old version
 * still render what they actually sent.
 */
export async function ensureCredentialTemplateVersion(input: {
  language: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ templateId: string; templateVersionId: string }> {
  const contentHash = templateContentHash(input);

  const template = await prisma.emailTemplate.upsert({
    where: { key: CREDENTIAL_TEMPLATE_KEY },
    update: {},
    create: {
      key: CREDENTIAL_TEMPLATE_KEY,
      classification: "transactional",
      // Null, and the database insists on it: a login code is not gated by a
      // preference, and giving it one would imply it could be switched off.
      purpose: null,
      requiresUnsubscribe: false,
    },
    select: { id: true },
  });

  const existing = await prisma.templateVersion.findFirst({
    where: {
      templateId: template.id,
      language: input.language,
      contentHash,
      status: "published",
    },
    select: { id: true },
  });
  if (existing) {
    return { templateId: template.id, templateVersionId: existing.id };
  }

  const latest = await prisma.templateVersion.findFirst({
    where: { templateId: template.id, language: input.language },
    orderBy: { version: "desc" },
    select: { version: true },
  });

  try {
    const created = await prisma.templateVersion.create({
      data: {
        templateId: template.id,
        language: input.language,
        version: (latest?.version ?? 0) + 1,
        subject: input.subject,
        bodyHtml: input.html,
        bodyText: input.text,
        contentHash,
        status: "published",
        publishedAt: new Date(),
      },
      select: { id: true },
    });
    return { templateId: template.id, templateVersionId: created.id };
  } catch (error) {
    // Two sign-ins arriving together after a copy change both read the same
    // `latest` and both try to write version N+1; the unique index lets one
    // through. Losing that race is not an error -- the row the winner wrote is
    // the row this caller wanted -- so it is read back rather than propagated.
    // Left unhandled it would surface as a failed login, which is a spectacular
    // consequence for two people signing in at the same moment.
    if (!isUniqueViolation(error)) throw error;
    const raced = await prisma.templateVersion.findFirst({
      where: {
        templateId: template.id,
        language: input.language,
        contentHash,
        status: "published",
      },
      select: { id: true },
    });
    if (!raced) throw error;
    return { templateId: template.id, templateVersionId: raced.id };
  }
}

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
      // Transactional mail branches on no jurisdiction rule, so the fallback
      // profile is the honest answer rather than a guess (§6.3).
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

    const response = await deliverEmailOnce({
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      idempotencyKey: input.idempotencyKey,
      timeoutMs: decision.timeoutMs,
    });

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
