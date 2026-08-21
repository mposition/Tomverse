import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { deliverEmailOnce } from "@/lib/email";
import { isLanguage } from "@/lib/language";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import {
  decryptSnapshot,
  encryptSnapshot,
  readSnapshotKeyring,
} from "@/lib/emailSnapshotCrypto";
import {
  emailTemplateDefinition,
  type EmailClassification,
} from "@/lib/emailTemplateDefinitions";
import { ensureBootstrapPolicyVersion, ensureTemplateVersion } from "@/lib/emailTemplateRegistry";
import {
  reportProviderSuppression,
  suppressionCheck,
} from "@/lib/emailSuppression";
import { unsubscribeHeaders } from "@/lib/emailUnsubscribeHeaders";
import { jurisdictionForUser } from "@/lib/emailJurisdiction";
import { marketingJurisdictionVerdict } from "@/lib/emailJurisdictionCore";
import { streamForClassification } from "@/lib/emailSendingIdentityCore";
import { isEmailPurpose } from "@/lib/emailPreferenceCore";
import {
  EMAIL_AUDIT_HASH_KEY_VERSION,
  renderedBodyHash,
} from "@/lib/emailAuditHash";
import {
  classifyProviderStatus,
  classifyTransportError,
  isProviderAuthFailure,
  SUPPRESSION_REFUSAL_STATUSES,
  type ProviderSendOutcome,
} from "@/lib/emailSendRetryCore";
import {
  RETRY_CLASSIFICATIONS,
  STANDARD_LANE_CLAIM_TTL_MS,
  abandonmentEscalation,
  nextStandardAttempt,
} from "@/lib/standardEmailRetryCore";

/**
 * The standard lane: durable, at-least-once, delivered eventually.
 *
 * Contract: docs/policy/email-notifications.md §9.1-9.5.
 *
 * The opposite guarantee to the credential lane. There, nothing is stored and
 * nothing is retried, because a login code is dead in ten minutes and its
 * plaintext is the secret. Here the message survives the process: the outbox
 * row is written in the caller's transaction, the personalisation inputs are
 * kept (encrypted) so the drain can render the same bytes later, and a failed
 * send is tried again on a curve that runs for hours.
 *
 * What this replaces is nine fire-and-forget call sites. A welcome email, a
 * subscription receipt and a deletion notice were each one `await` with a
 * `.catch()` around it, so a provider blip lost them silently and permanently.
 * The report of the failure went to a log line nobody reads, which is the same
 * thing as no report.
 *
 * Delivery is at-least-once and the provider closes the gap: every attempt
 * presents the same idempotency key and renders from the same snapshot, so a
 * process that dies between a successful send and marking the row tries again
 * and is suppressed rather than duplicated.
 */

const snapshotKeyring = () => {
  const keyring = readSnapshotKeyring(process.env);
  if (!keyring) {
    throw new Error(
      "EMAIL_SNAPSHOT_KEYS is not configured. The standard lane stores the " +
        "personalisation inputs a message was rendered from, and storing them " +
        "unencrypted is not an option this lane offers."
    );
  }
  return keyring;
};

export type StandardEnqueueInput = {
  templateKey: string;
  /**
   * The recipient. Resolved by the caller; this lane does not look accounts up.
   *
   * Nullable because most callers hold a `User.email`, which is nullable in the
   * schema. An absent address enqueues nothing and says so by returning null --
   * quietly, because "this account has no address" is a state, not a fault.
   */
  emailAddress: string | null | undefined;
  userId?: string | null;
  language?: string | null;
  /** Everything the template's render function reads, and nothing else. */
  payload: unknown;
  referenceType?: string;
  referenceId?: string;
};

const resolveLanguage = (value: string | null | undefined) =>
  isLanguage(value) ? value : "en";

