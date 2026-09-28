import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { sendWithAddressLock } from "@/lib/emailSendLock";
import {
  SEND_LOCK_RETRY_MS,
  STANDARD_SEND_PROVIDER_TIMEOUT_MS,
} from "@/lib/emailSendLockCore";
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
import { templateMetadataMismatches } from "@/lib/emailTemplateMetadataCore";
import {
  normalizeSuppressionAddress,
  reportProviderSuppression,
  suppressionCheck,
} from "@/lib/emailSuppression";
import { unsubscribeHeaders, unsubscribeUrl } from "@/lib/emailUnsubscribeHeaders";
import {
  adoptUnsubscribeKeyringForUnattributedMail,
  ensureUnsubscribeKeyCanary,
} from "@/lib/emailUnsubscribeKeyRetention";
import { evaluateMarketingSendHealth } from "@/lib/marketingSendHealth";
import {
  isEmailMarketingEnabled,
  isEmailReleaseNotesEnabled,
} from "@/lib/appSettings";
import {
  ENQUEUE_REFUSAL_MESSAGE,
  marketingFlagApplies,
  releaseNotesFlagApplies,
  type EnqueueRefusal,
} from "@/lib/emailFeatureFlags";
import { readBusinessIdentity, BLOCK_ENV_VARIABLE } from "@/lib/emailBusinessIdentity";
import { composeJurisdictionalMessage } from "@/lib/emailJurisdictionComposition";
import { jurisdictionForUser } from "@/lib/emailJurisdiction";
import { marketingJurisdictionVerdict } from "@/lib/emailJurisdictionCore";
import { deferralFor } from "@/lib/emailQuietHoursCore";
import { streamForClassification } from "@/lib/emailSendingIdentityCore";
import { sentDomainOf } from "@/lib/emailSentIdentityCore";
import { consentGateVerdict, isEmailPurpose } from "@/lib/emailPreferenceCore";
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
  type RetryClassification,
} from "@/lib/standardEmailRetryCore";
import {
  VerdictUnavailableError,
  verdictRead,
  verdictRetry,
} from "@/lib/releaseNotesVerdictRetryCore";
import { releaseNotesSendAuthorization } from "@/lib/releaseNotesSendAuthorization";
import {
  recordEnqueueDecision,
  releaseNotesEnqueueDecision,
} from "@/lib/releaseNotesEnqueueDecision";
import {
  evidenceOf,
  recordProviderSubmission,
  recordSendDecision,
} from "@/lib/releaseNotesSendDecision";
import { reenqueueIsRight, skipAndReenqueue } from "@/lib/releaseNotesReenqueue";
import { releaseNotesSkipReason } from "@/lib/releaseNotesSkipReasonCore";
import { subjectLabelWaived } from "@/lib/releaseNotesDisplayRequirements";
import { EMAIL_ADDRESS_NORMALIZATION_VERSION } from "@/lib/emailSuppressionCore";
// The cohort's own digest, not the consent-link digest. The two are different
// functions -- one hex over the normalised address, the other a prefixed
// base64url -- and comparing a delivery digest from one with a member digest
// sealed by the other failed for every member, so the approved override never
// applied and each refusal was recorded as the person revoking permission.
import { approvalAddressDigest } from "@/lib/emailSendApprovalCohort";

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

