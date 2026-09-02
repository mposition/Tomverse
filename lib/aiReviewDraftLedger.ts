/**
 * The spend ledger for paid candidate drafting: reserve first, settle after.
 *
 * docs/ops/ai-review-eval-runbook.md §1.1b.
 *
 * ## Why a settle-only ledger loses money
 *
 * The first version appended one line after a call produced usable cases. Four
 * ways a call was billed and left no trace:
 *
 *   * HTTP 200 with nothing usable in it -- the script exited before the write;
 *   * a reply that would not parse -- same exit, same silence;
 *   * the process dying between the response and the write;
 *   * two processes reading the same balance and each deciding it had room.
 *
 * The comment said "appended after the call whether or not anything usable came
 * back", and the control flow said otherwise. A budget that only counts
 * successes is not a budget: a run of unusable replies spends without moving
 * the total, and the total is what a person approved.
 *
 * ## Reserve, then settle
 *
 * This is the shape the repository already uses for credits, for the same
 * reason (docs/policy/credit-and-cost-limits.md §9): the decision to spend and
 * the record of spending cannot be the same event, because everything between
 * them can fail.
 *
 *   1. take the lock, and hold it for the whole run;
 *   2. balance = settled + reservations that never settled, each at its
 *      corrected ceiling;
 *   3. refuse if any reservation is outstanding, or if this call would pass
 *      the approved total;
 *   4. write the reservation;
 *   5. call the provider, still holding the lock;
 *   6. re-read the decision set, append to it, write it back;
 *   7. write the settlement, whatever the outcome, and only then release.
 *
 * The lock spans the whole run rather than the ledger read. Both runs read the
 * decision set, append to their own copy and write the file back, so a budget
 * that admitted two calls paid for two and kept one. Serialising costs nothing
 * here: this tool sends one batch at a time, 330 times.
 *
 * A reservation that never settles keeps occupying the budget for ever. That
 * is deliberate and it is the safe direction: the call it stands for was very
 * likely billed, and an operator who knows it was not can say so by settling
 * it. Releasing it automatically would mean a process that dies at exactly the
 * wrong moment quietly gets its money back.
 *
 * ## Every figure here is a ceiling
 *
 * Nothing in this file is what a provider billed -- the drafter never learns
 * that. A reservation holds the most a call could cost, and its settlement
 * records that same ceiling rather than an outcome-dependent amount. So the
 * running total is a COMMITTED CEILING, the operator-facing wording says so,
 * and the approved total is a bound on what could have been spent rather than
 * a measurement of what was.
 *
 * ## Corrections
 *
 * A ceiling can turn out to have been computed wrongly -- the input-token
 * bound was replaced after the first paid batch, and the reservation that
 * batch wrote was too small. A past line is never edited: it is what the run
 * actually did, and a ledger whose history changes underneath an approval is
 * not a record. Instead a `correct` entry names the reservation, carries the
 * ceiling it was written with and the ceiling it should have had, and the
 * difference lands in the running total.
 */

const isNonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.trim() !== "";

export type AiReviewDraftLedgerEntry =
    | {
          op: "reserve";
          /** Unique per call. The settlement names it. */
          id: string;
          at: string;
          costCeilingUsd: number;
          [key: string]: unknown;
      }
    | {
          op: "settle";
          reservationId: string;
          at: string;
          /**
           * The reservation's ceiling, repeated. Not what the provider billed:
           * the drafter never learns that, so a settlement closes a
           * reservation rather than measuring it.
           */
          costCeilingUsd: number;
          outcome: string;
          [key: string]: unknown;
      }
    | {
          op: "correct";
          reservationId: string;
          at: string;
          /** The ceiling the reservation was written with. Must match. */
          previousCostCeilingUsd: number;
          /** What it should have been. */
          costCeilingUsd: number;
          /** Why, in a sentence a person can audit. */
          reason: string;
          [key: string]: unknown;
      };

