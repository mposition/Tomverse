import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CREDENTIAL_ATTEMPT_TIMEOUT_MS,
  CREDENTIAL_SEND_BUDGET_MS,
  CREDENTIAL_SEND_MAX_ATTEMPTS,
  classifyProviderStatus,
  classifyTransportError,
  isCredentialStillSendable,
  isProviderAuthFailure,
  isRetryableSendStatus,
  nextCredentialSendAttempt,
} from "../lib/emailSendRetryCore.ts";

// The retry rules for the credential lane, driven without a provider or a
// clock. Contract: docs/policy/email-notifications.md §9.4a-3.

test("retryable is an allowlist, not everything that is not permanent", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableSendStatus(status), true, `${status} should retry`);
  }

  // The point of the allowlist: a status nobody thought about is not retried.
  for (const status of [400, 401, 403, 404, 409, 418, 422, 451, 501, 505]) {
    assert.equal(
      isRetryableSendStatus(status),
      false,
      `${status} should not retry`
    );
  }
});

test("an API key failure stops immediately and is worth paging about", () => {
  for (const status of [401, 403]) {
    const outcome = classifyProviderStatus(status);
    assert.equal(outcome.kind, "permanent");
    assert.equal(isProviderAuthFailure(status), true);
  }

  // Not every permanent failure is an auth failure; only these page.
  assert.equal(isProviderAuthFailure(422), false);
  assert.equal(isProviderAuthFailure(500), false);
});

test("a 2xx is delivered and everything else carries its status as the kind", () => {
  assert.deepEqual(classifyProviderStatus(200), {
    kind: "delivered",
    providerMessageId: null,
  });
  assert.deepEqual(classifyProviderStatus(502), {
    kind: "transient",
    errorKind: "http_502",
  });
  assert.deepEqual(classifyProviderStatus(422), {
    kind: "permanent",
    errorKind: "http_422",
  });
});

test("a failure with no response is transient, because nothing was established", () => {
  const aborted = classifyTransportError(
    Object.assign(new Error("aborted"), { name: "TimeoutError" })
  );
  assert.deepEqual(aborted, { kind: "transient", errorKind: "timeouterror" });

  assert.deepEqual(classifyTransportError(new Error("socket hang up")), {
    kind: "transient",
    errorKind: "network",
  });
  assert.deepEqual(classifyTransportError("not an error at all"), {
    kind: "transient",
    errorKind: "network",
  });
});

test("attempts run to the cap and then stop", () => {
  const first = nextCredentialSendAttempt({ attemptsMade: 0, elapsedMs: 0 });
  assert.deepEqual(first, {
    retry: true,
    delayMs: 0,
    timeoutMs: CREDENTIAL_ATTEMPT_TIMEOUT_MS,
  });

  const second = nextCredentialSendAttempt({ attemptsMade: 1, elapsedMs: 120 });
  assert.equal(second.retry, true);
  assert.equal(second.retry && second.delayMs, 700);

  const third = nextCredentialSendAttempt({ attemptsMade: 2, elapsedMs: 900 });
  assert.equal(third.retry, true);
  assert.equal(third.retry && third.delayMs, 2_000);

  const fourth = nextCredentialSendAttempt({
    attemptsMade: CREDENTIAL_SEND_MAX_ATTEMPTS,
    elapsedMs: 900,
  });
  assert.deepEqual(fourth, { retry: false, reason: "attempts_exhausted" });
});

test("the budget stops a retry that could not finish inside it", () => {
  const spent = nextCredentialSendAttempt({
    attemptsMade: 1,
    elapsedMs: CREDENTIAL_SEND_BUDGET_MS,
  });
  assert.deepEqual(spent, { retry: false, reason: "budget_exhausted" });

  // A delay that would consume the remainder buys a wait and no send, so it is
  // refused rather than scheduled.
  const noRoom = nextCredentialSendAttempt({
    attemptsMade: 2,
    elapsedMs: CREDENTIAL_SEND_BUDGET_MS - 1_500,
  });
  assert.deepEqual(noRoom, { retry: false, reason: "budget_exhausted" });
});

test("an attempt never gets a timeout longer than the budget has left", () => {
  const decision = nextCredentialSendAttempt({
    attemptsMade: 1,
    elapsedMs: CREDENTIAL_SEND_BUDGET_MS - 1_000,
  });
  assert.equal(decision.retry, true);
  assert.ok(decision.retry && decision.timeoutMs <= 300);
});

test("Retry-After is honoured when it fits and refused when it does not", () => {
  const fits = nextCredentialSendAttempt({
    attemptsMade: 1,
    elapsedMs: 100,
    retryAfterMs: 1_200,
  });
  assert.equal(fits.retry, true);
  assert.equal(fits.retry && fits.delayMs, 1_200);

  // A provider asking for a minute is telling us this request cannot succeed.
  // Waiting to be told again wastes the time the user could spend resending.
  const doesNot = nextCredentialSendAttempt({
    attemptsMade: 1,
    elapsedMs: 100,
    retryAfterMs: 60_000,
  });
  assert.deepEqual(doesNot, { retry: false, reason: "budget_exhausted" });
});

test("a dead credential is never sent, whichever way it died", () => {
  const now = new Date("2026-08-21T00:10:00.000Z");
  const live = new Date("2026-08-21T00:15:00.000Z");
  const dead = new Date("2026-08-21T00:05:00.000Z");

  assert.equal(isCredentialStillSendable({ expiresAt: live, now }), true);

  // Expired while an earlier attempt was waiting out its retry.
  assert.equal(isCredentialStillSendable({ expiresAt: dead, now }), false);

  // Already used: the user got in by the link while the code was retrying.
  assert.equal(
    isCredentialStillSendable({ expiresAt: live, consumedAt: now, now }),
    false
  );

  // Superseded: requesting a new code invalidates the outstanding one
  // (lib/emailLogin.ts), so the older message must not go out behind it.
  assert.equal(
    isCredentialStillSendable({ expiresAt: live, invalidatedAt: now, now }),
    false
  );
});
