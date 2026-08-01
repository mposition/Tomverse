/**
 * When an operator notification may be retried, how long to wait, and when to
 * give up.
 *
 * Pure and dependency-free so tests/notificationRetryCore.test.mjs can drive
 * every branch without a database or a mail provider. The storage side lives in
 * lib/notificationDeliveries.ts.
 *
 * The rule this encodes: a submission that reached the database is the user's
 * receipt, and the operator notification is a separate delivery that may fail
 * on its own schedule. Failing to notify must never look like a rejected
 * submission, and must never be silently dropped either.
 */

export const NOTIFICATION_DELIVERY_STATUS = {
  pending: "pending",
  delivered: "delivered",
  abandoned: "abandoned",
} as const;

export type NotificationDeliveryStatus =
  (typeof NOTIFICATION_DELIVERY_STATUS)[keyof typeof NOTIFICATION_DELIVERY_STATUS];

/**
 * Attempts allowed before a delivery is abandoned. Six attempts spread over the
 * delays below cover roughly five and a half hours -- long enough to ride out a
 * provider outage, short enough that a genuinely broken configuration surfaces
 * the same working day.
 */
export const NOTIFICATION_MAX_ATTEMPTS = 6;

/**
 * Delay before the next attempt, indexed by attempts already made. Deliberately
 * fixed rather than jittered: there is at most one delivery per feedback
 * submission, so there is no thundering herd to spread out, and a deterministic
 * schedule is one an operator can reason about from a single row.
 */
export const NOTIFICATION_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  4 * 60 * 60_000,
] as const;

/**
 * What a delivery attempt did. `skipped` is not a failure of the provider: it
 * is this deployment declining to send, and the two reasons differ in whether
 * waiting could ever help.
 */
export type NotificationAttemptOutcome =
  | { kind: "delivered" }
  /** No recipient to send to, or the source record is gone. Waiting cannot fix it. */
  | { kind: "unsendable"; reason: string }
  /**
   * Mail is not configured on this deployment. Retried like any other
   * transient failure rather than parked forever: if the configuration is
   * fixed within the window the notification still lands, and if it is not,
   * abandonment raises the incident that says so.
   */
  | { kind: "not_configured" }
  | { kind: "failed"; errorKind: string; permanent: boolean };

export type NotificationDeliveryTransition = {
  status: NotificationDeliveryStatus;
  attempts: number;
  /** Null once the delivery is terminal. */
  nextAttemptAt: Date | null;
  /** A short classification, never a provider message body. */
  lastErrorKind: string | null;
};

/**
 * HTTP statuses where retrying the identical request cannot help: the request
 * itself is what the provider rejected. Everything else -- timeouts, rate
 * limits, 5xx -- is worth another attempt.
 */
const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 410, 422]);

export const isPermanentDeliveryStatus = (status: number) =>
  PERMANENT_HTTP_STATUSES.has(status);

/**
 * Turns a thrown send error into a short, storable classification.
 *
 * The provider's response body is deliberately dropped: it echoes the request,
 * which for a support notification is the reporter's own words. Only the
 * transport shape is kept.
 */
export const classifyNotificationError = (
  error: unknown
): { errorKind: string; permanent: boolean } => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const status = /Email send failed:\s*(\d{3})/.exec(message)?.[1];
  if (status) {
    const code = Number(status);
    return {
      errorKind: `http_${code}`,
      permanent: isPermanentDeliveryStatus(code),
    };
  }
  if (error instanceof Error && error.name && error.name !== "Error") {
    return { errorKind: error.name.slice(0, 40), permanent: false };
  }
  return { errorKind: "unknown", permanent: false };
};

export const nextNotificationAttemptAt = (attempts: number, now: Date) => {
  const index = Math.min(
    Math.max(attempts - 1, 0),
    NOTIFICATION_RETRY_DELAYS_MS.length - 1
  );
  return new Date(now.getTime() + NOTIFICATION_RETRY_DELAYS_MS[index]);
};

/**
 * The single decision point: given what an attempt did, what the row should
 * become. Callers only persist the result, so every retry policy question has
 * exactly one answer in one place.
 */
export const nextNotificationDeliveryState = ({
  outcome,
  attempts,
  now,
}: {
  outcome: NotificationAttemptOutcome;
  /** Attempts already made, including the one being recorded. */
  attempts: number;
  now: Date;
}): NotificationDeliveryTransition => {
  if (outcome.kind === "delivered") {
    return {
      status: NOTIFICATION_DELIVERY_STATUS.delivered,
      attempts,
      nextAttemptAt: null,
      lastErrorKind: null,
    };
  }

  if (outcome.kind === "unsendable") {
    // Nothing to deliver and nothing a later attempt could change.
    return {
      status: NOTIFICATION_DELIVERY_STATUS.abandoned,
      attempts,
      nextAttemptAt: null,
      lastErrorKind: outcome.reason.slice(0, 40),
    };
  }

  const errorKind =
    outcome.kind === "not_configured" ? "not_configured" : outcome.errorKind;
  const permanent = outcome.kind === "failed" && outcome.permanent;

  if (permanent || attempts >= NOTIFICATION_MAX_ATTEMPTS) {
    return {
      status: NOTIFICATION_DELIVERY_STATUS.abandoned,
      attempts,
      nextAttemptAt: null,
      lastErrorKind: errorKind,
    };
  }

  return {
    status: NOTIFICATION_DELIVERY_STATUS.pending,
    attempts,
    nextAttemptAt: nextNotificationAttemptAt(attempts, now),
    lastErrorKind: errorKind,
  };
};
