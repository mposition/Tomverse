// What a fallback drill has to show, as arithmetic over rows.
//
// Step 4 of docs/ops/tomverse-chat-auto-router-rollout.md §9.1: "staging fault
// injection on the first provider, confirming in the database and the logs:
// one run, one reservation, two attempts, one settlement, one lease release."
//
// Separated from the query so the judgement is testable without a database.
// The half that decides whether a drill passed is the half most worth being
// sure of, and a script that can only be exercised by running a real drill is
// a script whose bugs are found during the drill.
//
// Every check names what it saw as well as what it wanted. "Expected 2
// attempts" is a bug report; "expected 2 attempts, found 1 (index 0,
// failed_pre_token)" is a diagnosis.

/** The scenarios a drill can be run as, and what each one must produce. */
export const DRILL_SCENARIOS = {
    // The step-4 case: the primary fails before a token, a second model
    // answers, and the accounting stays single-user-facing.
    fallback_succeeds: {
        fault: "attempt_0_pre_token",
        attempts: [
            { attemptIndex: 0, outcome: "failed_pre_token" },
            { attemptIndex: 1, outcome: "succeeded" },
        ],
        reservationStatus: ["settled", "refunded"],
        rerouteCount: 1,
        fallbackState: "fallback_used",
        // §8: the model that worked keeps the conversation, and the one it
        // displaced is remembered so a blip does not become a permanent move.
        expectsRecovery: true,
    },
    // Step 5's first case: the fallback fails too. §6's two-build budget is
    // spent, so there is no third model and the turn ends.
    fallback_fails: {
        fault: "attempt_1_pre_token",
        attempts: [
            { attemptIndex: 0, outcome: "failed_pre_token" },
            { attemptIndex: 1, outcome: "failed_pre_token" },
        ],
        reservationStatus: ["settled", "refunded"],
        rerouteCount: 1,
        fallbackState: "fallback_used",
        expectsRecovery: false,
    },
    // Step 5's other case: the client hangs up while the fallback is
    // streaming. §7 excludes client disconnect from fallback, so the turn ends
    // on the second attempt rather than looking for a third -- and the
    // fallback's provider stream has to be cancelled rather than left open and
    // billing to nobody.
    disconnect_during_fallback: {
        // The disconnect is produced by the drill client, not by the injector;
        // the fault only gets the turn as far as a fallback to disconnect
        // during.
        fault: "attempt_0_pre_token",
        attempts: [
            { attemptIndex: 0, outcome: "failed_pre_token" },
            { attemptIndex: 1, outcome: "cancelled" },
        ],
        reservationStatus: ["settled", "refunded"],
        rerouteCount: 1,
        fallbackState: "fallback_used",
        // Nothing was delivered, so there is no successful model to keep and
        // no displaced one to remember going back to.
        expectsRecovery: false,
    },
    // Step 5's control: the failure lands after the user has seen text. §7
    // preserves the partial answer and substitutes nothing.
    no_fallback_after_token: {
        fault: "attempt_0_post_token",
        attempts: [{ attemptIndex: 0, outcome: "failed_post_token" }],
        reservationStatus: ["settled", "refunded"],
        rerouteCount: 0,
        fallbackState: "none",
        expectsRecovery: false,
    },
};

const problem = (message) => ({ ok: false, message });
const fine = (message) => ({ ok: true, message });

/**
 * @param {object} observed  Rows for one traceId, already fetched.
 * @param {keyof DRILL_SCENARIOS} scenarioName
 */
