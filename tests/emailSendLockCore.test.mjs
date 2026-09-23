import assert from "node:assert/strict";
import test from "node:test";

import {
  credentialSendWindow,
  CREDENTIAL_SEND_LOCK_TIMEOUT_MS,
  CREDENTIAL_SEND_RESERVE_MS,
  isLockTimeoutError,
  isTransactionStartTimeoutError,
  providerSendBudget,
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

// ---------------------------------------------------------------------------
// The credential attempt's window
// ---------------------------------------------------------------------------

test("a credential attempt's waits all come out of the request budget", () => {
  const window = credentialSendWindow({
    budgetLeftMs: CREDENTIAL_SEND_BUDGET_MS,
    attemptTimeoutMs: CREDENTIAL_ATTEMPT_TIMEOUT_MS,
  });
  assert.equal(window.send, true);
  if (!window.send) return;
  // The connection and the locks share one budget, and it is the request's.
  assert.ok(window.lockTimeoutMs <= CREDENTIAL_SEND_BUDGET_MS);
  assert.equal(window.lockTimeoutMs, CREDENTIAL_SEND_LOCK_TIMEOUT_MS);
  assert.equal(window.providerCapMs, CREDENTIAL_ATTEMPT_TIMEOUT_MS);
  // The ceiling is what the request has left plus the room to commit. It is a
  // function of the budget, not of the caps: half a budget buys half a
  // ceiling, and a spent one buys nothing at all.
  assert.equal(
    window.transactionTimeoutMs,
    CREDENTIAL_SEND_BUDGET_MS + SEND_COMMIT_RESERVE_MS
  );
  const half = credentialSendWindow({
    budgetLeftMs: CREDENTIAL_SEND_BUDGET_MS / 2,
    attemptTimeoutMs: CREDENTIAL_ATTEMPT_TIMEOUT_MS,
  });
  assert.equal(half.send, true);
  if (!half.send) return;
  assert.ok(
    half.transactionTimeoutMs < window.transactionTimeoutMs,
    "the ceiling tracks the budget rather than the caps"
  );
  assert.ok(half.providerCapMs < window.providerCapMs);
});

test("a budget already spent starts no wait at all", () => {
  // Not even a connection: the old shape would still have waited 300ms for one
  // and 300ms more for a lock before finding there was nothing to send.
  for (const budgetLeftMs of [-1_000, -1, 0, 1, CREDENTIAL_SEND_RESERVE_MS]) {
    assert.equal(
      credentialSendWindow({
        budgetLeftMs,
        attemptTimeoutMs: CREDENTIAL_ATTEMPT_TIMEOUT_MS,
      }).send,
      false,
      `budgetLeftMs=${budgetLeftMs}`
    );
  }
});

test("a small budget shrinks every wait rather than refusing outright", () => {
  const window = credentialSendWindow({
    budgetLeftMs: 400,
    attemptTimeoutMs: CREDENTIAL_ATTEMPT_TIMEOUT_MS,
  });
  assert.equal(window.send, true);
  if (!window.send) return;
  assert.equal(window.lockTimeoutMs, 300);
  assert.equal(window.providerCapMs, 400 - CREDENTIAL_SEND_RESERVE_MS);
  assert.equal(window.transactionTimeoutMs, 400 + SEND_COMMIT_RESERVE_MS);
});

test("every wait a credential attempt may start is a whole number", () => {
  // `AbortSignal.timeout()` and `SET LOCAL lock_timeout` both want integers,
  // and the budget arrives as a difference of clocks.
  const window = credentialSendWindow({
    budgetLeftMs: 1_234.567,
    attemptTimeoutMs: 999.99,
  });
  assert.equal(window.send, true);
  if (!window.send) return;
  for (const value of [
    window.lockTimeoutMs,
    window.transactionTimeoutMs,
    window.providerCapMs,
  ]) {
    assert.equal(Number.isInteger(value), true, `not whole: ${value}`);
  }
});

// ---------------------------------------------------------------------------
// What the provider is given
// ---------------------------------------------------------------------------

test("the provider gets the lane cap, or what the transaction has left", () => {
  // The cut used to be observable from a test that read it out of the submit
  // callback. The helper owns the submission now, so the number reaches the
  // provider through a mocked `fetch` where it cannot be read -- which is why
  // the arithmetic is here (independent review, 2026-09-18).
  assert.deepEqual(providerSendBudget({ leftMs: 12_000, capMs: 10_000 }), {
    send: true,
    providerTimeoutMs: 10_000,
  });
  assert.deepEqual(providerSendBudget({ leftMs: 4_000, capMs: 10_000 }), {
    send: true,
    providerTimeoutMs: 4_000,
  });
  // No cap: the transaction is the only bound.
  assert.deepEqual(providerSendBudget({ leftMs: 4_000 }), {
    send: true,
    providerTimeoutMs: 4_000,
  });
});

test("the provider's budget is always a whole number, rounded down", () => {
  // `AbortSignal.timeout()` validates a uint32 and throws `ERR_OUT_OF_RANGE`
  // on the fraction `performance.now()` arithmetic produces. Down, so the cut
  // is never generous.
  const budget = providerSendBudget({ leftMs: 1_234.987, capMs: 9_999.5 });
  assert.equal(budget.send, true);
  if (!budget.send) return;
  assert.equal(budget.providerTimeoutMs, 1_234);
});

test("less than a millisecond left is no call at all", () => {
  // The request would be in flight after the rollback released the address.
  for (const leftMs of [0.9, 0, -1, -10_000]) {
    assert.deepEqual(
      providerSendBudget({ leftMs, capMs: 10_000 }),
      { send: false },
      `leftMs=${leftMs}`
    );
  }
  // And a cap of zero is a caller asking for no call.
  assert.deepEqual(providerSendBudget({ leftMs: 10_000, capMs: 0 }), { send: false });
});
