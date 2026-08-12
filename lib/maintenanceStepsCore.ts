// Running the retention job's steps so that one failure does not starve the
// rest.
//
// `cleanupExpiredData()` is roughly twenty independent pieces of work: expiring
// credit lots, deleting expired sessions, dispatching a stalled memory
// extraction run, deleting the accounts whose 30-day grace period has passed.
// They were awaited in one sequence, so the first to throw ended the run and
// every later step was skipped.
//
// The failure that matters is not a bad day, it is a bad *row*: a step that
// throws for a reason that is still there tomorrow fails at the same point on
// every run, and the steps behind it never execute again. Nothing says so --
// the job simply reports "failed", which it would also report if only the last
// step had failed. The sweep whose comment already states the principle ("a
// storage outage must not take the rest of the maintenance run down with it")
// is the only one that was actually protected by it.
//
// So each step runs in isolation and reports under its own name. The run as a
// whole is still a failure when any step failed -- the alert must not go quiet
// -- but it is a failure that names which steps, and the other nineteen have
// run.
//
// Deliberately free of Prisma and of `server-only`: the ordering and the
// isolation are what want testing, and they are testable without a database.

export type MaintenanceStepFailure = {
  /** The step's stable key, as reported in the run result. */
  step: string;
  /** Error type and message, capped. Never a stack, never row contents. */
  error: string;
};

const MAX_STEP_ERROR_LENGTH = 500;

/**
 * What is safe to record about a step that threw.
 *
 * A retention step touches user rows, so the message is the only part of the
 * error worth keeping and even that is capped: an ORM error can quote the
 * offending row back at you, and the run result is read by an operator dashboard
 * and written to an audit log.
 */
export const describeMaintenanceStepError = (error: unknown) => {
  const described =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return described.slice(0, MAX_STEP_ERROR_LENGTH);
};

export type MaintenanceStepRunner = {
  /**
   * Runs one step. Returns its value, or `null` if it threw -- `null` being the
   * honest answer to "how many rows did this step delete", as distinct from the
   * `0` a step that ran and found nothing reports.
   */
  step: <T>(name: string, run: () => Promise<T>) => Promise<T | null>;
  /** The steps that threw, in the order they ran. */
  failures: MaintenanceStepFailure[];
};

export const createMaintenanceStepRunner = (): MaintenanceStepRunner => {
  const failures: MaintenanceStepFailure[] = [];
  const seen = new Set<string>();

  const step = async <T>(name: string, run: () => Promise<T>): Promise<T | null> => {
    // A duplicated key would report two different steps under one name, which
    // is worse than an unnamed failure: the operator fixes the wrong one.
    if (seen.has(name)) {
      throw new Error(`Duplicate maintenance step name: ${name}`);
    }
    seen.add(name);

    try {
      return await run();
    } catch (error) {
      failures.push({ step: name, error: describeMaintenanceStepError(error) });
      console.error(`Maintenance step failed (${name}):`, error);
      return null;
    }
  };

  return { step, failures };
};

/** One line naming what failed, for the job's error field. */
export const summarizeMaintenanceStepFailures = (
  failures: readonly MaintenanceStepFailure[]
) =>
  `${failures.length} maintenance step(s) failed: ${failures
    .map((failure) => `${failure.step} (${failure.error})`)
    .join("; ")}`;
