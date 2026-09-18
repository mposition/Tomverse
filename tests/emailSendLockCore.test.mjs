import assert from "node:assert/strict";
import test from "node:test";

import {
  CREDENTIAL_SEND_LOCK_TIMEOUT_MS,
  CREDENTIAL_SEND_RESERVE_MS,
  isLockTimeoutError,
  isTransactionStartTimeoutError,
  SEND_COMMIT_RESERVE_MS,
  SEND_LOCK_RETRY_MS,
  STANDARD_SEND_LOCK_TIMEOUT_MS,
  STANDARD_SEND_PROVIDER_TIMEOUT_MS,
  STANDARD_SEND_TRANSACTION_TIMEOUT_MS,
} from "../lib/emailSendLockCore.ts";
import {
  CREDENTIAL_ATTEMPT_TIMEOUT_MS,
  CREDENTIAL_SEND_BUDGET_MS,
} from "../lib/emailSendRetryCore.ts";

// The budgets of docs/policy/email-product-news-redesign-draft.md section 7.4,
// and the one error that means "somebody else holds the address".

test("the budgets are the ones the contract names", () => {
  assert.equal(STANDARD_SEND_LOCK_TIMEOUT_MS, 2_000);
  assert.equal(STANDARD_SEND_PROVIDER_TIMEOUT_MS, 10_000);
  assert.equal(STANDARD_SEND_TRANSACTION_TIMEOUT_MS, 15_000);
  assert.equal(CREDENTIAL_SEND_LOCK_TIMEOUT_MS, 300);
});

test("a transaction outlasts the lock wait, the call it protects, and the commit", () => {
  // Otherwise the transaction expires while the submission it exists to
  // protect is still in flight, and the advisory lock is released with it. The
  // reserve belongs inside the sum: it is the room the transaction needs after
  // the provider answers, not slack outside the budget.
  assert.ok(
    STANDARD_SEND_TRANSACTION_TIMEOUT_MS >
      STANDARD_SEND_LOCK_TIMEOUT_MS +
        STANDARD_SEND_PROVIDER_TIMEOUT_MS +
        SEND_COMMIT_RESERVE_MS
  );
  // And by enough that a standard send at full stretch never has its lane cap
  // cut, so the cut is a bound rather than something the normal path leans on.
  assert.ok(
    STANDARD_SEND_TRANSACTION_TIMEOUT_MS -
      STANDARD_SEND_LOCK_TIMEOUT_MS -
      SEND_COMMIT_RESERVE_MS >=
      STANDARD_SEND_PROVIDER_TIMEOUT_MS
  );
});

test("the credential lane's waits and reserves fit inside its request budget", () => {
  // The lane waits for the lock and then sends, all inside the three seconds a
  // person is watching a sign-in screen for.
  assert.ok(
    CREDENTIAL_SEND_LOCK_TIMEOUT_MS +
      CREDENTIAL_ATTEMPT_TIMEOUT_MS +
      CREDENTIAL_SEND_RESERVE_MS <
      CREDENTIAL_SEND_BUDGET_MS
  );
  // The commit reserve is the one part that sits *outside* it: the lane's
  // transaction ceiling is what the request has left plus this, because the
  // transaction has to survive the last thing the request does. Summing the
  // caps instead would have made that ceiling 3,150ms -- longer than the
  // budget it is meant to bound.
  assert.ok(
    CREDENTIAL_SEND_LOCK_TIMEOUT_MS +
      CREDENTIAL_ATTEMPT_TIMEOUT_MS +
      CREDENTIAL_SEND_RESERVE_MS +
      SEND_COMMIT_RESERVE_MS >
      CREDENTIAL_SEND_BUDGET_MS
  );
});

test("a row that lost the lock always has somewhere to come back to", () => {
  assert.ok(SEND_LOCK_RETRY_MS > 0);
});

test("Postgres refusing to wait for a lock is recognised in either shape", () => {
  assert.equal(isLockTimeoutError({ meta: { code: "55P03" } }), true);
  assert.equal(
    isLockTimeoutError(new Error("canceling statement due to lock timeout")),
    true
  );
  assert.equal(
    isLockTimeoutError({ message: 'raw query failed. Code: "55P03"' }),
    true
  );
});

test("nothing else is called lock contention", () => {
  // A statement timeout, a dropped connection and a constraint violation are
  // real failures. Reported as a lock miss they would retry for ever under a
  // name that says nothing went wrong.
  assert.equal(
    isLockTimeoutError(new Error("canceling statement due to statement timeout")),
    false
  );
  assert.equal(isLockTimeoutError({ meta: { code: "40P01" } }), false);
  assert.equal(isLockTimeoutError(new Error("Connection reset by peer")), false);
  assert.equal(isLockTimeoutError(null), false);
  assert.equal(isLockTimeoutError("55P03"), false);
});

test("a transaction that never started is its own answer, not a lock miss", () => {
  // Prisma reports the interactive-transaction start timeout as P2028 on some
  // paths and P2024 on others, so both are matched.
  assert.equal(
    isTransactionStartTimeoutError({
      code: "P2024",
      message: "Timed out fetching a new connection from the connection pool.",
    }),
    true
  );
  assert.equal(
    isTransactionStartTimeoutError({
      code: "P2028",
      message: "Unable to start a transaction in the given time.",
    }),
    true
  );
  assert.equal(isLockTimeoutError({ code: "P2028" }), false);
});

test("a transaction that expired while running is not a start timeout", () => {
  // The same Prisma code carries both, and they mean opposite things: one
  // submitted nothing, the other may have submitted everything. Only the
  // wording tells them apart, and the caller asks only when it knows the
  // callback never ran.
  assert.equal(
    isTransactionStartTimeoutError({
      code: "P2028",
      message:
        "Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction.",
    }),
    false
  );
  assert.equal(
    isTransactionStartTimeoutError({ meta: { code: "55P03" } }),
    false
  );
  assert.equal(isTransactionStartTimeoutError(null), false);
});
