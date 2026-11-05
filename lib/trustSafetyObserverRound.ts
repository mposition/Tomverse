/**
 * One observation round, in the order §14 fixes
 * (docs/policy/trust-safety-compliance-agent.md §5.5, §6, §8).
 *
 * Three transactions and a ping, each in its own bounded transaction, with the
 * route's budget `B` spent across them:
 *
 *   T0  activation read  -- the config row and the audit entries §6 judges
 *   Ta  DSR count read   -- the seven-field allowlist, nothing else
 *   Tr  run row write    -- one INSERT, refused by its trigger if it is late
 *   ping                 -- only after that COMMIT, and only when §6 allows it
 *
 * **Why the order matters.** Activation is derived before anything is counted,
 * so an observer that is off reads no personal data at all; and the run row is
 * written after the count, so a row means an actual observation happened
 * rather than an intention to make one.
 *
 * **No batch starts without its budget.** §5.5: if less than a kind's guarded
 * budget remains, the round stops instead of starting. A round that stops
 * before Tr leaves no row and sends no ping, which is the same thing the
 * monitor sees when the service never ran -- and §8 says those two are not
 * distinguished on purpose.
 *
 * This module writes nothing itself. The run row goes through
 * `lib/trustSafetyObserverRun.ts` and the ping through
 * `lib/trustSafetyObserverPing.ts`, which are the two modules §5.6 names.
 */

import "server-only";

import { readTrustSafetyActivation } from "@/lib/trustSafetyActivationRead";
import type { ActivationState } from "@/lib/trustSafetyActivationCore";
import { trustSafetyIntegrityKeyEnv } from "@/lib/trustSafetyAuditEntryVerify";
import { ROUTE_BUDGET_MS, type TrustSafetyTransactionKind } from "@/lib/trustSafetyBoundsCore";
import { observeDsrDeadlines } from "@/lib/trustSafetyDsrObservation";
import { insertTrustSafetyObserverRun } from "@/lib/trustSafetyObserverRun";
import {
  type TrustSafetyPingOutcome,
  sendTrustSafetyPing,
} from "@/lib/trustSafetyObserverPing";
import { activationVerdict, budgetAllowsBatch } from "@/lib/trustSafetyRoundCore";
import { withTrustSafetyTransaction } from "@/lib/trustSafetyTransaction";

/**
 * The imminence window, in days.
 *
 * §12 (1) approves no threshold for it, so there is no number to hold here.
 * Zero is not a proposal standing in for one: it means no window has been
 * chosen, so the `imminent` bucket stays empty while `observed`, `overdue` and
 * `closedLate` -- which need no threshold -- are counted as usual. The counts
 * echo the window they used, so a reader can see that it was not set.
 */
const IMMINENT_WITHIN_DAYS_UNSET = 0;

/**
 * What the round did. A closed set, and the route narrows it further to §4's
 * three-value enum: nothing here reaches the response except the outcome.
 */
export type TrustSafetyRoundResult = {
  readonly outcome: "ran" | "disabled" | "failed";
  /** The derived activation, for the log line only; never in a response. */
  readonly activation: ActivationState;
  readonly ping: TrustSafetyPingOutcome | "withheld" | "not_reached";
};

/** Runs one round. */
export const runTrustSafetyObservation = async ({
  nowMonotonicMs = () => performance.now(),
}: {
  readonly nowMonotonicMs?: () => number;
} = {}): Promise<TrustSafetyRoundResult> => {
  const env = trustSafetyIntegrityKeyEnv();
  const startedAt = nowMonotonicMs();
  // The round's deadline is the caller's claim, on the application's wall
  // clock, while the arming function measures the remaining budget against it
  // on the database's. The mixed clocks can only refuse a round that had time
  // left, or grant one a little more of the route budget than it should have
  // had -- never record a late round as a success, because the deadline the
  // trigger judges is computed by the database and stored on the row.
  const roundDeadline = new Date(Date.now() + ROUTE_BUDGET_MS);

  /** §5.5: a batch that cannot fit in what is left does not start. */
  const budgetFor = (kind: TrustSafetyTransactionKind): boolean =>
    budgetAllowsBatch({
      kind,
      elapsedMs: nowMonotonicMs() - startedAt,
      budgetMs: ROUTE_BUDGET_MS,
    });

  if (!budgetFor("activation_read")) {
    return { outcome: "failed", activation: NO_ACTIVATION, ping: "not_reached" };
  }

  // T0: the activation read. Every §6 input comes from this one transaction,
  // and that transaction runs at REPEATABLE READ (see the wrapper), so the
  // checks judge one snapshot -- not a config row read before an audit entry
  // that was written in between, which would read as `binding_mismatch`.
  const { activation } = await withTrustSafetyTransaction({
    kind: "activation_read",
    runDeadline: roundDeadline,
    fn: (tx) =>
      readTrustSafetyActivation({
        tx,
        env,
        pingUrlPresent: isPresent(process.env.TRUST_SAFETY_OBSERVER_PING_URL),
      }),
  });

  // A fault that stops counting is not "off": §6 keeps the two apart, and the
  // round neither ran nor was deliberately disabled.
  const verdict = activationVerdict(activation);
  if (verdict !== "observe") {
    return { outcome: verdict, activation, ping: "not_reached" };
  }

  if (!budgetFor("dsr_read")) {
    return { outcome: "failed", activation, ping: "not_reached" };
  }

  // Ta: the counts. `observedAt` is the database clock the arming statement
  // reported for this transaction -- the instant the rows were read, not an
  // application timestamp and not a statement of its own.
  const observedAt = await withTrustSafetyTransaction({
    kind: "dsr_read",
    runDeadline: roundDeadline,
    fn: async (tx, armed) => {
      await tx.statement((client) =>
        observeDsrDeadlines({
          prisma: client,
          now: armed.txStart,
          imminentWithinDays: IMMINENT_WITHIN_DAYS_UNSET,
        }),
      );
      // The counts are not returned. This stage is the stage-1 observation and
      // nothing yet displays it (§14); carrying the numbers out of here would
      // put personal-data-derived figures in a caller that has no use for them.
      return armed.txStart;
    },
  });

  if (!budgetFor("run_write")) {
    return { outcome: "failed", activation, ping: "not_reached" };
  }

  // Tr: the record. A late COMMIT is refused by the row's deferred trigger, so
  // reaching the next line means the round was inside its deadline and inside
  // the round window.
  await withTrustSafetyTransaction({
    kind: "run_write",
    runDeadline: roundDeadline,
    fn: (tx) => insertTrustSafetyObserverRun({ tx, observedAt }),
  });
  const committedAtMonotonicMs = nowMonotonicMs();

  // §6's sixth fault withholds the ping and nothing else: the round ran and is
  // recorded, and the monitor will notice the silence after `W`.
  const pingUrl = process.env.TRUST_SAFETY_OBSERVER_PING_URL;
  if (!activation.pingPermitted || !isPresent(pingUrl)) {
    return { outcome: "ran", activation, ping: "withheld" };
  }

  const ping = await sendTrustSafetyPing({
    url: pingUrl,
    committedAtMonotonicMs,
    now: nowMonotonicMs,
  });
  return { outcome: "ran", activation, ping };
};

const isPresent = (value: string | undefined): value is string =>
  typeof value === "string" && value.length > 0;

/** The activation nothing was read for, when the round stops before T0. */
const NO_ACTIVATION: ActivationState = {
  mode: null,
  fault: null,
  countPermitted: false,
  pingPermitted: false,
};