export const resolveEmailLanguage = (value: string | null | undefined) =>
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

  // The first of section 7.6's two snapshots, and the pin the second one is
  // compared against.
  //
  // It does not refuse. The send does that, and it does it with the verdict
  // taken at send time -- a row refused here would leave no record of what was
  // true when the message was owed, which is the thing the enqueue snapshot
  // exists to hold. What this decides is the *pin*: the contract this message is
  // rendered to, so a duty settled or a waiver withdrawn between now and the
  // send is a difference somebody can see rather than a silent change of
  // message.
  //
  // Read outside `tx` deliberately. These are rules and profiles -- rows an
  // operator seeds, not rows this transaction is writing -- and widening a
  // caller's transaction to read them is what `ensureTemplateVersion()` running
  // before it already refuses to do.
  const releaseNotes = releaseNotesFlagApplies(definition.purpose)
    ? await releaseNotesEnqueueDecision({
        userId: input.userId ?? null,
        purpose: definition.purpose as string,
        classification: definition.classification,
        emailAddress: input.emailAddress,
        policyVersionId: input.policyVersionId,
        templateVersionId: input.templateVersionId,
      })
    : null;

  const delivery = await tx.emailDelivery.create({
    data: {
      ...(releaseNotes
        ? { displayContractHash: releaseNotes.displayContractHash }
        : {}),
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
      // For a release-notes message, the country and profile its display
      // contract was composed from -- the hash names that profile, and the send
      // renders from whatever this row pins, so the two must be the same row.
      jurisdictionCountry:
        releaseNotes?.displayProfile?.countryCode ?? input.jurisdictionCountry,
      jurisdictionProfileKey:
        releaseNotes?.displayProfile?.profileKey ?? input.jurisdictionProfileKey,
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

  if (releaseNotes) {
    await recordEnqueueDecision(tx, {
      decision: releaseNotes,
      deliveryId: delivery.id,
      userId: input.userId ?? null,
      purpose: definition.purpose as string,
      classification: definition.classification,
    });
  }

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
export type StandardEnqueueResult =
  | { refused: EnqueueRefusal; message: string }
  | { eventId: string; deliveryId: string; idempotencyKey: string };

/**
 * Whether an enqueue produced a row.
 *
 * A named guard rather than `"deliveryId" in result` at every call site: the
 * shape is a contract, and a caller reading a field off the refusal branch is
 * exactly what a bare `null` used to allow.
 */
export const enqueueRefused = (
  result: StandardEnqueueResult
): result is { refused: EnqueueRefusal; message: string } =>
  "refused" in result;

export async function enqueueStandardEmail(
  input: StandardEnqueueInput & { tx?: Prisma.TransactionClient }
): Promise<StandardEnqueueResult> {
  if (!input.emailAddress) {
    return {
      refused: "no_address",
      message: ENQUEUE_REFUSAL_MESSAGE.no_address,
    };
  }

  // First, before the template is registered and before an identity is
  // resolved (EM-05, ADR section 15.2). A row written now would sit in the
  // outbox waiting for a decision nobody has made, and the drain would send it
  // the moment somebody flipped the switch for an unrelated reason.
  //
  // This is added in front of the structural block, never in place of it: no
  // template is classified `marketing` today and `MARKETING_EMAIL_FROM` is
  // unset, and both of those refuse the send whatever this flag says.
  if (marketingFlagApplies(emailTemplateDefinition(input.templateKey).classification)) {
    if (!(await isEmailMarketingEnabled())) {
      return {
        refused: "marketing_disabled",
        message: ENQUEUE_REFUSAL_MESSAGE.marketing_disabled,
      };
    }
  }

  // And the product's own switch, which is not the same question. Marketing
  // being on says this deployment may send marketing at all; this says the
  // release-notes product may send, and it is the last step of the activation
  // order -- document in force, policy version active, readiness confirmed, then
  // this (draft section 12).
  //
  // Checked here *and* at send. A row written while it was on must not go out
  // after somebody turns it off, and a flag read only at enqueue cannot say so.
  if (releaseNotesFlagApplies(emailTemplateDefinition(input.templateKey).purpose)) {
    if (!(await isEmailReleaseNotesEnabled())) {
      return {
        refused: "release_notes_disabled",
        message: ENQUEUE_REFUSAL_MESSAGE.release_notes_disabled,
      };
    }
  }

  const language = resolveEmailLanguage(input.language);
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

/**
 * Queue depth that stops being ordinary (EM-11).
 *
 * One pass claims fifty, and the drain rides the fifteen-minute reconciliation
 * cron. Two hundred pending is therefore about an hour of catching up, which is
 * the point at which "busy" and "not keeping up" stop being the same thing.
 */
export const STANDARD_EMAIL_QUEUE_DEPTH_ALERT = 200;

/**
 * How long the oldest waiting message may have waited.
 *
 * Depth alone would miss the worse case. Two hundred messages queued a minute
 * ago is a busy morning; five that have been waiting six hours are five people
 * who never got their receipt, and the queue is shallow the whole time. This is
 * the signal that catches the second one, and it is deliberately far below the
 * point at which a message abandons -- by then it is not a warning, it is a
 * report of something already lost.
 */
export const STANDARD_EMAIL_OLDEST_PENDING_ALERT_MS = 60 * 60 * 1_000;

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
  /**
   * Age of the oldest message still waiting, or null when nothing is.
   *
   * Reported beside the count because the two answer different questions and a
   * backlog can be either shape.
   */
  oldestPendingMs: number | null;
};

type ClaimedDelivery = {
  id: string;
  userId: string | null;
  emailAddress: string;
  language: string;
  attempts: number;
  idempotencyKey: string;
  renderDataSnapshot: unknown;
  policyVersionId: string;
  jurisdictionProfileKey: string;
  jurisdictionCountry: string;
  // The generation chain, read because a release-notes send refused for a moved
  // display contract becomes a replacement rather than an ending (section 7.6).
  eventId: string;
  recipientKey: string;
  lane: string;
  generation: number;
  rootDeliveryId: string;
  displayContractHash: string | null;
  event: { referenceType: string | null; referenceId: string | null };
  templateVersion: {
    id: string;
    classification: string;
    purpose: string | null;
    requiresUnsubscribe: boolean;
    template: { key: string };
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
       SET "claimedAt" = ${now}, "lastAttemptAt" = ${now}, "deferReason" = NULL
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
      // Pinned at enqueue, read here: this is the step the pin exists for.
      policyVersionId: true,
      jurisdictionProfileKey: true,
      jurisdictionCountry: true,
      eventId: true,
      recipientKey: true,
      lane: true,
      generation: true,
      rootDeliveryId: true,
      displayContractHash: true,
      event: { select: { referenceType: true, referenceId: true } },
      templateVersion: {
        select: {
          id: true,
          classification: true,
          purpose: true,
          requiresUnsubscribe: true,
          template: { select: { key: true } },
        },
      },
    },
  }) as Promise<ClaimedDelivery | null>;
};

/**
 * Writes `providerSubmittedAt` on the send-phase verdict of a message that went.
 *
 * After the delivery is marked `sent`, and in its own statement, deliberately.
 * The delivery row is what stops a second send; the ledger column is the record
 * of the first. Putting both in one transaction would let a failure of the
 * record roll back the fact that the message went, and the next drain would send
 * it again -- trading a gap in a record for a duplicate in somebody's inbox.
 *
 * So a failure here is reported and not thrown. What it leaves is a sealed,
 * allowed verdict with no submission time beside a delivery that says `sent`,
 * which is readable; the other order is not.
 */
const recordReleaseNotesSubmission = async (deliveryId: string) => {
  try {
    const recorded = await recordProviderSubmission(prisma, {
      deliveryId,
      at: new Date(),
    });
    if (recorded) return;
    // Sent with no allowed, sealed send-phase verdict to record it on. The gate
    // runs before every release-notes send, so this is a defect in the gate's
    // wiring rather than a race, and it is the one thing the ledger exists to
    // make impossible to miss.
    await reportOperationalIncident({
      code: "EMAIL_SEND_WITHOUT_VERDICT",
      title: "A release-notes message was sent with no send verdict to record it on",
      severity: "error",
      error: `Delivery ${deliveryId} was accepted by the provider and has no allowed send-phase decision.`,
      context: { component: "standard-email-lane", deliveryId },
    });
  } catch (error) {
    await reportOperationalIncident({
      code: "EMAIL_SUBMISSION_NOT_RECORDED",
      title: "A sent release-notes message has no submission time in the ledger",
      severity: "warning",
      error: `Delivery ${deliveryId}: ${error instanceof Error ? error.message : String(error)}`,
      cooldownMs: 15 * 60 * 1_000,
      context: { component: "standard-email-lane", deliveryId },
    });
  }
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
    /** Recorded on a successful send only; see §11.4. */
    unsubscribeKeyVersion?: string | null;
    /** The account and From the provider accepted, fixed on a successful send. */
    providerAccount?: string | null;
    sentFrom?: string | null;
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
        deferReason: null,
        providerMessageId: outcome.providerMessageId,
        renderedSubject: context.rendered.subject,
        renderedHash: renderedBodyHash(context.rendered),
        renderedHashKeyVersion: EMAIL_AUDIT_HASH_KEY_VERSION,
        unsubscribeKeyVersion: context.unsubscribeKeyVersion ?? null,
        providerAccount: context.providerAccount ?? null,
        sentFrom: context.sentFrom ?? null,
        sentDomain: sentDomainOf(context.sentFrom),
      },
    });
    if (releaseNotesFlagApplies(delivery.templateVersion.purpose)) {
      await recordReleaseNotesSubmission(delivery.id);
    }
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
        deferReason: null,
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
        deferReason: null,
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
      deferReason: null,
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
/**
 * Defers a claimed marketing delivery past a night-time window, if one applies.
 *
 * Returns true when the row was put back to wait. Pending, attempt count
 * untouched: waiting for the morning is not a failed attempt. A window that
 * cannot be read holds the message an hour rather than sending at an hour the
 * rule might forbid, and says so -- once per profile per cooldown, not once per
 * delivery, so a malformed policy row does not become an incident per recipient.
 */