/**
 * Writes the outbox rows for one message inside the caller's transaction.
 *
 * The transaction is the whole point: a receipt row and the record of the email
 * about it have to commit together, or a crash between them loses the message
 * with no trace that it was ever owed.
 *
 * `ensureTemplateVersion` and `ensureBootstrapPolicyVersion` run *before* this,
 * outside the transaction, because they may insert and a caller's transaction
 * should not be widened by our bookkeeping. Both are idempotent.
 */
export async function createStandardDeliveryRows(
  tx: Prisma.TransactionClient,
  input: Omit<StandardEnqueueInput, "emailAddress"> & {
    emailAddress: string;
    templateId: string;
    templateVersionId: string;
    policyVersionId: string;
    language: string;
    jurisdictionCountry: string;
    jurisdictionProfileKey: string;
  }
): Promise<{ eventId: string; deliveryId: string; idempotencyKey: string }> {
  const definition = emailTemplateDefinition(input.templateKey);

  const event = await tx.emailEvent.create({
    data: {
      kind: `email.${definition.key}`,
      templateId: input.templateId,
      ...(input.referenceType ? { referenceType: input.referenceType } : {}),
      ...(input.referenceId ? { referenceId: input.referenceId } : {}),
      // A reference and the language only. The values the message is built from
      // live encrypted on the delivery row, not in the clear on the event.
      payload: {
        language: input.language,
        ...(input.referenceId ? { referenceId: input.referenceId } : {}),
      },
      audienceKind: "single_user",
      status: "expanded",
    },
    select: { id: true },
  });

  // Prefer the account form when there is an account, so one person cannot
  // acquire two recipient identities for the same event.
  const recipientKey = input.userId
    ? `user:${input.userId}`
    : `addr:${input.emailAddress}`;
  const idempotencyKey = `${event.id}:${recipientKey}`;

  const delivery = await tx.emailDelivery.create({
    data: {
      eventId: event.id,
      userId: input.userId ?? null,
      recipientKey,
      lane: "standard",
      emailAddress: input.emailAddress,
      language: input.language,
      // Pinned at enqueue so activating a new policy version mid-flight cannot
      // change what this row renders. `ZZ` when nothing resolves is the honest
      // answer rather than a guess -- it carries the business identity footer
      // and no advertising rule, which is right for the mail that sends on it.
      jurisdictionCountry: input.jurisdictionCountry,
      jurisdictionProfileKey: input.jurisdictionProfileKey,
      policyVersionId: input.policyVersionId,
      templateVersionId: input.templateVersionId,
      idempotencyKey,
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(),
      renderDataSnapshot: encryptSnapshot(input.payload, snapshotKeyring()),
    },
    select: { id: true },
  });

  return { eventId: event.id, deliveryId: delivery.id, idempotencyKey };
}

/**
 * Enqueues a message, resolving the template and policy versions first.
 *
 * `tx` is optional but strongly preferred: passing the transaction that wrote
 * the thing being announced is what makes the message durable rather than
 * merely queued. Without one the rows commit on their own, which is still
 * better than a fire-and-forget send but leaves a window where the source row
 * exists and its notification does not.
 */
export async function enqueueStandardEmail(
  input: StandardEnqueueInput & { tx?: Prisma.TransactionClient }
) {
  if (!input.emailAddress) return null;

  const language = resolveLanguage(input.language);
  const template = await ensureTemplateVersion({
    templateKey: input.templateKey,
    language,
  });
  const policyVersionId = await ensureBootstrapPolicyVersion();

  // Resolved here rather than at send time so the row records what was true
  // when the message was owed. The *marketing* gate re-checks at send time,
  // because a jurisdiction that became confirmed in between should not keep a
  // message held -- and one that became conflicted should stop it.
  const resolved = input.userId
    ? await jurisdictionForUser({ userId: input.userId })
    : null;

  const rows = {
    ...input,
    emailAddress: input.emailAddress,
    ...template,
    policyVersionId,
    language,
    jurisdictionCountry: resolved?.countryCode ?? "ZZ",
    jurisdictionProfileKey: resolved?.profileKey ?? "ZZ",
  };
  return input.tx
    ? createStandardDeliveryRows(input.tx, rows)
    : prisma.$transaction((tx) => createStandardDeliveryRows(tx, rows));
}

