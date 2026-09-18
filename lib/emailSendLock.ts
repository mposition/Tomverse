import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  isLockTimeoutError,
  isTransactionStartTimeoutError,
  SEND_COMMIT_RESERVE_MS,
  STANDARD_SEND_LOCK_TIMEOUT_MS,
  STANDARD_SEND_TRANSACTION_TIMEOUT_MS,
} from "@/lib/emailSendLockCore";
import { lockEmailPreferenceRow } from "@/lib/emailPreferences";
import {
  normalizeSuppressionAddress,
  suppressionCheck,
} from "@/lib/emailSuppression";
import {
  holdSuppressionFence,
  lockSuppressionAddress,
} from "@/lib/emailSuppressionAuthority";
import type { SendClassification } from "@/lib/emailSuppressionCore";

/**
 * The one door every customer-facing send goes through.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 7.4 (C29),
 * docs/policy/email-notifications.md section 9.8.
 *
 * The race it closes: a lane checks suppression, then reads templates, renders,
 * composes a footer and finally calls the provider. Everything committed in
 * between is invisible to it -- so somebody who unsubscribed, complained or
 * asked for their data to be deleted while a message was being rendered still
 * received it, and the audit record said we had checked.
 *
 * So the check is taken again here, under the locks a withdrawal and a
 * suppression writer both take, and the provider submission happens *inside*
 * that scope. Whichever side commits first wins, and the loser observes it:
 * a withdrawal that gets there first is seen by the re-check, and a submission
 * that gets there first is finished before the withdrawal's transaction
 * returns to the person who asked for it.
 *
 * **Lock order is the address, then the purpose row**, the same prefix every
 * writer takes (lib/emailPreferences.ts). The `User` row lock a writer takes
 * first is deliberately *not* taken here: a sender changes nothing about the
 * account, and taking it after the address would be the one ordering that can
 * deadlock against a withdrawal.
 *
 * **This transaction writes nothing.** It reads a setting and the causes, holds
 * advisory locks, and calls the provider. That is what makes the recovery in
 * the catch safe: a rollback after a successful submission loses no row, so the
 * provider's answer is kept rather than thrown away with the transaction.
 *
 * **The provider call runs with the transaction open.** That is the point -- a
 * lock released before the submission protects nothing -- and it is why the
 * budgets are explicit (lib/emailSendLockCore.ts).
 */

export type SendLockResult<T> =
  | {
      ok: true;
      value: T;
      /** The verdict's own signal, raised by the caller in its own words. */
      raiseIncident: "transactional_complaint" | null;
    }
  /** A suppression this address has now, whatever the earlier check saw. */
  | { ok: false; reason: "suppressed"; skipReason: string }
  /**
   * The send never reached the provider: somebody else holds the address
   * (`lock`), no connection came free in time so the transaction never started
   * (`pool`), or the transaction had too little life left to protect a
   * submission (`budget`). Nothing was submitted and nothing was written; the
   * caller releases its claim and lets the existing backoff bring the message
   * back, without counting an attempt (section 7.4, time budgets).
   *
   * The three are one outcome because they are one decision -- wait and try
   * again -- and three names because an operator reading the log needs to know
   * whether the address is busy, this process is, or the budgets are wrong.
   */
  | { ok: false; reason: "lock_unavailable"; cause: "lock" | "pool" | "budget" };

/** Raised inside the transaction when the lock budget is spent. Never escapes. */
class SendLockBudgetSpent extends Error {
  constructor() {
    super("The send lock budget was spent before every lock was held.");
    this.name = "SendLockBudgetSpent";
  }
}

/**
 * Sets `lock_timeout` to what is left of the budget, before each lock.
 *
 * Postgres applies `lock_timeout` to **each** lock acquisition, not to the
 * transaction: setting it once and taking three locks would allow three times
 * the wait the contract names, and a send that waited behind the cutover's
 * fence would then start a fresh full wait for the address. One deadline,
 * re-derived before every lock, is what makes "waits at most N" true of the
 * sequence rather than of each step.
 *
 * `set_config(..., true)` is `SET LOCAL`: it ends with this transaction, so a
 * connection this one borrowed cannot hand a two-second lock budget to whatever
 * runs next.
 */
const spendBudget = async (tx: Prisma.TransactionClient, deadline: number) => {
  const remaining = deadline - monotonicNow();
  if (remaining <= 0) throw new SendLockBudgetSpent();
  await tx.$queryRaw`SELECT set_config('lock_timeout', ${String(Math.ceil(remaining))}, true)`;
};