const holdForQuietHours = async (
  delivery: ClaimedDelivery,
  windows: Array<{ profileKey: string; quietHours: unknown }>,
  at: Date
): Promise<boolean> => {
  const verdict = deferralFor(windows, at);
  let until: Date | null = null;
  if ("invalid" in verdict) {
    await reportOperationalIncident({
      code: "EMAIL_QUIET_HOURS_UNREADABLE",
      title: "Marketing is being held because a profile's quiet hours cannot be read",
      severity: "error",
      error: `Profile ${verdict.invalid} in policy ${delivery.policyVersionId} has malformed quietHours.`,
      cooldownMs: 60 * 60 * 1_000,
      context: {
        component: "standard-email-lane",
        profileKey: verdict.invalid,
        policyVersionId: delivery.policyVersionId,
      },
    });
    until = new Date(at.getTime() + 60 * 60 * 1_000);
  } else {
    until = verdict.until;
  }
  if (!until) return false;
  await prisma.emailDelivery.update({
    where: { id: delivery.id },
    data: { nextAttemptAt: until, claimedAt: null, deferReason: "quiet_hours" },
  });
  return true;
};

/**
 * Replaces each secret with a fixed placeholder, longest first so a secret
 * that contains another is removed whole. Used only for what is recorded --
 * the subject and the audit hash -- never for what is sent.
 */
const redactSecrets = (
  message: { subject: string; html: string; text: string },
  secrets: string[]
) => {
  if (secrets.length === 0) return message;
  const ordered = [...secrets].filter(Boolean).sort((l, r) => r.length - l.length);
  const scrub = (value: string) =>
    ordered.reduce((text, secret) => text.split(secret).join("{{secret}}"), value);
  return { subject: scrub(message.subject), html: scrub(message.html), text: scrub(message.text) };
};

/**
 * The release-notes verdict at send time, and what it does to the row.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.6.
 *
 * Returns `null` when the send may go on, and an outcome when the row is
 * finished here. Not a boolean: the caller has to return the same shape the
 * other gates return, and a boolean would leave it to invent one.
 *
 * ## One transaction
 *
 * The snapshot, the skip and any replacement are written together. Section 7.6
 * asks for the skip and the replacement to be atomic, and the snapshot belongs
 * with them for the same reason: a decision record that survived a rollback of
 * the thing it decided would describe a message that never stopped.
 */
/**
 * Another worker finished this row between our claim and our transaction.
 *
 * Only reachable through an expired claim -- `claimDueDelivery()` takes rows
 * with `FOR UPDATE SKIP LOCKED` and a conditional update, so two workers hold
 * one row only when the first one's claim went stale and the second took it.
 * That worker has already given the row a terminal state, and this one must not
 * write over it: the decision that ended the message is theirs.
 *
 * Thrown so the transaction rolls back, which is the point -- the verdict
 * snapshot inside it describes a send that did not happen.
 */
class ReenqueueRaceError extends Error {
  constructor(readonly reason: "already_superseded" | "not_pending") {
    super(`the delivery was ${reason} when the replacement was written`);
    this.name = "ReenqueueRaceError";
  }
}