export type StandardDrainResult = {
  claimed: number;
  sent: number;
  failed: number;
  abandoned: number;
  suppressed: number;
  pending: number;
  /**
   * Abandonments by classification.
   *
   * A total on its own cannot be escalated correctly: §9.4 gives each
   * classification its own answer to running out of attempts, and "three
   * messages were abandoned" does not say whether a person has to be woken.
   */
  abandonedByClassification: Record<EmailClassification, number>;
};

type ClaimedDelivery = {
  id: string;
  userId: string | null;
  emailAddress: string;
  language: string;
  attempts: number;
  idempotencyKey: string;
  renderDataSnapshot: unknown;
  templateVersion: {
    template: { key: string; classification: string; requiresUnsubscribe: boolean };
  };
};

/**
 * Takes ownership of one due row.
 *
 * A conditional UPDATE rather than a read followed by a write: two workers, or
 * one worker and a retried cron invocation, would otherwise both read the same
 * `pending` row and both send it. The provider's idempotency key would suppress
 * the duplicate, but only for twenty-four hours and only when the payload
 * matches -- relying on it for concurrency control means the correctness of the
 * queue depends on a window somebody else controls.
 *
 * The stale-claim clause is what lets a killed worker's rows come back: a claim
 * older than the TTL is treated as abandoned rather than held forever.
 */
