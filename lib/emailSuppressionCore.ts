/**
 * Whether an address may be sent to, and what a provider event means about it.
 *
 * Contract: .github/audits/email-notification-architecture-2026-08-21.md §13.3, §14.4.
 *
 * Pure and dependency-free. The storage side lives in lib/emailSuppression.ts.
 *
 * The rule everything here serves: **a complaint about a promotion must not
 * stop a login code.** Blocking transactional mail because someone reported a
 * newsletter locks them out of the account they were trying to leave, and
 * transactional mail is not consent-based in any jurisdiction surveyed in §4.
 *
 * The rule is not symmetrical, and the asymmetry is the interesting part. A
 * complaint raised *against a transactional message* means something else
 * entirely: either an account takeover is in progress and the victim is
 * reporting our security alert, or we are classifying mail as transactional
 * that the recipient does not experience that way. Both need a person. So the
 * send continues -- the victim in the first case needs that alert -- and an
 * incident is raised alongside it.
 */

export type SuppressionReason =
  | "hard_bounce"
  | "soft_bounce"
  | "complaint"
  | "unsubscribe"
  | "manual"
  | "privacy_request";

export type SendClassification =
  | "transactional"
  | "service"
  | "legal"
  | "marketing";

export type SuppressionRecord = {
  reason: SuppressionReason;
  /** Which stream the message that triggered this was sent on. */
  sourceStream?: string | null;
  expiresAt?: Date | null;
};

export type SuppressionVerdict =
  | { allowed: true; raiseIncident?: "transactional_complaint" }
  | { allowed: false; skipReason: string };

/**
 * Decides whether one message may go out, given everything suppressing its
 * address.
 *
 * `legal` is the strongest class and still cannot beat a hard bounce: the
 * mailbox does not exist, so there is nothing to deliver to and §3.2 requires a
 * different channel rather than a louder attempt at this one.
 */
export const suppressionVerdict = (input: {
  classification: SendClassification;
  records: SuppressionRecord[];
  now?: Date;
}): SuppressionVerdict => {
  const now = input.now ?? new Date();
  const active = input.records.filter(
    (record) => !record.expiresAt || record.expiresAt.getTime() > now.getTime()
  );

  if (active.some((record) => record.reason === "hard_bounce")) {
    return { allowed: false, skipReason: "hard_bounce" };
  }

  const mustReach =
    input.classification === "transactional" || input.classification === "legal";

  const softBounced = active.some((record) => record.reason === "soft_bounce");
  if (softBounced && !mustReach) {
    return { allowed: false, skipReason: "soft_bounce" };
  }

  const complaints = active.filter((record) => record.reason === "complaint");
  if (complaints.length > 0) {
    if (!mustReach) return { allowed: false, skipReason: "suppressed_complaint" };

    // Sent, because the alternative is locking someone out. Flagged when the
    // complaint came from a stream that should never draw one.
    const fromTransactional = complaints.some(
      (record) =>
        record.sourceStream === "transactional" || !record.sourceStream
    );
    return fromTransactional
      ? { allowed: true, raiseIncident: "transactional_complaint" }
      : { allowed: true };
  }

  if (active.some((record) => record.reason === "unsubscribe") && !mustReach) {
    return { allowed: false, skipReason: "no_consent" };
  }

  if (
    active.some(
      (record) =>
        record.reason === "manual" || record.reason === "privacy_request"
    )
  ) {
    // An operator or a data-subject request said stop. That outranks the
    // must-reach classes: unlike a bounce or a complaint, it is a decision
    // somebody made deliberately about this address.
    return { allowed: false, skipReason: "suppressed_complaint" };
  }

  return { allowed: true };
};

/**
 * Consecutive soft bounces before an address is held back.
 *
 * A single deferral is a full mailbox or a greylisting pass and means nothing;
 * five in a row is an address that is not accepting mail. Reset on any success,
 * so a long-lived account that hiccups once does not creep toward suppression
 * over months.
 */
export const SOFT_BOUNCE_SUPPRESSION_THRESHOLD = 5;

/** How long a soft-bounce hold lasts before the address is tried again. */
export const SOFT_BOUNCE_SUPPRESSION_MS = 24 * 60 * 60_000;

export type ProviderEventEffect =
  | { kind: "ignored" }
  | { kind: "delivery_status"; status: "sent" | "delivered" }
  | {
      kind: "suppress";
      reason: SuppressionReason;
      deliveryStatus: "bounced" | "complained";
      /** Soft holds expire; a hard bounce and a complaint do not. */
      temporary: boolean;
    }
  | { kind: "soft_bounce" };

/**
 * What one Resend event means.
 *
 * Bounce sub-types matter more than the event name: `email.bounced` covers both
 * "this mailbox does not exist" and "this mailbox is full today", and treating
 * the second as permanent throws away a real recipient over a transient
 * condition. Resend reports the distinction in `data.bounce.type`, so an event
 * that omits it is treated as soft -- the conservative direction, because a
 * wrongly-permanent suppression is invisible and a wrongly-transient one is
 * self-correcting.
 */
export const providerEventEffect = (input: {
  type: string;
  bounceType?: string | null;
}): ProviderEventEffect => {
  switch (input.type) {
    case "email.sent":
      return { kind: "delivery_status", status: "sent" };
    case "email.delivered":
      return { kind: "delivery_status", status: "delivered" };
    case "email.complained":
      return {
        kind: "suppress",
        reason: "complaint",
        deliveryStatus: "complained",
        temporary: false,
      };
    case "email.bounced": {
      const hard = (input.bounceType || "").toLowerCase() === "hard";
      return hard
        ? {
            kind: "suppress",
            reason: "hard_bounce",
            deliveryStatus: "bounced",
            temporary: false,
          }
        : { kind: "soft_bounce" };
    }
    case "email.delivery_delayed":
      return { kind: "soft_bounce" };
    default:
      // Opens and clicks among them: §8.4 does not collect them, and an event
      // we deliberately do not act on is not an error.
      return { kind: "ignored" };
  }
};