const decideReleaseNotesSend = async (
  delivery: ClaimedDelivery,
  definition: { purpose: string | null; classification: EmailClassification },
  now: Date
): Promise<ReleaseNotesSendOutcome> => {
  const purpose = definition.purpose;
  // Unreachable through `releaseNotesFlagApplies()`, which answers false for a
  // null purpose. Narrowed rather than asserted, so a future caller that asked
  // without the flag check gets a refusal instead of a thrown lane.
  if (purpose === null) return { finished: null, suppressSubjectPrefix: false };

  const normalizedAddress = normalizeSuppressionAddress(delivery.emailAddress);
  // The account's address as it is now, which the cohort comparison needs
  // alongside the one this row was addressed to. A member whose account address
  // has moved since the approval was sealed is not the person that approval
  // named (section 5.6).
  //
  // Both this read and the template resolution below go through
  // `verdictRead()`, like every read inside the authorization. They are inputs
  // to the verdict -- the address to the cohort comparison, the template id to
  // the hash -- and a connection reset on either one otherwise reached the
  // drain's ordinary catch and closed the row as a permanent `failed`, which is
  // the outcome invariant 11 exists to prevent.
  const account = delivery.userId
    ? await verdictRead("the account address", () =>
        prisma.user.findUnique({
          where: { id: delivery.userId as string },
          select: { email: true },
        })
      )
    : null;

  // The template version *now*, which is what a replacement would render with
  // and therefore what the required contract has to be computed against
  // (section 7.6 puts the id inside the hash). Resolved before the transaction
  // because it may insert, and a caller's transaction should not be widened by
  // our bookkeeping -- the same reason `createStandardDeliveryRows()` has it
  // resolved before it starts.
  //
  // Using the pinned id here instead would have made a new template version
  // unable to reach a queued message *and* unable to move the hash that would
  // have re-enqueued it, which is a template correction that silently applies
  // to nothing already owed.
  const current = await verdictRead("the current template version", () =>
    ensureTemplateVersion({
      templateKey: delivery.templateVersion.template.key,
      language: delivery.language,
    })
  );

  const { verdict, displayProfile } = await releaseNotesSendAuthorization({
    userId: delivery.userId,
    purpose,
    deliveryAddressDigest: approvalAddressDigest(normalizedAddress),
    currentAddressDigest: account?.email
      ? approvalAddressDigest(account.email)
      : null,
    // The version this row was pinned to, not the active one: the lane composes
    // a queued message under the version that message carries (EM-04).
    pinnedPolicyVersionId: delivery.policyVersionId,
    pinnedDisplayContractHash: delivery.displayContractHash,
    templateVersionId: current.templateVersionId,
    // Already asked, a few gates above, and the row would have ended there.
    suppressed: false,
    normalizedAddress,
    phase: "send",
    now,
  });

  const skipReason = releaseNotesSkipReason(verdict);

  const finished = await runDecisionTransaction(delivery, async (tx) => {
    const recorded = await recordSendDecision(tx, {
      deliveryId: delivery.id,
      userId: delivery.userId,
      phase: "send",
      purpose,
      classification: definition.classification,
      emailAddress: normalizedAddress,
      addressNormalizationVersion: EMAIL_ADDRESS_NORMALIZATION_VERSION,
      verdict,
      countryCandidates: verdict.countries,
      // Not before the verdict: submission requires `suppressionCheckedAt >=
      // evaluatedAt`, and the verdict may be dated to the consent it cites. The
      // suppression check the send actually rests on is taken again under the
      // address lock immediately before the provider call, which is later still.
      suppressionCheckedAt: verdict.evaluatedAt > now ? verdict.evaluatedAt : now,
      providerSubmittedAt: null,
      evidence: evidenceOf(verdict),
    });

    // A retry of a delivery whose send verdict is already sealed: an earlier
    // attempt committed its decision and stopped before the provider call. The
    // ledger holds one send decision per delivery, so this attempt may act only
    // on a verdict that agrees with it -- on whether it goes *and* on what it
    // rests on. Where they disagree it throws, the transaction rolls back, and
    // the drain retries on the verdict-unavailable curve: if the difference was
    // transient the next attempt agrees and proceeds, and if it is not the row
    // is abandoned with an incident, which is a person looking at it rather than
    // a message sent under a decision the ledger does not hold.
    //
    // Three cases, not one. A disagreement that *allows* on a different basis is
    // the one that must not send: it throws. A disagreement that *refuses* is the
    // world having moved -- a country closed, the switch turned off -- and the
    // safe answer is not to send, which the skip below does; the ledger then
    // holds an allowed decision with no provider submission beside a skipped
    // delivery, which reads as exactly what happened. And a disagreement whose
    // only blocker is a moved display contract still goes to the re-enqueue, so
    // a template corrected while the message waited on a provider back-off still
    // reaches it -- the replacement is a new delivery with its own decisions.
    if (!recorded.recorded && recorded.differs && verdict.allowed) {
      throw new Error(
        `the sealed send decision ${recorded.decisionId} allowed this on a basis the verdict taken now does not`
      );
    }

    if (verdict.allowed) return false;

    // The contract moved and nothing else did: the message is still owed, so it
    // is re-rendered under the current template and the current contract rather
    // than ended. Any second blocker and this is an ending -- the replacement
    // would be refused for that second reason, and it would be a second row
    // addressed to somebody who asked for nothing.
    if (reenqueueIsRight(verdict.blockers)) {
      const required = verdict.displayContract.requiredDisplayContractHash;
      // `reenqueueIsRight()` already implies this: an uncomposable contract is
      // `display_unsatisfiable`, which is a different blocker. Read rather than
      // assumed, because the replacement's idempotency key is built from it and
      // a null there would be a key that means nothing.
      // `displayProfile` is non-null exactly when `required` is: both come from
      // one composed contract. Checked together so a replacement can never be
      // written with one and not the other.
      if (required !== null && displayProfile !== null) {
        const replaced = await skipAndReenqueue(tx, {
          delivery: {
            id: delivery.id,
            eventId: delivery.eventId,
            recipientKey: delivery.recipientKey,
            userId: delivery.userId,
            emailAddress: delivery.emailAddress,
            language: delivery.language,
            lane: delivery.lane,
            generation: delivery.generation,
            rootDeliveryId: delivery.rootDeliveryId,
            attempts: delivery.attempts,
            // The message itself. Left out, the replacement cannot render at
            // all, `decryptSnapshot()` throws, and the drain's ordinary catch
            // closes it as a permanent `failed` -- so the one path that exists
            // to keep a message alive would have been the one that lost it.
            renderDataSnapshot: delivery.renderDataSnapshot as Prisma.InputJsonValue,
          },
          current: {
            templateVersionId: current.templateVersionId,
            policyVersionId: delivery.policyVersionId,
            // The profile the new contract was composed from, not the one the
            // predecessor pinned. The hash names this profile and the next drain
            // renders from whatever the row pins, so copying the old pin gave a
            // recipient who moved from Australia to Korea the Korean hash and
            // the Australian footer -- equal hashes, `satisfied: true`, and no
            // telephone number.
            jurisdictionCountry: displayProfile.countryCode,
            jurisdictionProfileKey: displayProfile.profileKey,
            displayContractHash: required,
          },
        });
        // A report, not a throw, and therefore something to act on. `not_pending`
        // means another worker finished this row between the claim and here, and
        // `already_superseded` means it produced the replacement. Either way this
        // row is somebody else's now: rolling back leaves it exactly as that
        // worker left it, whereas committing would write a second verdict over
        // the decision that actually ended it.
        if (!replaced.reenqueued) {
          throw new ReenqueueRaceError(replaced.reason);
        }
        return true;
      }
    }

    await tx.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "skipped",
        skipReason,
        attempts: delivery.attempts,
        nextAttemptAt: null,
        claimedAt: null,
      },
    });
    return true;
  });

  if (finished === "raced") {
    // Nothing is written, including no claim release: the row already has the
    // state the other worker gave it, and clearing `claimedAt` on a terminal row
    // would only invite a third pass. Reported as `pending` because this pass
    // did not finish it and will not claim it did -- the next pass finds nothing
    // due and the count corrects itself.
    return {
      finished: { outcome: "pending" as const, classification: definition.classification },
    };
  }
  if (finished) {
    return {
      finished: { outcome: "suppressed" as const, classification: definition.classification },
    };
  }

  // Allowed, and carrying the one thing the composition cannot work out for
  // itself. Section 7.7 records an exemption rather than seeding it away, so the
  // profile still holds the prefix and only the duty state says whether to print
  // it -- a composition reading the profile alone would put the label on a
  // message the approval exempted.
  return {
    finished: null,
    suppressSubjectPrefix: subjectLabelWaived(verdict.obligations),
  };
};

/**
 * What the release-notes gate hands back.
 *
 * Two shapes rather than a nullable outcome, because an allowed send is not an
 * absence of a decision: it carries the subject-label exemption the composition
 * needs, and a `null` would have left the caller to work that out from rows it
 * has not read.
 */
type ReleaseNotesSendOutcome =
  | { finished: { outcome: "suppressed" | "pending"; classification: EmailClassification } }
  | { finished: null; suppressSubjectPrefix: boolean };

/**
 * The decision transaction, with the one race it can lose turned into a value.
 *
 * Separate from the body so the rollback and the reporting are in one place: a
 * `catch` inside the transaction callback would swallow the error *and* commit
 * the snapshot the rollback exists to discard.
 */