export type AiReviewDraftLedgerBalance = {
    /**
     * Settled calls, at the CEILING each was reserved at -- not at what the
     * provider actually billed, which this tool never learns. Every number
     * here is a committed ceiling, and the operator-facing wording says so:
     * calling it spend would claim a precision the ledger does not have.
     */
    settledUsd: number;
    /** Reservations with no settlement. Held against the budget. */
    outstandingUsd: number;
    /** Committed ceiling: what the approved total has to be measured against. */
    committedUsd: number;
    settledCount: number;
    outstandingCount: number;
    /** Why the balance cannot be trusted, if it cannot. */
    problems: readonly string[];
};

/**
 * Reads a ledger.
 *
 * A line that cannot be parsed, a settlement naming no reservation, and a
 * reservation settled twice are all reported rather than skipped: each means
 * the total is not what the file says, and continuing to spend against a total
 * nobody can compute is the failure this whole mechanism exists to prevent.
 */
export const ledgerBalance = (
    lines: readonly string[]
): AiReviewDraftLedgerBalance => {
    const problems: string[] = [];
    const parsed: { entry: AiReviewDraftLedgerEntry; line: number }[] = [];
    for (const [index, line] of lines.entries()) {
        if (line.trim() === "") continue;
        try {
            parsed.push({
                entry: JSON.parse(line) as AiReviewDraftLedgerEntry,
                line: index + 1,
            });
        } catch (error) {
            problems.push(
                `line ${index + 1} cannot be read: ${(error as Error).message}`
            );
        }
    }

    // First pass: reservations and the corrections that restate them.
    //
    // Two passes because a correction may be written long after the settlement
    // it affects -- the first paid batch was corrected days later -- and a
    // settlement has to be checked against the ceiling that ends up standing,
    // not the one that happened to be read first.
    const reservations = new Map<string, number>();
    for (const { entry, line } of parsed) {
        if (entry.op !== "reserve") continue;
        if (typeof entry.id !== "string" || entry.id === "") {
            problems.push(`line ${line}: a reservation with no id`);
            continue;
        }
        if (reservations.has(entry.id)) {
            problems.push(`line ${line}: reservation "${entry.id}" appears twice`);
            continue;
        }
        if (!Number.isFinite(entry.costCeilingUsd) || entry.costCeilingUsd < 0) {
            problems.push(`line ${line}: reservation "${entry.id}" has no cost`);
            continue;
        }
        reservations.set(entry.id, entry.costCeilingUsd);
    }
    for (const { entry, line } of parsed) {
        if (entry.op !== "correct") continue;
        const held = reservations.get(entry.reservationId);
        if (held === undefined) {
            problems.push(
                `line ${line}: corrects "${entry.reservationId}", which was never reserved`
            );
            continue;
        }
        // The correction states what it is replacing. If that does not match
        // the ceiling standing at this point, two corrections have been
        // written against the same reservation from the same starting figure,
        // or one of them is about a different line than its author thought --
        // and either way the running total is not what anybody computed.
        if (entry.previousCostCeilingUsd !== held) {
            problems.push(
                `line ${line}: corrects "${entry.reservationId}" from ` +
                    `${entry.previousCostCeilingUsd}, but ${held} is what stands`
            );
            continue;
        }
        if (!Number.isFinite(entry.costCeilingUsd) || entry.costCeilingUsd < 0) {
            problems.push(`line ${line}: correction has no cost`);
            continue;
        }
        if (!isNonEmptyString(entry.reason)) {
            problems.push(
                `line ${line}: correction of "${entry.reservationId}" gives no reason`
            );
            continue;
        }
        reservations.set(entry.reservationId, entry.costCeilingUsd);
    }

    // Second pass: settlements, against the ceilings that stand.
    const settled = new Set<string>();
    let settledUsd = 0;
    for (const { entry, line } of parsed) {
        if (entry.op === "reserve" || entry.op === "correct") continue;
        if (entry.op !== "settle") {
            problems.push(`line ${line}: unknown entry`);
            continue;
        }
        const held = reservations.get(entry.reservationId);
        if (held === undefined) {
            problems.push(
                `line ${line}: settles "${entry.reservationId}", which was never reserved`
            );
            continue;
        }
        if (settled.has(entry.reservationId)) {
            problems.push(`line ${line}: "${entry.reservationId}" was already settled`);
            continue;
        }
        if (!Number.isFinite(entry.costCeilingUsd) || entry.costCeilingUsd < 0) {
            problems.push(`line ${line}: settlement has no cost`);
            continue;
        }
        // A settlement may not close for more than its reservation holds. If
        // it did, the reservation was not a bound and the budget check that
        // let the call through was measuring the wrong number. A correction
        // that raised the ceiling makes this pass; that is the point of one.
        if (entry.costCeilingUsd > held) {
            problems.push(
                `line ${line}: "${entry.reservationId}" settled at ` +
                    `${entry.costCeilingUsd} above its reservation of ${held}`
            );
        }
        settled.add(entry.reservationId);
        // The corrected ceiling, not the figure the settlement carries: a
        // settlement written before its correction still names the old one,
        // and the total has to reflect what the reservation now stands at.
        settledUsd += held;
    }

    let outstandingUsd = 0;
    let outstandingCount = 0;
    for (const [id, held] of reservations) {
        if (settled.has(id)) continue;
        outstandingUsd += held;
        outstandingCount += 1;
    }

    return {
        settledUsd,
        outstandingUsd,
        committedUsd: settledUsd + outstandingUsd,
        settledCount: settled.size,
        outstandingCount,
        problems,
    };
};

