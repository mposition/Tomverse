import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The order the money paths take their two locks, inside the functions that
 * take them.
 *
 * `tests/creditLockOrder.test.mjs` proves every mutator of purchased-credit
 * lots calls `lockCreditAccount` *somewhere*. That is the right question for
 * "did a new caller forget the lock", and the wrong one for "does this
 * function still take them in the order that avoids a deadlock": a call
 * anywhere in a 4,000-line module satisfies it.
 *
 * Two paths now take the same two locks. `settleChatUsage` has always taken
 * them; `reserveAttemptProviderBudget` was added for §7's automatic fallback
 * and can run against the same reservation while a turn is in flight. Two
 * functions taking one pair of locks in different orders is a deadlock that
 * appears under concurrency and nowhere else — which is to say, in production
 * and not in a test that drives one request at a time.
 *
 * So this checks the order *within each function body*:
 *
 *     lockCreditAccount  →  reservation advisory lock  →  read  →  mutate
 *
 * A source scan, for the same reason the file above is one: the failure is a
 * future edit reordering two adjacent statements, and no runtime test that
 * passes today would notice.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(join(root, "lib/chatSecurity.ts"), "utf8");

/**
 * A function's body, from its `export const NAME = ` to the next top-level
 * `export`. Crude, and sufficient: what matters is that the window contains
 * one function and not the next one.
 */
const bodyOf = (name) => {
  const start = source.indexOf(`export const ${name} = `);
  assert.notEqual(start, -1, `${name} is gone; this scan is stale`);
  const next = source.indexOf("\nexport const ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
};

const ACCOUNT_LOCK = "lockCreditAccount(tx";
const RESERVATION_LOCK = "chat-credit-reservation:${";
const RESERVATION_READ = "chatCreditReservation.findUnique";

/** Every function that takes both locks. Adding one means adding it here. */
const LOCKING_FUNCTIONS = [
  "settleChatUsage",
  "reserveAttemptProviderBudget",
  "releaseAttemptProviderBudget",
];

for (const name of LOCKING_FUNCTIONS) {
  test(`${name} takes the account lock before the reservation lock`, () => {
    const body = bodyOf(name);
    const account = body.indexOf(ACCOUNT_LOCK);
    const reservation = body.indexOf(RESERVATION_LOCK);
    assert.notEqual(account, -1, `${name} no longer locks the credit account`);
    assert.notEqual(reservation, -1, `${name} no longer locks the reservation`);
    assert.ok(
      account < reservation,
      `${name} takes the reservation lock first. Every path that takes both ` +
        "must take them in one order, or two of them deadlock under " +
        "concurrency and nowhere else."
    );
  });

  test(`${name} reads the reservation only after locking it`, () => {
    // A read before the lock is a read of a row another transaction is in the
    // middle of settling, and the decision made from it is stale by the time
    // it is acted on.
    const body = bodyOf(name);
    const reservation = body.indexOf(RESERVATION_LOCK);
    const read = body.indexOf(RESERVATION_READ);
    assert.notEqual(read, -1, `${name} no longer reads the reservation`);
    assert.ok(
      reservation < read,
      `${name} reads the reservation before locking it.`
    );
  });
}

test("the attempt set is refused before any lock is taken", () => {
  // `attemptSetProblems` raises on a malformed set. It runs outside the
  // transaction on purpose: nothing has been locked and no money has moved
  // when it does, so the caller's retry is against an untouched reservation.
  const body = bodyOf("settleChatUsage");
  const validation = body.indexOf("attemptSetProblems(");
  const transaction = body.indexOf("prisma.$transaction");
  assert.notEqual(validation, -1, "settleChatUsage no longer validates the set");
  assert.ok(
    validation < transaction,
    "attemptSetProblems runs inside the transaction. A malformed set would " +
      "then raise with the account and the reservation locked, and the " +
      "refusal would cost a lock nobody needed to take."
  );
});

test("the set is validated before it is interpreted", () => {
  // No safety difference — `combineAttemptUsage` is pure — but "check, then
  // read" is the order an auditor can follow, and the reverse invites a later
  // edit that acts on the interpretation before the check.
  const body = bodyOf("settleChatUsage");
  assert.ok(
    body.indexOf("attemptSetProblems(") < body.indexOf("combineAttemptUsage("),
    "settleChatUsage interprets the attempt set before validating it"
  );
});

test("the scan can tell a correct order from a reversed one", () => {
  // A negative control on inputs. Without it, anchors that had drifted would
  // make every assertion above pass vacuously.
  const correct = `lockCreditAccount(tx, x); pg_advisory_xact_lock(hashtext(\${\`chat-credit-reservation:\${id}\`}))`;
  const reversed = `pg_advisory_xact_lock(hashtext(\${\`chat-credit-reservation:\${id}\`})); lockCreditAccount(tx, x)`;
  assert.ok(correct.indexOf(ACCOUNT_LOCK) < correct.indexOf(RESERVATION_LOCK));
  assert.ok(reversed.indexOf(ACCOUNT_LOCK) > reversed.indexOf(RESERVATION_LOCK));
});