const runDecisionTransaction = async (
  delivery: ClaimedDelivery,
  body: (tx: Prisma.TransactionClient) => Promise<boolean>
): Promise<boolean | "raced"> => {
  try {
    return await prisma.$transaction(body);
  } catch (error) {
    // Anything else that fails in here -- the snapshot insert, the seal, the
    // skip -- rolled the whole transaction back, so nothing about this message
    // was decided and retrying it is safe. It goes to the drain as the one error
    // that releases the claim, rather than to the ordinary catch that would
    // close a message the law allows as a permanent `failed` (invariant 11). A
    // defect that fails every time still ends: the retry curve runs out and the
    // row is abandoned with an incident, which is visible in a way a silent
    // `failed` is not.
    if (!(error instanceof ReenqueueRaceError)) {
      throw new VerdictUnavailableError(
        "the send decision could not be recorded, so nothing was decided",
        { cause: error }
      );
    }
    await reportOperationalIncident({
      code: "EMAIL_DELIVERY_CLAIM_RACE",
      title: "Two workers held one queued email",
      severity: "warning",
      error: `Delivery ${delivery.id}: ${error.message}`,
      cooldownMs: 15 * 60 * 1_000,
      context: {
        component: "standard-email-lane",
        deliveryId: delivery.id,
        reason: error.reason,
      },
    });
    return "raced";
  }
};

