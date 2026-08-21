/**
 * Which send failures are worth another attempt, and how long the credential
 * lane may keep trying.
 *
 * Contract: docs/policy/email-notifications.md §9.4a-3.
 *
 * Pure and dependency-free so tests/emailSendRetryCore.test.mjs can drive every
 * branch without a provider or a clock. The storage side lives in
 * lib/credentialEmailLane.ts.
 *
 * Two rules this encodes.
 *
 * **Retryable is an allowlist.** Only the statuses named below are tried
 * again; everything else stops. Written this way round because the opposite --
 * listing what is permanent and retrying the rest -- silently enrols every
 * status the provider invents later, and the ones a mail API invents later are
 * usually refusals.
 *
 * **The budget is wall-clock, not a count.** A login code is dead after ten
 * minutes (lib/emailLogin.ts caps CODE_TTL_MINUTES at 10), and the request the
 * user is waiting on cannot spend that. Three attempts inside three seconds is
 * the whole of the recovery this lane offers; the rest is the user pressing
 * resend, which is better anyway because it mints a fresh code.
 */

/** What one attempt at the provider did. */
export type ProviderSendOutcome =
  | { kind: "delivered"; providerMessageId: string | null }
  /** Worth another attempt: the provider or the network was momentarily unable. */
  | { kind: "transient"; errorKind: string; retryAfterMs?: number }
  /**
   * Not worth another attempt. Either the request is wrong (payload, auth) or
   * the provider has already decided about this recipient (suppression).
   */
  | { kind: "permanent"; errorKind: string };

/**
 * HTTP statuses that mean "later might work".
 *
 * 408 and 504 are timeouts, 429 is rate limiting, and 500/502/503 are the
 * provider being briefly unwell. Notably absent: 401 and 403, which mean the
 * API key is wrong -- retrying those burns the budget on a configuration
 * problem that only a deploy can fix, so they raise an incident instead.
 */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Statuses that mean the provider will not accept this recipient, whoever asks.
 *
 * Kept separate from other permanent failures because the reason belongs in
 * `skipReason` rather than `lastErrorKind`: nothing was broken, a decision was
 * already made. Resend answers 422 for an address on the account suppression
 * list, which -- per §5.3.1 -- is account-wide and can therefore refuse
 * transactional mail because of a marketing complaint.
 */
export const SUPPRESSION_REFUSAL_STATUSES = new Set([422]);

export const isRetryableSendStatus = (status: number) =>
  RETRYABLE_STATUSES.has(status);

/**
 * Whether an authentication failure should page someone.
 *
 * A 401/403 from the mail provider is never a user's problem and never fixes
 * itself, so it is the one permanent class that raises an incident rather than
 * simply ending the attempt.
 */
export const isProviderAuthFailure = (status: number) =>
  status === 401 || status === 403;

export const classifyProviderStatus = (
  status: number,
  options?: { retryAfterMs?: number }
): ProviderSendOutcome => {
  if (status >= 200 && status < 300) {
    return { kind: "delivered", providerMessageId: null };
  }
  if (isRetryableSendStatus(status)) {
    return {
      kind: "transient",
      errorKind: `http_${status}`,
      ...(options?.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: options.retryAfterMs }),
    };
  }
  return { kind: "permanent", errorKind: `http_${status}` };
};

/**
 * A failure with no HTTP status at all: DNS, a refused connection, an aborted
 * fetch. Always transient -- there is no response to read a decision out of, so
 * the only thing that has been established is that we could not ask.
 */
export const classifyTransportError = (error: unknown): ProviderSendOutcome => {
  const name =
    error instanceof Error && error.name && error.name !== "Error"
      ? error.name
      : "network";
  return { kind: "transient", errorKind: name.slice(0, 40).toLowerCase() };
};

/**
 * Total wall-clock the request may spend sending, across every attempt.
 *
 * Three seconds is chosen against the person waiting on the sign-in form, not
 * against the provider's SLA: past roughly that, a spinner reads as broken and
 * they reload -- which starts a second request and a second code.
 */
export const CREDENTIAL_SEND_BUDGET_MS = 3_000;

/** Attempts allowed inside the budget, including the first. */
export const CREDENTIAL_SEND_MAX_ATTEMPTS = 3;

/**
 * Delay before the attempt at each index. Short and fixed: with one message in
 * flight there is no herd to spread out, and a schedule an operator can read
 * off a single row is worth more than jitter here.
 */
export const CREDENTIAL_SEND_DELAYS_MS = [0, 700, 2_000] as const;

/** No single attempt may hold the whole budget waiting on a hung socket. */
export const CREDENTIAL_ATTEMPT_TIMEOUT_MS = 2_500;

export type NextAttemptDecision =
  | { retry: true; delayMs: number; timeoutMs: number }
  | { retry: false; reason: "attempts_exhausted" | "budget_exhausted" };

/**
 * Whether to try again, and how long to wait first.
 *
 * `retryAfterMs` is honoured only when it fits: a provider that asks for a
 * sixty-second pause is telling us this request cannot succeed, and waiting to
 * be told so again wastes the user's time. Reporting the failure now, with a
 * resend button, is the faster path to a delivered code.
 */
export const nextCredentialSendAttempt = (input: {
  attemptsMade: number;
  elapsedMs: number;
  retryAfterMs?: number;
  budgetMs?: number;
  maxAttempts?: number;
}): NextAttemptDecision => {
  const budgetMs = input.budgetMs ?? CREDENTIAL_SEND_BUDGET_MS;
  const maxAttempts = input.maxAttempts ?? CREDENTIAL_SEND_MAX_ATTEMPTS;

  if (input.attemptsMade >= maxAttempts) {
    return { retry: false, reason: "attempts_exhausted" };
  }

  const remaining = budgetMs - input.elapsedMs;
  if (remaining <= 0) return { retry: false, reason: "budget_exhausted" };

  const scheduled =
    CREDENTIAL_SEND_DELAYS_MS[input.attemptsMade] ??
    CREDENTIAL_SEND_DELAYS_MS[CREDENTIAL_SEND_DELAYS_MS.length - 1];
  const delayMs = Math.max(scheduled, input.retryAfterMs ?? 0);

  // Leave room for the attempt itself; a delay that consumes the remainder
  // buys a wait and no send.
  if (delayMs >= remaining) return { retry: false, reason: "budget_exhausted" };

  return {
    retry: true,
    delayMs,
    timeoutMs: Math.min(CREDENTIAL_ATTEMPT_TIMEOUT_MS, remaining - delayMs),
  };
};

/**
 * Whether the credential this message carries is still worth delivering.
 *
 * Checked immediately before every attempt rather than once at the start: an
 * attempt that waited out a retry may now be holding a code that expired while
 * it waited, and a login code that arrives dead is worse than one that never
 * arrives. The user reads "your code is 418293", types it, is told it is
 * wrong, and concludes their account is broken.
 */
export const isCredentialStillSendable = (credential: {
  expiresAt: Date;
  consumedAt?: Date | null;
  invalidatedAt?: Date | null;
  now?: Date;
}) => {
  const now = credential.now ?? new Date();
  if (credential.consumedAt) return false;
  if (credential.invalidatedAt) return false;
  return credential.expiresAt.getTime() > now.getTime();
};