/**
 * Not `Date.now()`: the budget is an elapsed-time question, and a wall clock
 * that steps back over an NTP correction would hand a send more budget than it
 * was given, or less.
 */
const monotonicNow = () => performance.now();

/**
 * Checked after the last lock as well as before each of them.
 *
 * `lock_timeout` bounds the *wait* for one lock. It says nothing about the two
 * statements around it, and a lock that is granted a moment after the deadline
 * is still granted -- so without this the sequence could finish late and go on
 * to read and submit as though it had not. The locks are released by the
 * rollback, and the caller waits for its next pass.
 */
const budgetSpent = (deadline: number) => monotonicNow() >= deadline;

/** One line, and no recipient: the row itself records only that it is waiting. */
const lockUnavailable = <T,>(
  input: { classification: SendClassification; purpose?: string | null },
  waitedMs: number,
  cause: "lock" | "pool" | "budget"
): SendLockResult<T> => {
  console.warn(
    JSON.stringify({
      event: "email_send_lock_unavailable",
      cause,
      classification: input.classification,
      purpose: input.purpose ?? null,
      waitedMs,
    })
  );
  return { ok: false, reason: "lock_unavailable", cause };
};

export async function sendWithAddressLock<T>(input: {
  emailAddress: string;
  classification: SendClassification;
  /** Locked and re-checked when the message belongs to one. */
  purpose?: string | null;
  /** The account whose preference row carries that purpose, when there is one. */
  userId?: string | null;
  now?: Date;
  /** The whole wait for all of the locks, not the wait for each of them. */
  lockTimeoutMs?: number;
  transactionTimeoutMs?: number;
  /**
   * The longest this lane would ever give the provider. What the submission
   * actually gets is this or what the transaction has left, whichever is less.
   */
  providerTimeoutMs?: number;
  /**
   * The provider submission. Runs holding the locks; must not write rows, and
   * must bound itself by the budget it is handed -- the transaction's own
   * timeout cannot stop an HTTP request.
   */
  submit: (budget: { providerTimeoutMs: number }) => Promise<T>;
}): Promise<SendLockResult<T>> {
  const lockTimeoutMs = Math.max(
    1,
    Math.round(input.lockTimeoutMs ?? STANDARD_SEND_LOCK_TIMEOUT_MS)
  );
  const transactionTimeoutMs = Math.max(
    lockTimeoutMs,
    Math.round(input.transactionTimeoutMs ?? STANDARD_SEND_TRANSACTION_TIMEOUT_MS)
  );
  const normalized = normalizeSuppressionAddress(input.emailAddress);

  // Set the moment the callback starts, so a failure can be told apart from a
  // transaction that never started. Prisma reports both as P2028, and they mean
  // opposite things: one submitted nothing, the other may have submitted
  // everything.
  let started = false;
  // Which statements a lock timeout may have come from. Once the locks are
  // held, a 55P03 is an ordinary relation lock giving up -- a failure, not this
  // address being busy -- and reporting it as contention would retry it for
  // ever under a name that says nothing went wrong.
  let inLockPhase = true;
  // Kept outside the transaction so a rollback after a successful submission
  // does not take the provider's answer with it.
  let submitted:
    | { value: T; raiseIncident: "transactional_complaint" | null }
    | null = null;

  // Taken **before** the call, not inside the callback: Prisma's `timeout`
  // covers the whole transaction, which has already begun by the time the
  // callback runs, and the wait for a connection comes before that again. A
  // deadline measured from the callback would sit *after* the one Prisma is
  // keeping, which is the wrong side -- the budget cut from it has to expire
  // first, or the rollback releases the address while the submission it was
  // protecting is still in flight. This one is conservative by exactly the
  // time those two steps take.
  const transactionDeadline = monotonicNow() + transactionTimeoutMs;

  try {
    return await prisma.$transaction(
      async (tx): Promise<SendLockResult<T>> => {
        started = true;
        // The lock budget, but never past what the transaction can protect:
        // the wait for a connection has already come out of the same deadline,
        // and a fresh full wait here would let a caller spend its budget twice
        // (independent review, round 6).
        const deadline = Math.min(
          monotonicNow() + lockTimeoutMs,
          transactionDeadline - SEND_COMMIT_RESERVE_MS
        );
        if (budgetSpent(deadline)) {
          return lockUnavailable(input, transactionTimeoutMs, "budget");
        }
        // What this connection had before the budget was imposed, so the reads
        // that follow the locks are restored to it rather than left on a
        // sender's budget -- a relation lock that timed out at two seconds
        // would be reported as address contention, which it is not.
        const settings = await tx.$queryRaw<
          Array<{ lock_timeout: string }>
        >`SELECT current_setting('lock_timeout') AS lock_timeout`;
        // Postgres always answers this, but a client that does not is not a
        // reason to fail a send: `0` is the server default and the value every
        // other query on this connection runs under.
        const restoreTo = settings[0]?.lock_timeout ?? "0";

        // Shared, like every other reader of the suppression record: the
        // cutover holds it exclusively, so this decision cannot be taken under
        // one read authority and acted on under the other.
        await spendBudget(tx, deadline);
        await holdSuppressionFence(tx);
        await spendBudget(tx, deadline);
        await lockSuppressionAddress(tx, normalized);
        if (input.userId && input.purpose) {
          await spendBudget(tx, deadline);
          await lockEmailPreferenceRow(tx, input.userId, input.purpose);
        }
        // The last lock may have been granted after the deadline: `lock_timeout`
        // bounds one wait, not the sequence. A send that finished the lock phase
        // late goes back on its curve rather than reading and submitting as
        // though it had not.
        if (budgetSpent(deadline)) throw new SendLockBudgetSpent();
        inLockPhase = false;
        // The budget was for the locks. What follows takes only ordinary read
        // locks, and a timeout sized to whatever the budget had left would fail
        // them for no reason.
        await tx.$queryRaw`SELECT set_config('lock_timeout', ${restoreTo}, true)`;

        const verdict = await suppressionCheck({
          emailAddress: normalized,
          classification: input.classification,
          ...(input.purpose ? { purpose: input.purpose } : {}),
          ...(input.now ? { now: input.now } : {}),
          client: tx,
        });
        if (!verdict.allowed) {
          return { ok: false, reason: "suppressed", skipReason: verdict.skipReason };
        }

        // From here the locks are held and the reads are done, so what is left
        // of the transaction is what is left to protect the submission. The
        // provider gets that, less the room to finish, and never more than the
        // lane would give it anyway.
        const left =
          transactionDeadline - monotonicNow() - SEND_COMMIT_RESERVE_MS;
        // Whole milliseconds, because `AbortSignal.timeout()` validates a
        // uint32 and throws `ERR_OUT_OF_RANGE` on the fraction that
        // `performance.now()` arithmetic produces. Rounded down, so the cut is
        // never generous.
        const providerTimeoutMs = Math.floor(
          Math.min(input.providerTimeoutMs ?? left, left)
        );
        if (providerTimeoutMs < 1) {
          // The locks and the reads took the transaction's life. Submitting now
          // would mean a request still in flight after the rollback released
          // the address -- after a withdrawal could have taken it and answered.
          return lockUnavailable(input, transactionTimeoutMs, "budget");
        }

        const answer = {
          value: await input.submit({ providerTimeoutMs }),
          raiseIncident: verdict.raiseIncident ?? null,
        };
        submitted = answer;
        return { ok: true, ...answer };
      },
      {
        timeout: transactionTimeoutMs,
        // The wait for a connection, which comes before the lock budget rather
        // than inside it, so the whole call is bounded by the two together.
        maxWait: lockTimeoutMs,
      }
    );
  } catch (error) {
    const answer = submitted as {
      value: T;
      raiseIncident: "transactional_complaint" | null;
    } | null;
    if (answer) {
      // The provider has the message and this transaction wrote nothing, so its
      // rollback costs nothing -- but discarding the answer would cost a retry
      // of a message that has already gone out. Loud, because a transaction
      // that expired around a successful send means the budgets are wrong.
      console.warn(
        JSON.stringify({
          event: "email_send_lock_lost_after_submit",
          classification: input.classification,
          error: error instanceof Error ? error.name : "unknown",
        })
      );
      return { ok: true, value: answer.value, raiseIncident: answer.raiseIncident };
    }

    // Nothing ran at all: no connection came free inside `maxWait`. Asked only
    // here, because the same Prisma code also reports a transaction that
    // expired while running -- and that one may have submitted.
    if (!started && isTransactionStartTimeoutError(error)) {
      return lockUnavailable(input, lockTimeoutMs, "pool");
    }
    // By name as well as by identity: a client that re-wrapped the callback's
    // error would otherwise turn a spent budget into a failed delivery.
    const budgetSpentError =
      error instanceof SendLockBudgetSpent ||
      (error instanceof Error && error.name === "SendLockBudgetSpent");
    if (budgetSpentError || (inLockPhase && isLockTimeoutError(error))) {
      return lockUnavailable(input, lockTimeoutMs, "lock");
    }
    throw error;
  }
}