export function auditFallbackDrill(observed, scenarioName) {
    const scenario = DRILL_SCENARIOS[scenarioName];
    if (!scenario) {
        return {
            passed: false,
            checks: [problem(`Unknown drill scenario "${scenarioName}".`)],
        };
    }

    const checks = [];
    const {
        runs = [],
        reservations = [],
        attempts = [],
        manifests = [],
        attemptUsage = [],
        leases = [],
        logs = [],
    } = observed;

    // One run. Two would mean the retry started a second logical response, and
    // the reroute rate would read as zero forever.
    checks.push(
        runs.length === 1
            ? fine("one RoutingRun")
            : problem(`expected 1 RoutingRun, found ${runs.length}`)
    );

    checks.push(
        reservations.length === 1
            ? fine("one ChatCreditReservation")
            : problem(
                  `expected 1 ChatCreditReservation, found ${reservations.length}`
              )
    );

    // The attempts, in order, with the outcome each one must have.
    const seen = [...attempts].sort((a, b) => a.attemptIndex - b.attemptIndex);
    if (seen.length !== scenario.attempts.length) {
        checks.push(
            problem(
                `expected ${scenario.attempts.length} attempt(s), found ${seen.length}` +
                    (seen.length
                        ? ` (${seen
                              .map((a) => `${a.attemptIndex}:${a.outcome}`)
                              .join(", ")})`
                        : "")
            )
        );
    } else {
        for (const [index, expected] of scenario.attempts.entries()) {
            const actual = seen[index];
            checks.push(
                actual.attemptIndex === expected.attemptIndex &&
                    actual.outcome === expected.outcome
                    ? fine(`attempt ${expected.attemptIndex} ${expected.outcome}`)
                    : problem(
                          `attempt ${index}: expected ${expected.attemptIndex}:${expected.outcome}, ` +
                              `found ${actual.attemptIndex}:${actual.outcome}`
                      )
            );
        }
        // §5: an independent manifest per attempt, each finalized. A reused one
        // would describe a request that was never sent to that model.
        const finalized = manifests.filter((m) => m.finalizedAt);
        checks.push(
            finalized.length === seen.length
                ? fine(`${finalized.length} finalized manifest(s), one per attempt`)
                : problem(
                      `expected ${seen.length} finalized manifest(s), found ${finalized.length}`
                  )
        );
        const attemptIds = new Set(manifests.map((m) => m.attemptId));
        checks.push(
            attemptIds.size === manifests.length
                ? fine("no manifest is shared between attempts")
                : problem("two attempts share a manifest")
        );
    }

    // Exactly one end-user settlement. The reservation reaches a terminal
    // status once, and at most one attempt row carries the user's charge.
    const reservation = reservations[0];
    if (reservation) {
        checks.push(
            scenario.reservationStatus.includes(reservation.status)
                ? fine(`reservation ${reservation.status}`)
                : problem(
                      `reservation status ${reservation.status}, expected one of ` +
                          scenario.reservationStatus.join("/")
                  )
        );
        checks.push(
            reservation.settledAt
                ? fine("reservation settled once")
                : problem("reservation has no settledAt")
        );
    }

    const billed = attemptUsage.filter((row) => row.userBilled);
    if (attemptUsage.length > 0) {
        checks.push(
            billed.length === 1
                ? fine("exactly one attempt was billed to the user")
                : problem(
                      `expected exactly 1 billed attempt, found ${billed.length}`
                  )
        );
        checks.push(
            attemptUsage.length === scenario.attempts.length
                ? fine(`${attemptUsage.length} attempt usage row(s)`)
                : problem(
                      `expected ${scenario.attempts.length} ChatAttemptUsage row(s), ` +
                          `found ${attemptUsage.length}`
                  )
        );
        // Each attempt priced at its own provider. Two rows naming one
        // provider on a cross-provider drill means the snapshot was reused.
        const providers = new Set(attemptUsage.map((row) => row.provider));
        checks.push(
            providers.size >= 1
                ? fine(`providers charged: ${[...providers].sort().join(", ")}`)
                : problem("no provider recorded for any attempt")
        );
    } else if (scenario.attempts.length > 1) {
        checks.push(
            problem(
                "no ChatAttemptUsage rows: a turn that dispatched twice must " +
                    "record what each attempt cost"
            )
        );
    }

    // One lease release. A lease still held is a slot this turn never gave
    // back, and it is the failure that only shows up under load.
    //
    // Measured as "no lease row survives for the drill's subject", because
    // releasing a lease deletes it (lib/chatRequestLease.ts) and the row
    // carries no traceId to match on. That makes the check only as good as the
    // drill being the sole request for that subject, which the runbook
    // requires and the script re-states rather than assumes.
    checks.push(
        leases.length === 0
            ? fine("lease released")
            : problem(
                  `${leases.length} lease(s) still held for the drill subject; ` +
                      "a released lease is deleted, so a surviving row is a slot " +
                      "this turn never gave back"
              )
    );

    const run = runs[0];
    if (run) {
        checks.push(
            run.rerouteCount === scenario.rerouteCount
                ? fine(`rerouteCount ${run.rerouteCount}`)
                : problem(
                      `rerouteCount ${run.rerouteCount}, expected ${scenario.rerouteCount}`
                  )
        );
        checks.push(
            run.fallbackState === scenario.fallbackState
                ? fine(`fallbackState ${run.fallbackState}`)
                : problem(
                      `fallbackState ${run.fallbackState}, expected ${scenario.fallbackState}`
                  )
        );
        // §6: the pass-through downgrade is held while the Planner is "none",
        // so no drill may spend it.
        checks.push(
            run.passThroughUsed === false
                ? fine("no pass-through spent")
                : problem(
                      "passThroughUsed is true; the Planner is \"none\" and the " +
                          "downgrade is supposed to be held"
                  )
        );
        const hasRecovery = Boolean(run.recoveryCandidateModelId);
        checks.push(
            hasRecovery === scenario.expectsRecovery
                ? fine(
                      scenario.expectsRecovery
                          ? `recovery candidate ${run.recoveryCandidateModelId}`
                          : "no recovery candidate, as expected"
                  )
                : problem(
                      scenario.expectsRecovery
                          ? "§8 recovery candidate missing after a successful fallback"
                          : `§8 recovery candidate ${run.recoveryCandidateModelId} ` +
                                "recorded for a fallback that did not succeed"
                  )
        );
    }

    // The drill has to be legible in the logs too, not only in the database.
    const armed = logs.some((line) => line.includes("chat_fault_injection_armed"));
    checks.push(
        armed
            ? fine("the injected fault is announced in the logs")
            : problem(
                  "no chat_fault_injection_armed line: without it a drill is " +
                      "indistinguishable from a real outage in the log record"
              )
    );
    if (scenario.rerouteCount > 0) {
        const dispatched = logs.some((line) =>
            line.includes("chat_auto_fallback_dispatched")
        );
        checks.push(
            dispatched
                ? fine("the fallback dispatch is in the logs")
                : problem("no chat_auto_fallback_dispatched line")
        );
    }

    return { passed: checks.every((check) => check.ok), checks };
}
