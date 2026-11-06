// The service's two time limits (docs/policy/trust-safety-compliance-agent.md
// §4, §12 (1) table C).
//
// §4 puts the only hard timeout on this side: the supervisor SIGKILLs the
// child at its deadline and then fails itself. The app route claims no hard
// timeout -- a Next handler cannot end itself and cannot take back a COMMIT it
// has sent -- so these two numbers are the ones that actually stop a run.
//
// They are duplicated from `lib/trustSafetyBoundsCore.ts` on purpose: the
// service image holds no TypeScript and no application code, so it cannot
// import the table. `tests/trustSafetyServiceIac.test.mjs` holds the two
// equal, which is the device this repository uses wherever a figure has to
// exist in two runtimes.

/** The request timeout the child gives the route: `B` + 10 seconds. */
export const CHILD_TIMEOUT_MS = 69_000;

/** When the supervisor kills the child: the child's timeout + 30 seconds. */
export const SUPERVISOR_DEADLINE_MS = 99_000;

/** The declared period `P`, as the cron expression Railway is given. */
export const DECLARED_PERIOD_CRON = "*/30 * * * *";