export type AiReviewDraftSpendDecision =
    | { allowed: true; committedUsd: number; remainingUsd: number }
    | { allowed: false; reason: string };

/**
 * Whether one more call fits, given the ledger and the approved total.
 *
 * Pure, so the rule can be tested without a filesystem or a provider -- and
 * so the script that spends money has one small thing to get right rather than
 * an arithmetic of its own.
 */
export const admitDraftCall = (input: {
    balance: AiReviewDraftLedgerBalance;
    callCostCeilingUsd: number | null;
    maxTotalCostUsd: number | null;
}): AiReviewDraftSpendDecision => {
    if (input.balance.problems.length > 0) {
        return {
            allowed: false,
            reason:
                `the ledger cannot be read, so the total spent is unknown:\n  - ` +
                `${input.balance.problems.slice(0, 5).join("\n  - ")}`,
        };
    }
    // An unsettled reservation means a run is either still going or died
    // holding one, and in both cases another call must not start.
    //
    // The budget arithmetic alone would let one through whenever there was
    // room, and room is not the only question: a second run reads the same
    // decision set, appends its own cases to its own copy and writes the whole
    // file back, so whichever finishes last erases the other's work. The
    // ledger cannot see that, which is why the rule is stated here rather than
    // left to the totals.
    if (input.balance.outstandingCount > 0) {
        return {
            allowed: false,
            reason:
                `${input.balance.outstandingCount} reservation(s) worth ` +
                `~$${input.balance.outstandingUsd.toFixed(4)} have not settled. ` +
                `Either a drafting run is still going -- and two runs would overwrite ` +
                `each other's cases in the decision set -- or one died holding a ` +
                `reservation, which has to be accounted for before more is spent`,
        };
    }
    if (
        input.maxTotalCostUsd === null ||
        !Number.isFinite(input.maxTotalCostUsd) ||
        input.maxTotalCostUsd <= 0
    ) {
        return { allowed: false, reason: "no approved total" };
    }
    if (
        input.callCostCeilingUsd === null ||
        !Number.isFinite(input.callCostCeilingUsd) ||
        input.callCostCeilingUsd < 0
    ) {
        return {
            allowed: false,
            reason:
                "this call's cost cannot be bounded, and a budget enforced against " +
                "an unknown price is not a budget",
        };
    }
    const after = input.balance.committedUsd + input.callCostCeilingUsd;
    if (after > input.maxTotalCostUsd) {
        return {
            allowed: false,
            reason:
                `this call's ceiling is ~$${input.callCostCeilingUsd.toFixed(4)} and ` +
                `~$${input.balance.committedUsd.toFixed(4)} is already committed ` +
                `(${input.balance.settledCount} settled, ${input.balance.outstandingCount} ` +
                `outstanding), which would reach ~$${after.toFixed(4)} against the ` +
                `approved $${input.maxTotalCostUsd.toFixed(2)}`,
        };
    }
    return {
        allowed: true,
        committedUsd: input.balance.committedUsd,
        remainingUsd: input.maxTotalCostUsd - after,
    };
};