const sendClaimedDelivery = async (delivery: ClaimedDelivery, now: Date) => {
  // Filled for marketing only; re-checked immediately before the provider call.
  let quietHourWindows: Array<{ profileKey: string; quietHours: unknown }> = [];
  // Set by the release-notes verdict, which is the only thing that reads the
  // duty state the exemption lives in. False for every other message: a
  // classification with no subject-label duty has nothing to be exempt from.
  let suppressSubjectPrefix = false;
  const definition = emailTemplateDefinition(delivery.templateVersion.template.key);

  // The version this row was pinned to must still describe the message the code
  // is about to send. A template reclassified after enqueue -- or a version
  // backfilled from a row that had already drifted -- would otherwise go out
  // with headers, footer and stream decided by one classification and
  // suppression decided by another. Refused before anything else, including the
  // suppression check, because every later step reads the definition.
  const metadataMismatches = templateMetadataMismatches(
    delivery.templateVersion,
    definition
  );
  if (metadataMismatches.length > 0) {
    await reportOperationalIncident({
      code: "EMAIL_TEMPLATE_METADATA_MISMATCH",
      title: "A queued message was refused because its template version no longer matches the code",
      severity: "error",
      error: metadataMismatches
        .map((m) => `${m.field}: stored ${String(m.stored)}, code ${String(m.expected)}`)
        .join("; "),
      context: {
        component: "standard-email-lane",
        deliveryId: delivery.id,
        templateKey: definition.key,
        templateVersionId: delivery.templateVersion.id,
      },
    });
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "failed",
        attempts: delivery.attempts,
        lastErrorKind: "template_metadata_mismatch",
        nextAttemptAt: null,
        claimedAt: null,
        deferReason: null,
      },
    });
    return { outcome: "failed" as const, classification: definition.classification };
  }

  // Checked before the work of rendering, so a suppressed address costs a
  // template read rather than a composed message. It is not the decision the
  // send is made on: that one is taken again under the address lock,
  // immediately before the provider call (lib/emailSendLock.ts).
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

  // A preference is a different question from a suppression: suppression is
  // about the mailbox, a preference is about what this person asked for. Both
  // are checked at send time, because a message queued yesterday may be for a
  // purpose switched off this morning.
  //
  // The decision is `consentGateVerdict`, not a comparison here, because the
  // interesting case is the row that does not exist. `preference &&
  // !preference.enabled` treated an absent row as a yes, and rows are created
  // lazily on a settings read -- so every account that never opened the
  // preference centre was one marketing template away from being sent
  // advertising it had never agreed to.
  //
  // Not asked for a release-notes purpose, and that exemption is what section
  // 7.6 means by one verdict: for those, the verdict *is* the consent decision.
  // It reads the same preference and the same consent record, and it is the only
  // thing that knows about the sealed `risk_accepted` approval section 5.6 uses
  // to reach the accounts that existed before any of this did. Those accounts
  // have no preference row, so this gate refused them as `no_consent` before the
  // verdict ever ran: the override was loaded, judged, recorded as applied in
  // the enqueue snapshot, and then never consulted at send. A population the
  // design names explicitly could not have been sent to at all, and the record
  // would have said they had refused.
  if (!releaseNotesFlagApplies(definition.purpose)) {
    const stored =
      definition.purpose && delivery.userId && isEmailPurpose(definition.purpose)
        ? await prisma.emailPreference.findUnique({
            where: {
              userId_purpose: {
                userId: delivery.userId,
                purpose: definition.purpose,
              },
            },
            select: { enabled: true, confirmedAt: true },
          })
        : null;

    const consent = consentGateVerdict({
      classification: definition.classification,
      purpose: definition.purpose,
      hasAccount: Boolean(delivery.userId),
      storedEnabled: stored ? stored.enabled : null,
      // docs/policy/email-double-opt-in.md §6: passed here, judged there.
      storedConfirmedAt: stored ? stored.confirmedAt : null,
    });
    if (!consent.allowed) {
      await prisma.emailDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "skipped",
          skipReason: consent.skipReason,
          attempts: delivery.attempts,
          nextAttemptAt: null,
          claimedAt: null,
        },
      });
      return { outcome: "suppressed" as const, classification: definition.classification };
    }
  }

  // The feature flag, re-asked at send (EM-05). A row queued while marketing was
  // on must not go out after somebody turned it off -- a switch that only
  // guarded the enqueue would leave whatever was already queued to send itself,
  // which is the one thing an operator flipping it off is trying to stop.
  //
  // Skipped rather than held, for the same reason the kill switch below skips:
  // a promotion that waits for a decision arrives stale, and the row records
  // why it never went.
  if (definition.classification === "marketing") {
    if (!(await isEmailMarketingEnabled())) {
      await prisma.emailDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "skipped",
          skipReason: "marketing_disabled",
          attempts: delivery.attempts,
          nextAttemptAt: null,
          claimedAt: null,
        },
      });
      return { outcome: "suppressed" as const, classification: definition.classification };
    }
  }

  // The stream's own kill switch, checked before anything else marketing-only
  // because it is a fact about the stream rather than about this recipient
  // (§14.5, EM-09). Marketing alone reaches it: provider suppression is already
  // account-wide (§5.3.1), so a switch that could stop transactional mail would
  // be a second route to login codes not arriving.
  if (definition.classification === "marketing") {
    const health = await evaluateMarketingSendHealth(now);
    if (health.halted) {
      // Skipped rather than held. A promotion that waits for a person to clear
      // a halt is a promotion that arrives stale, and the reputation event that
      // tripped the switch is itself the reason not to send this one.
      await prisma.emailDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "skipped",
          skipReason: "marketing_halted",
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
  //
  // Release-notes purposes reach the same refusal through their own verdict,
  // so the refusal below is not asked of them twice. That is only true because
  // `candidateCountries()` applies this gate's own rule -- a high-confidence
  // country that is not `ZZ`, or none -- and `tests/releaseNotesCandidateCountries
  // .test.mjs` holds the two to agreement. The first version of the exemption
  // said the same thing while the verdict accepted a conflict and a
  // low-confidence guess, which changed what went out rather than which word it
  // was recorded under. What the exemption changes is the record: the verdict
  // leaves a send snapshot saying what was known about this person's country,
  // and this gate leaves a skip reason and nothing else.
  if (definition.classification === "marketing") {
    const resolved = delivery.userId
      ? await jurisdictionForUser({ userId: delivery.userId })
      : null;
    const verdict = resolved
      ? marketingJurisdictionVerdict(resolved)
      : ({ allowed: false, skipReason: "jurisdiction_unconfirmed" } as const);
    // Only the refusal is exempt, not the block. The quiet-hours hold below is
    // a timing rule, not a permission, and a release-notes message owes it as
    // much as any other marketing: the policy makes adding a night-time window a
    // seed and a policy version, and a purpose that skipped this block would be
    // the one purpose that seed never reached.
    if (!verdict.allowed && !releaseNotesFlagApplies(definition.purpose)) {
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

    // Night-time rules (docs/policy/email-notifications.md §5.2 E5, §12.6).
    // Deferred to the end of the window, not skipped: an evening wave must
    // reach Korean recipients at 08:00 rather than never. Both the profile this
    // row was pinned to and the one the recipient resolves to now are
    // consulted, so neither a stale pin nor a move into a quiet-hours
    // jurisdiction lets a message through at night. Checked again right before
    // the provider call, because rendering takes time and the clock moves.
    const profileKeys = [
      ...new Set([delivery.jurisdictionProfileKey, resolved?.profileKey].filter(Boolean)),
    ] as string[];
    quietHourWindows = await prisma.jurisdictionProfile.findMany({
      where: {
        policyVersionId: delivery.policyVersionId,
        profileKey: { in: profileKeys },
      },
      select: { profileKey: true, quietHours: true },
    });
    const held = await holdForQuietHours(delivery, quietHourWindows, now);
    if (held) return { outcome: "pending" as const, classification: definition.classification };
  }

  // The release-notes verdict, and the second of the two snapshots section 7.6
  // asks for. Last of the gates and before the render, because it is the one
  // that can end in a *replacement* rather than an ending: a message whose
  // display contract moved is re-enqueued under the current template and the
  // current contract, and rendering the old one first would be work thrown away.
  //
  // The reads inside raise `VerdictUnavailableError` and nothing else, which the
  // drain's catch releases the claim for (invariant 11). A database that cannot
  // answer is not a refusal, and the drain's default -- permanent `failed` --
  // would retire a message the law allows over a connection reset.
  if (releaseNotesFlagApplies(definition.purpose)) {
    const decided = await decideReleaseNotesSend(delivery, definition, now);
    if (decided.finished) return decided.finished;
    suppressSubjectPrefix = decided.suppressSubjectPrefix;
  }

  const stored = decryptSnapshot(delivery.renderDataSnapshot, snapshotKeyring());
  // A template that carries a capability rebuilds it here rather than reading
  // it from the snapshot, and names it so the audit record can leave it out
  // (docs/policy/email-notifications.md §10.3).
  const prepared = definition.prepareForSend
    ? definition.prepareForSend(stored)
    : { payload: stored, secrets: [] as string[] };
  const templateRendered = definition.render(prepared.payload, delivery.language);
  const forAudit = (message: { subject: string; html: string; text: string }) =>
    redactSecrets(message, prepared.secrets);
  const attempts = delivery.attempts + 1;

  // Only marketing carries these, and the template's own flag decides -- which
  // the database holds as a CHECK against the classification, so a message
  // cannot acquire an unsubscribe header by being sent from the wrong place.
  const unsubscribeTarget = {
    requiresUnsubscribe: delivery.templateVersion.requiresUnsubscribe,
    userId: delivery.userId,
    purpose: definition.purpose,
    deliveryId: delivery.id,
    appUrl:
      process.env.PUBLIC_APP_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      "https://tomverse.app",
  };
  const link = unsubscribeUrl(unsubscribeTarget);
  if (link.ok === false) {
    // Named, permanent, and reported as itself rather than swallowed by the
    // outer catch. Before EM-10 this threw, the catch turned it into
    // EMAIL_RENDER_FAILED, and an operator went looking at templates for a
    // missing environment variable.
    //
    // Permanent for the same reason the identity refusal is: no amount of
    // waiting sets an environment variable, and retrying would spend the
    // message's whole budget discovering that.
    await reportOperationalIncident({
      code: "EMAIL_UNSUBSCRIBE_KEY_MISSING",
      title: "A marketing message was refused because it can carry no unsubscribe link",
      severity: "error",
      error: link.message,
      context: {
        component: "standard-email-lane",
        deliveryId: delivery.id,
        classification: definition.classification,
        setInstead: "EMAIL_UNSUBSCRIBE_KEYS",
      },
    });
    const recorded = await recordOutcome(
      delivery,
      { kind: "permanent", errorKind: link.refusal },
      {
        now,
        attempts,
        classification: definition.classification,
        rendered: forAudit(templateRendered),
        status: null,
      }
    );
    return { outcome: recorded, classification: definition.classification };
  }
  const unsubscribeLink = link.url;
  const headers = unsubscribeHeaders(unsubscribeLink);
  // The version this message will depend on for as long as it sits in an
  // inbox, and a canary proving that version still opens what it signs. Stored
  // before the send: a canary for a version that then failed to send is
  // harmless, a sent message whose version has no canary is not checkable.
  const unsubscribeKeyVersion = link.keyring?.activeVersion ?? null;
  if (link.keyring) await ensureUnsubscribeKeyCanary(link.keyring);

  // The subject prefix and the jurisdiction footer, from the profile this row
  // was pinned to at enqueue (EM-04). Read from the pinned policy version and
  // not the active one: a message enqueued under one set of labelling rules
  // must not be sent under another, or the delivery row records the first while
  // the recipient receives the second.
  const profile = await prisma.jurisdictionProfile.findUnique({
    where: {
      profileKey_policyVersionId: {
        profileKey: delivery.jurisdictionProfileKey,
        policyVersionId: delivery.policyVersionId,
      },
    },
    select: {
      profileKey: true,
      subjectPrefix: true,
      footerBlocks: true,
      unsubscribeSlaBusinessDays: true,
    },
  });

  const composed = composeJurisdictionalMessage({
    classification: definition.classification,
    requiresUnsubscribe: delivery.templateVersion.requiresUnsubscribe,
    profile: profile
      ? {
          profileKey: profile.profileKey,
          subjectPrefix: profile.subjectPrefix,
          footerBlocks: Array.isArray(profile.footerBlocks)
            ? profile.footerBlocks.filter(
                (block): block is string => typeof block === "string"
              )
            : [],
          unsubscribeSlaBusinessDays: profile.unsubscribeSlaBusinessDays,
        }
      : null,
    identity: readBusinessIdentity(process.env),
    language: delivery.language,
    unsubscribeUrl: unsubscribeLink,
    rendered: templateRendered,
    suppressSubjectPrefix,
  });

  if (composed.ok === false) {
    // Marketing only. An advertisement that cannot be labelled the way its
    // recipient's jurisdiction requires is not sent, because the violation is
    // not recoverable by fixing configuration afterwards -- the message has
    // already arrived unlabelled.
    await reportOperationalIncident({
      code: "EMAIL_JURISDICTION_LABELLING_UNAVAILABLE",
      title: "A marketing message was held because it could not be labelled",
      severity: "error",
      context: {
        component: "standard-email-lane",
        deliveryId: delivery.id,
        profileKey: delivery.jurisdictionProfileKey,
        skipReason: composed.skipReason,
        missing: composed.missing.join(","),
        setInstead: composed.missing
          .map((block) => BLOCK_ENV_VARIABLE[block])
          .filter(Boolean)
          .join(","),
      },
    });
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "skipped",
        skipReason: composed.skipReason,
        attempts: delivery.attempts,
        nextAttemptAt: null,
        claimedAt: null,
      },
    });
    return { outcome: "suppressed" as const, classification: definition.classification };
  }

  if (composed.degraded.length > 0) {
    // Not an incident: the message is correct and going out, and holding an
    // account-deletion notice for an unset variable would be the worse failure.
    // Loud anyway -- the footer is still owed, and a silent omission is one
    // nobody ever fixes.
    console.warn(
      JSON.stringify({
        event: "email_jurisdiction_footer_degraded",
        deliveryId: delivery.id,
        classification: definition.classification,
        profileKey: delivery.jurisdictionProfileKey,
        reasons: composed.degraded,
        sent: "without_footer",
      })
    );
  }

  const rendered = composed.rendered;

  // A campaign cancelled while this row waited, or while it was being
  // rendered, is not sent. Cancellation also skips unsent rows itself; this
  // closes the window between a claim and that update.
  if (delivery.event.referenceType === "EmailCampaign" && delivery.event.referenceId) {
    const campaign = await prisma.emailCampaign.findUnique({
      where: { id: delivery.event.referenceId },
      select: { status: true },
    });
    if (campaign?.status === "cancelled") {
      await prisma.emailDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "skipped",
          skipReason: "campaign_cancelled",
          nextAttemptAt: null,
          claimedAt: null,
        },
      });
      return { outcome: "suppressed" as const, classification: definition.classification };
    }
  }

  // The last word on quiet hours, as close to the send as it can be. The first
  // check used the claim's clock; rendering and composition have happened since.
  // The later of the two clocks is used so an injected clock cannot move this
  // check into the past.
  if (
    quietHourWindows.length > 0 &&
    (await holdForQuietHours(
      delivery,
      quietHourWindows,
      new Date(Math.max(now.getTime(), Date.now()))
    ))
  ) {
    return { outcome: "pending" as const, classification: definition.classification };
  }

  // The lock, the last suppression word and the submission, in one scope
  // (docs/policy/email-product-news-redesign-draft.md section 7.4, C29).
  // Everything above -- the template read, the render, the footer, the quiet
  // hour wait -- happened outside it, and anything committed during it is what
  // this re-check is for.
  const submitted = await sendWithAddressLock({
    emailAddress: delivery.emailAddress,
    classification: definition.classification,
    purpose: definition.purpose,
    userId: delivery.userId,
    now,
    // The lane cap. What the call gets is this or the transaction’s remaining
    // life, whichever is less -- the transaction cannot abort an HTTP request,
    // so a call that outlived it would be submitting with no lock held
    // (docs/policy/email-notifications.md section 9.8).
    providerTimeoutMs: STANDARD_SEND_PROVIDER_TIMEOUT_MS,
    message: {
      ...rendered,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    },
    idempotencyKey: delivery.idempotencyKey,
    // Marketing sends from its own domain or does not send. Derived from the
    // template's classification rather than passed by the enqueuing caller, for
    // the same reason the classification itself is: a caller that could choose
    // would eventually choose wrong, and a promotion sent from the transactional
    // domain has no symptom until login codes stop arriving
    // (docs/policy/email-notifications.md §5.3, §14.1).
    stream: streamForClassification(definition.classification),
    // From the definition too, and for the same reason: the drain looks the
    // template up by key on every attempt, so a retry hours later resolves the
    // sender the first attempt used rather than one recomputed from what the
    // retry happens to know (docs/policy/email-notifications.md §14.1a).
    senderRole: definition.senderRole,
  });

  if (submitted.ok === false && submitted.reason === "lock_unavailable") {
    // Nothing was submitted. The claim is released and the row comes back on
    // the curve it was already on, with its attempt count untouched: waiting
    // for a lock is not a failed attempt, and counting it would spend a
    // message's abandonment budget on somebody else's withdrawal
    // (docs/policy/email-product-news-redesign-draft.md section 7.4).
    // The delay this message would have waited had the attempt happened and
    // failed -- ten seconds for a receipt, a minute for a maintenance notice.
    // `attempts` on the row stays where it was; only the wait is borrowed.
    const backoff = nextStandardAttempt({
      attemptsMade: delivery.attempts + 1,
      classification: definition.classification,
    });
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "pending",
        attempts: delivery.attempts,
        nextAttemptAt: new Date(
          now.getTime() + (backoff.retry ? backoff.delayMs : SEND_LOCK_RETRY_MS)
        ),
        claimedAt: null,
        deferReason: "send_not_submitted",
      },
    });
    return { outcome: "pending" as const, classification: definition.classification };
  }

  if (submitted.ok === false) {
    // A suppression committed while this message was being prepared. The row
    // records it as the send-time decision it is, not as a provider failure.
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "suppressed",
        skipReason: submitted.skipReason,
        attempts: delivery.attempts,
        nextAttemptAt: null,
        claimedAt: null,
        deferReason: null,
      },
    });
    return { outcome: "suppressed" as const, classification: definition.classification };
  }

  if (submitted.raiseIncident === "transactional_complaint") {
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

  const response = submitted.value;

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
        stream: streamForClassification(definition.classification),
        senderRole: definition.senderRole,
      },
    });
  }

  if (response.ok) {
    // One line per delivered message, naming both axes and the address the
    // provider accepted. "Which sender did this go out as" had no answer here
    // before: the lane records an outcome on the row and the wire call logs
    // nothing, so a message that left as the wrong sender left no trace of
    // having done so (docs/policy/email-notifications.md §14.1a). No recipient
    // and no rendered content -- `from` is our own address.
    console.info(
      JSON.stringify({
        event: "standard_email_sent",
        deliveryId: delivery.id,
        templateKey: delivery.templateVersion.template.key,
        classification: definition.classification,
        stream: streamForClassification(definition.classification),
        senderRole: definition.senderRole,
        from: response.from,
        id: response.providerMessageId,
      })
    );
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
    rendered: forAudit(rendered),
    status: response.ok ? null : (response.status ?? null),
    unsubscribeKeyVersion,
    providerAccount: streamForClassification(definition.classification),
    sentFrom: response.ok ? response.from : null,
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

  // Once, ever: adopt the keyring as the guard for mail sent before unsubscribe
  // key versions were recorded (docs/policy/email-notifications.md §11.4). Here
  // and not in the readiness check, so a probe never records and passes on the
  // same call. A failure costs the adoption, not the drain.
  try {
    await adoptUnsubscribeKeyringForUnattributedMail(options?.now ?? new Date());
  } catch (error) {
    await reportOperationalIncident({
      code: "EMAIL_UNSUBSCRIBE_KEY_ADOPTION_FAILED",
      title: "The unsubscribe keyring could not be adopted for older mail",
      severity: "warning",
      error: error instanceof Error ? error.message : String(error),
      cooldownMs: 60 * 60 * 1_000,
      context: { component: "standard-email-lane" },
    });
  }
  const result: StandardDrainResult = {
    claimed: 0,
    sent: 0,
    failed: 0,
    abandoned: 0,
    suppressed: 0,
    pending: 0,
    oldestPendingMs: null,
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
      if (error instanceof VerdictUnavailableError) {
        // Neither skipped nor failed. The rules refused nothing -- nobody asked
        // them -- and nothing about the message is wrong; a database read while
        // deciding did not answer. Turning that into a permanent `failed`, which
        // is what the branch below would do, retires a message the law allows
        // and leaves `lastErrorKind` naming a Prisma class, which nobody reading
        // the row later can tell from a message that was genuinely unsendable
        // (draft section 7.6, invariant 11).
        //
        // So the claim goes back and the schedule moves, on the classification's
        // own curve. And it still runs out: a message nobody can decide after
        // every attempt is one an operator has to see, and holding it `pending`
        // for ever is how nobody does.
        const classification = delivery.templateVersion.classification as RetryClassification;
        const retry = verdictRetry({
          attemptsMade: delivery.attempts,
          classification,
          now,
        });
        if (retry.outcome === "retry") {
          await prisma.emailDelivery.update({
            where: { id: delivery.id },
            data: {
              attempts: retry.attempts,
              nextAttemptAt: retry.nextAttemptAt,
              claimedAt: null,
              lastErrorKind: "verdict_unavailable",
            },
          });
          result.pending += 1;
        } else {
          await prisma.emailDelivery.update({
            where: { id: delivery.id },
            data: {
              status: "abandoned",
              attempts: retry.attempts,
              nextAttemptAt: null,
              claimedAt: null,
              lastErrorKind: "verdict_unavailable",
            },
          });
          result.abandoned += 1;
          result.abandonedByClassification[classification] += 1;
        }
        await reportOperationalIncident({
          code: "EMAIL_SEND_VERDICT_UNAVAILABLE",
          title: "A queued email could not be decided",
          error:
            `Delivery ${delivery.id}: ${error.message}` +
            (retry.outcome === "retry"
              ? ` -- retrying in ${retry.delayMs}ms (attempt ${retry.attempts})`
              : " -- abandoned, attempts exhausted"),
          severity: retry.outcome === "retry" ? "warning" : "error",
          cooldownMs: 15 * 60 * 1_000,
          context: {
            component: "standard-email-lane",
            outcome: retry.outcome,
            attempts: String(retry.attempts),
          },
        });
        continue;
      }
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

  // Resolved here rather than reusing the per-message `now` inside the loop:
  // that one is scoped to a claim and does not exist when the loop never ran,
  // which is exactly the case a stale queue shows up in.
  const measuredAt = options?.now ?? new Date();
  // A message waiting out a night-time window is on schedule, not behind, and
  // counting it would page somebody every evening a Korean wave is queued. It
  // is excluded only while it is still waiting: once its nextAttemptAt has
  // passed, a morning the drain has not caught up with counts like any other.
  const backlog: Prisma.EmailDeliveryWhereInput = {
    lane: "standard",
    status: "pending",
    // Spelled out rather than NOT(...): NOT over a nullable column is NULL for a
    // row with no deferReason, and SQL would drop every ordinary row.
    OR: [
      { deferReason: null },
      { deferReason: { not: "quiet_hours" } },
      { nextAttemptAt: null },
      { nextAttemptAt: { lte: measuredAt } },
    ],
  };
  result.pending = await prisma.emailDelivery.count({ where: backlog });
  const oldestPending = await prisma.emailDelivery.findFirst({
    where: backlog,
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  result.oldestPendingMs = oldestPending
    ? Math.max(0, measuredAt.getTime() - oldestPending.createdAt.getTime())
    : null;

  // A backlog, said out loud while the mail is merely late (EM-11). Either
  // shape counts: too many waiting, or one waiting too long.
  //
  // Deliberately separate from the abandonment incidents below. Those fire once
  // a message is already lost, which the audit calls the signal that arrives
  // too late; this one is the signal that arrives while it can still be acted
  // on.
  const deepQueue = result.pending >= STANDARD_EMAIL_QUEUE_DEPTH_ALERT;
  const staleQueue =
    (result.oldestPendingMs ?? 0) >= STANDARD_EMAIL_OLDEST_PENDING_ALERT_MS;
  if (deepQueue || staleQueue) {
    await reportOperationalIncident({
      code: "EMAIL_STANDARD_DRAIN_BACKLOG",
      title: "User email queue is not keeping up",
      error: staleQueue
        ? `The oldest pending message has waited ${Math.round((result.oldestPendingMs ?? 0) / 60_000)} minute(s); ${result.pending} still pending`
        : `${result.pending} message(s) still pending after a drain pass`,
      severity: "warning",
      cooldownMs: 30 * 60 * 1_000,
      context: {
        component: "standard-email-lane",
        pending: result.pending,
        claimed: result.claimed,
        oldestPendingMs: result.oldestPendingMs,
        // Which of the two tripped, so the first line of the incident does not
        // have to be reverse-engineered from the numbers.
        trigger: staleQueue ? "oldest_pending" : "queue_depth",
      },
    });
  }

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
