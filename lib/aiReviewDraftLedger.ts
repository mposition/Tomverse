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
 *   1. take the lock;
 *   2. balance = settled + reservations that never settled;
 *   3. refuse if balance + this call would pass the approved total;
 *   4. write the reservation;
 *   5. release the lock, then call the provider;
 *   6. write the settlement, whatever the outcome.
 *
 * A reservation that never settles keeps occupying the budget for ever. That
 * is deliberate and it is the safe direction: the call it stands for was very
 * likely billed, and an operator who knows it was not can say so by settling
 * it. Releasing it automatically would mean a process that dies at exactly the
 * wrong moment quietly gets its money back.
 */

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
          /** What the call actually cost us, bounded by its reservation. */
          costCeilingUsd: number;
          outcome: string;
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
    const reservations = new Map<string, number>();
    const settled = new Set<string>();
    let settledUsd = 0;

    for (const [index, line] of lines.entries()) {
        if (line.trim() === "") continue;
        let entry: AiReviewDraftLedgerEntry;
        try {
            entry = JSON.parse(line) as AiReviewDraftLedgerEntry;
        } catch (error) {
            problems.push(
                `line ${index + 1} cannot be read: ${(error as Error).message}`
            );
            continue;
        }
        if (entry.op === "reserve") {
            if (typeof entry.id !== "string" || entry.id === "") {
                problems.push(`line ${index + 1}: a reservation with no id`);
                continue;
            }
            if (reservations.has(entry.id)) {
                problems.push(`line ${index + 1}: reservation "${entry.id}" appears twice`);
                continue;
            }
            if (!Number.isFinite(entry.costCeilingUsd) || entry.costCeilingUsd < 0) {
                problems.push(`line ${index + 1}: reservation "${entry.id}" has no cost`);
                continue;
            }
            reservations.set(entry.id, entry.costCeilingUsd);
            continue;
        }
        if (entry.op === "settle") {
            const held = reservations.get(entry.reservationId);
            if (held === undefined) {
                problems.push(
                    `line ${index + 1}: settles "${entry.reservationId}", which was never reserved`
                );
                continue;
            }
            if (settled.has(entry.reservationId)) {
                problems.push(
                    `line ${index + 1}: "${entry.reservationId}" was already settled`
                );
                continue;
            }
            if (!Number.isFinite(entry.costCeilingUsd) || entry.costCeilingUsd < 0) {
                problems.push(`line ${index + 1}: settlement has no cost`);
                continue;
            }
            // A settlement may not cost more than its reservation held. If it
            // did, the reservation was not a bound and the budget check that
            // let the call through was measuring the wrong number.
            if (entry.costCeilingUsd > held) {
                problems.push(
                    `line ${index + 1}: "${entry.reservationId}" settled at ` +
                        `${entry.costCeilingUsd} above its reservation of ${held}`
                );
            }
            settled.add(entry.reservationId);
            settledUsd += Math.min(entry.costCeilingUsd, held);
            continue;
        }
        problems.push(`line ${index + 1}: unknown entry`);
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