const claimDueDelivery = async (now: Date): Promise<ClaimedDelivery | null> => {
  const staleBefore = new Date(now.getTime() - STANDARD_LANE_CLAIM_TTL_MS);
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "EmailDelivery"
       SET "claimedAt" = ${now}, "lastAttemptAt" = ${now}
     WHERE "id" = (
       SELECT "id" FROM "EmailDelivery"
        WHERE "lane" = 'standard'
          AND "status" = 'pending'
          AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now})
          AND ("claimedAt" IS NULL OR "claimedAt" < ${staleBefore})
        ORDER BY "nextAttemptAt" ASC NULLS FIRST
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING "id"
  `;
  const claimedId = rows[0]?.id;
  if (!claimedId) return null;

  return prisma.emailDelivery.findUnique({
    where: { id: claimedId },
    select: {
      id: true,
      userId: true,
      emailAddress: true,
      language: true,
      attempts: true,
      idempotencyKey: true,
      renderDataSnapshot: true,
      templateVersion: {
        select: {
          template: {
            select: { key: true, classification: true, requiresUnsubscribe: true },
          },
        },
      },
    },
  }) as Promise<ClaimedDelivery | null>;
};

const recordOutcome = async (
  delivery: ClaimedDelivery,
  outcome: ProviderSendOutcome,
  context: {
    now: Date;
    attempts: number;
    classification: EmailClassification;
    rendered: { subject: string; html: string; text: string };
    status: number | null;
  }
) => {
  if (outcome.kind === "delivered") {
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "sent",
        attempts: context.attempts,
        sentAt: context.now,
        nextAttemptAt: null,
        claimedAt: null,
        providerMessageId: outcome.providerMessageId,
        renderedSubject: context.rendered.subject,
        renderedHash: renderedBodyHash(context.rendered),
        renderedHashKeyVersion: EMAIL_AUDIT_HASH_KEY_VERSION,
      },
    });
    return "sent" as const;
  }

  if (outcome.kind === "permanent") {
    if (context.status !== null && isProviderAuthFailure(context.status)) {
      await reportOperationalIncident({
        code: "EMAIL_PROVIDER_AUTH_FAILED",
        title: "The mail provider rejected our credentials",
        error: `Standard lane send refused with ${outcome.errorKind}`,
        severity: "error",
        context: { component: "standard-email-lane" },
      });
    }
    const suppressed =
      context.status !== null && SUPPRESSION_REFUSAL_STATUSES.has(context.status);
    if (suppressed) {
      // Our gate said yes and the provider said no. That gap is specific and
      // worth naming: Resend suppression is account-wide across a region, so a
      // marketing complaint can refuse a login code no matter what our list
      // says (§5.3.1).
      await reportProviderSuppression({
        emailAddress: delivery.emailAddress,
        classification: context.classification,
        deliveryId: delivery.id,
      });
    }
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: suppressed ? "suppressed" : "failed",
        ...(suppressed ? { skipReason: "suppressed_complaint" } : {}),
        attempts: context.attempts,
        lastErrorKind: outcome.errorKind,
        nextAttemptAt: null,
        claimedAt: null,
      },
    });
    return "failed" as const;
  }

  const decision = nextStandardAttempt({
    attemptsMade: context.attempts,
    classification: context.classification,
  });
  if (!decision.retry) {
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "abandoned",
        attempts: context.attempts,
        lastErrorKind: outcome.errorKind,
        nextAttemptAt: null,
        claimedAt: null,
      },
    });
    return "abandoned" as const;
  }

  await prisma.emailDelivery.update({
    where: { id: delivery.id },
    data: {
      status: "pending",
      attempts: context.attempts,
      lastErrorKind: outcome.errorKind,
      nextAttemptAt: new Date(context.now.getTime() + decision.delayMs),
      claimedAt: null,
    },
  });
  return "pending" as const;
};

/**
 * Sends one claimed row, rendering from its snapshot rather than from live
 * rows.
 *
 * Re-reading the source would render the *current* plan, name and amount, which
 * is a different message from the one this row was created for -- and on the
 * second attempt it would also break the idempotency key's promise, because the
 * key only suppresses a duplicate when the payload matches too.
 */
const sendClaimedDelivery = async (delivery: ClaimedDelivery, now: Date) => {
  const definition = emailTemplateDefinition(delivery.templateVersion.template.key);

  // Checked at send time, not at enqueue: a message queued yesterday may be for
  // an address that complained this morning, and the decision that matters is
  // the one true when it goes out.
  const verdict = await suppressionCheck({
    emailAddress: delivery.emailAddress,
    classification: definition.classification,
    purpose: definition.purpose,
    now,
  });
  if (!verdict.allowed) {
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "suppressed",
        skipReason: verdict.skipReason,
        attempts: delivery.attempts,
        nextAttemptAt: null,
        claimedAt: null,
      },
    });
    return { outcome: "suppressed" as const, classification: definition.classification };
  }
  if (verdict.raiseIncident === "transactional_complaint") {
    await reportOperationalIncident({
      code: "EMAIL_TRANSACTIONAL_COMPLAINT_SEND",
      title: "Sending to an address that reported transactional mail as spam",
      error:
        "The message is going out anyway -- withholding it would lock the " +
        "account holder out -- but the complaint needs a person to look at it.",
      severity: "warning",
      cooldownMs: 60 * 60 * 1_000,
      context: {
        component: "standard-email-lane",
        classification: definition.classification,
      },
    });
  }

  // A preference is a different question from a suppression: suppression is
  // about the mailbox, a preference is about what this person asked for. Both
  // are checked at send time, because a message queued yesterday may be for a
  // purpose switched off this morning.
  if (definition.purpose && delivery.userId && isEmailPurpose(definition.purpose)) {
    const preference = await prisma.emailPreference.findUnique({
      where: {
        userId_purpose: { userId: delivery.userId, purpose: definition.purpose },
      },
      select: { enabled: true },
    });
    if (preference && !preference.enabled) {
      await prisma.emailDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "skipped",
          skipReason: "no_consent",
          attempts: delivery.attempts,
          nextAttemptAt: null,
          claimedAt: null,
        },
      });
      return { outcome: "suppressed" as const, classification: definition.classification };
    }
  }

  // Marketing needs a confirmed jurisdiction, and nothing else consults this.
  // An inferred country is refused as firmly as an absent one: sending
  // advertising under a guessed set of labelling rules is what §6.3 declines
  // to do, and "(광고)" versus "<ADV>" is not a difference anything can split.
  if (definition.classification === "marketing") {
    const resolved = delivery.userId
      ? await jurisdictionForUser({ userId: delivery.userId })
      : null;
    const verdict = resolved
      ? marketingJurisdictionVerdict(resolved)
      : ({ allowed: false, skipReason: "jurisdiction_unconfirmed" } as const);
    if (!verdict.allowed) {
      await prisma.emailDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "skipped",
          skipReason: verdict.skipReason,
          attempts: delivery.attempts,
          nextAttemptAt: null,
          claimedAt: null,
        },
      });
      return { outcome: "suppressed" as const, classification: definition.classification };
    }
  }

  const payload = decryptSnapshot(delivery.renderDataSnapshot, snapshotKeyring());
  const rendered = definition.render(payload, delivery.language);
  const attempts = delivery.attempts + 1;

  // Only marketing carries these, and the template's own flag decides -- which
  // the database holds as a CHECK against the classification, so a message
  // cannot acquire an unsubscribe header by being sent from the wrong place.
  const headers = unsubscribeHeaders({
    requiresUnsubscribe: delivery.templateVersion.template.requiresUnsubscribe,
    userId: delivery.userId,
    purpose: definition.purpose,
    deliveryId: delivery.id,
    appUrl:
      process.env.PUBLIC_APP_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      "https://tomverse.app",
  });

  const response = await deliverEmailOnce({
    to: delivery.emailAddress,
    ...rendered,
    idempotencyKey: delivery.idempotencyKey,
    // Marketing sends from its own domain or does not send. Derived from the
    // template's classification rather than passed by the enqueuing caller,
    // for the same reason the classification itself is: a caller that could
    // choose would eventually choose wrong, and a promotion sent from the
    // transactional domain has no symptom until login codes stop arriving
    // (docs/policy/email-notifications.md §5.3, §14.1).
    stream: streamForClassification(definition.classification),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });

  if (response.ok === false && response.identityRefusal) {
    // Permanent, and reported once per delivery rather than retried: no amount
    // of waiting sets an environment variable, and the retry curve would spend
    // the message's whole budget discovering that.
    await reportOperationalIncident({
      code: "EMAIL_SENDING_IDENTITY_REFUSED",
      title: "A message was refused because its stream has no sending identity",
      severity: "error",
      error: response.identityRefusal,
      context: {
        component: "standard-email-lane",
        deliveryId: delivery.id,
        classification: definition.classification,
      },
    });
  }

  const outcome: ProviderSendOutcome = response.ok
    ? { kind: "delivered", providerMessageId: response.providerMessageId }
    : response.identityRefusal
      ? { kind: "permanent", errorKind: `identity_${response.identityRefusal.toLowerCase()}` }
      : response.notConfigured
      ? { kind: "transient", errorKind: "not_configured" }
      : response.status === null
        ? classifyTransportError(response.transportError)
        : classifyProviderStatus(response.status);

  const recorded = await recordOutcome(delivery, outcome, {
    now,
    attempts,
    classification: definition.classification,
    rendered,
    status: response.ok ? null : (response.status ?? null),
  });
  return { outcome: recorded, classification: definition.classification };
};

/**
 * One drain pass.
 *
 * `not_configured` is transient here, unlike on the credential lane. A login
 * code has ten minutes and a person waiting, so an unconfigured deployment is
 * simply a failed sign-in; a receipt has hours, so it waits for the key to be
 * installed and then arrives. The abandonment incident is what says so if the
 * key never comes.
 */
export async function drainStandardEmailDeliveries(options?: {
  limit?: number;
  timeBudgetMs?: number;
  now?: Date;
}): Promise<StandardDrainResult> {
  const limit = options?.limit ?? 50;
  const deadline = Date.now() + (options?.timeBudgetMs ?? 20_000);
  const result: StandardDrainResult = {
    claimed: 0,
    sent: 0,
    failed: 0,
    abandoned: 0,
    suppressed: 0,
    pending: 0,
    abandonedByClassification: {
      transactional: 0,
      service: 0,
      legal: 0,
      marketing: 0,
    },
  };

  while (result.claimed < limit && Date.now() < deadline) {
    const now = options?.now ?? new Date();
    const delivery = await claimDueDelivery(now);
    if (!delivery) break;
    result.claimed += 1;

    try {
      const { outcome, classification } = await sendClaimedDelivery(delivery, now);
      if (outcome === "sent") result.sent += 1;
      else if (outcome === "failed") result.failed += 1;
      else if (outcome === "abandoned") {
        result.abandoned += 1;
        result.abandonedByClassification[classification] += 1;
      } else if (outcome === "suppressed") result.suppressed += 1;
    } catch (error) {
      // A render or decrypt failure, not a provider failure. Retrying it will
      // not help -- the snapshot is what it is -- so the row stops here rather
      // than occupying the queue on a curve that cannot succeed.
      const errorKind =
        error instanceof Error ? error.name.slice(0, 40) : "render_failed";
      await prisma.emailDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "failed",
          attempts: delivery.attempts + 1,
          lastErrorKind: errorKind,
          nextAttemptAt: null,
          claimedAt: null,
        },
      });
      result.failed += 1;

      // Distinct from a provider refusal, which can simply mean a bad address.
      // This is our own bug or our own missing key -- most likely a snapshot
      // sealed under a version this deployment no longer holds -- and it will
      // silently apply to every message that follows, so it is raised the
      // moment the first one hits it rather than waiting for a failure rate to
      // become visible.
      await reportOperationalIncident({
        code: "EMAIL_RENDER_FAILED",
        title: "A queued email could not be rendered from its snapshot",
        error: `Delivery ${delivery.id} failed to render: ${errorKind}`,
        severity: "error",
        cooldownMs: 15 * 60 * 1_000,
        context: {
          component: "standard-email-lane",
          templateKey: delivery.templateVersion.template.key,
        },
      });
    }
  }

  result.pending = await prisma.emailDelivery.count({
    where: { lane: "standard", status: "pending" },
  });

  // Abandonment is the outcome nobody else notices: the account was created,
  // the subscription started, the deletion was scheduled -- the product looks
  // fine while the person was never told.
  //
  // Raised per classification rather than as one total, because §9.4 answers
  // "what happens when it runs out of attempts" per classification and a total
  // cannot carry that answer. It also keeps the cooldowns separate: they are
  // keyed by incident code, so a single code would let a marketing abandonment
  // -- the one the policy asks us to keep quiet about -- start a window that
  // swallows a legal one minutes later.
  for (const classification of RETRY_CLASSIFICATIONS) {
    const abandoned = result.abandonedByClassification[classification];
    if (abandoned === 0) continue;
    const escalation = abandonmentEscalation(classification);
    // Marketing. Counted above and carried in the drain's log line; §9.4 asks
    // for a quiet surrender, and persistence is the failure mode here.
    if (!escalation.notify) continue;
    await reportOperationalIncident({
      code: escalation.code,
      title: escalation.title,
      error: `${abandoned} ${classification} message(s) exhausted their retries`,
      severity: escalation.severity,
      cooldownMs: 30 * 60 * 1_000,
      forceNotification: escalation.forceNotification,
      context: {
        component: "standard-email-lane",
        classification,
        abandoned,
        pending: result.pending,
      },
    });
  }

  return result;
}
