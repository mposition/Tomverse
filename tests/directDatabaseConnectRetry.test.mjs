import assert from "node:assert/strict";
import test from "node:test";

import {
  CONNECT_RETRY_COUNT,
  CONNECT_RETRY_DELAY_MS,
  NON_RETRYABLE_POSTGRES_CODES,
  isRetryablePostgresConnectionError,
  nextConnectRetryDelayMs,
} from "../scripts/direct-database-connect-core.mjs";

/**
 * The deploy of d04460c failed at `[migration-check 2/3]` with "Failed to
 * connect to upstream database", minutes before the same database answered
 * normally again. The build had already succeeded, and the five sibling
 * services that deployed from that commit at the same moment were unaffected
 * because none of them opens the direct connection.
 *
 * These pin the two halves of the decision that failure produced: a condition
 * that can clear is tried again, and one that cannot is not.
 */

test("an error with no SQLSTATE is retried", () => {
  // The failure that prompted this: the upstream never answered, so nothing
  // came back from the server to carry a code.
  assert.equal(
    isRetryablePostgresConnectionError(
      new Error("Failed to connect to upstream database.")
    ),
    true
  );
});

test("socket-level failures are retried", () => {
  for (const code of ["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"]) {
    const error = Object.assign(new Error(code), { code });
    assert.equal(
      isRetryablePostgresConnectionError(error),
      true,
      `${code} should be retried`
    );
  }
});

test("a wrong password is not retried", () => {
  // Retrying turns an immediate, readable failure into the same failure a
  // minute later, with the reason buried under "retrying..." lines.
  const error = Object.assign(new Error("password authentication failed"), {
    code: "28P01",
  });
  assert.equal(isRetryablePostgresConnectionError(error), false);
});

test("every named non-retryable code fails fast", () => {
  for (const code of NON_RETRYABLE_POSTGRES_CODES) {
    const error = Object.assign(new Error(code), { code });
    assert.equal(
      isRetryablePostgresConnectionError(error),
      false,
      `${code} should fail fast`
    );
  }
});

test("a non-string code is treated as retryable", () => {
  // Defensive: `code` is whatever the driver put there, and an unreadable one
  // is not evidence that the failure is permanent.
  assert.equal(
    isRetryablePostgresConnectionError(Object.assign(new Error("x"), { code: 42 })),
    true
  );
  assert.equal(isRetryablePostgresConnectionError(null), true);
  assert.equal(isRetryablePostgresConnectionError(undefined), true);
});

test("the last attempt has no delay after it", () => {
  assert.equal(nextConnectRetryDelayMs(CONNECT_RETRY_COUNT), null);
  assert.equal(nextConnectRetryDelayMs(CONNECT_RETRY_COUNT + 1), null);
});

test("every earlier attempt is followed by the flat delay", () => {
  for (let attempt = 1; attempt < CONNECT_RETRY_COUNT; attempt += 1) {
    assert.equal(nextConnectRetryDelayMs(attempt), CONNECT_RETRY_DELAY_MS);
  }
});

test("a nonsensical attempt number yields no delay", () => {
  assert.equal(nextConnectRetryDelayMs(0), null);
  assert.equal(nextConnectRetryDelayMs(-1), null);
  assert.equal(nextConnectRetryDelayMs(1.5), null);
});

test("the probe stays inside the budget the lock retry already costs", () => {
  // The advisory-lock loop in the same script is allowed 60s (12 x 5s). The
  // connect probe must not quietly make a failing deploy take much longer:
  // worst case is every attempt burning its 10s connection timeout plus the
  // waits between them.
  const CONNECTION_TIMEOUT_MS = 10_000;
  const worstCaseMs =
    CONNECT_RETRY_COUNT * CONNECTION_TIMEOUT_MS +
    (CONNECT_RETRY_COUNT - 1) * CONNECT_RETRY_DELAY_MS;
  assert.ok(
    worstCaseMs <= 60_000,
    `worst case ${worstCaseMs}ms should stay within the 60s lock budget`
  );
});
