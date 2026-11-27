/**
 * Scheduled tasks: a question the server asks on the account's behalf at a
 * time the account chose, answered into one dedicated Chat conversation.
 *
 * Pure on purpose -- no Prisma, no Node built-ins -- so the settings screen,
 * the API routes, the runner and the tests all read the same limits, the same
 * schedule arithmetic and the same outcome classification. The database CHECKs
 * in `20261128090000_scheduled_tasks` repeat the closed lists below and
 * `npm run check:enum-constraints` compares the two.
 *
 * The unattended-spend boundary is deterministic code, not configuration:
 *
 *   - schedules are at most daily (there is no hourly frequency), and the
 *     runner additionally refuses a run within MIN_RUN_INTERVAL_MS of the
 *     previous one, which is what an edited time or a DST shift could
 *     otherwise produce;
 *   - an account holds at most MAX_ACTIVE_TASKS active tasks;
 *   - one run is one ordinary Chat turn, and its credit reservation may not
 *     exceed the per-run credits the account approved when it saved the task
 *     (enforced inside the reservation transaction, lib/scheduledTaskReservationGuard.ts);
 *   - an account has at most one scheduled run in flight (a partial unique
 *     index), so scheduled work never takes more than one of the account's
 *     Chat concurrency slots;
 *   - a run whose result cannot be confirmed is recorded as unknown and never
 *     dispatched again; MAX_CONSECUTIVE_FAILURES failures pause the task.
 */

// Pure as well (reads only the env record it is handed).
import { resolveChatConcurrencyPlan } from "./chatConcurrencyCore";

export const SCHEDULED_TASK_FREQUENCIES = ["once", "daily", "weekly", "monthly"] as const;
export type ScheduledTaskFrequency = (typeof SCHEDULED_TASK_FREQUENCIES)[number];

export const SCHEDULED_TASK_STATUSES = ["active", "paused", "completed"] as const;
export type ScheduledTaskStatus = (typeof SCHEDULED_TASK_STATUSES)[number];

/**
 * Why a task stopped running by itself. `user` is the only reason a person
 * chose; every other one is the runner refusing to spend on the account's
 * behalf and saying why, so the settings screen can tell them what to fix.
 */
export const SCHEDULED_TASK_PAUSE_REASONS = [
  "user",
  "insufficient_credits",
  "cost_changed",
  "plan_required",
  "model_unavailable",
  "conversation_locked",
  "account_unavailable",
  "storage_full",
  "repeated_failures",
] as const;
export type ScheduledTaskPauseReason = (typeof SCHEDULED_TASK_PAUSE_REASONS)[number];

export const SCHEDULED_TASK_RUN_STATUSES = ["running", "succeeded", "failed", "skipped", "unknown"] as const;
export type ScheduledTaskRunStatus = (typeof SCHEDULED_TASK_RUN_STATUSES)[number];

/** Limits. Changing one is a product decision recorded in the commit that changes it. */
export const SCHEDULED_TASK_LIMITS = Object.freeze({
  /** Active tasks per account. Paused and completed ones do not count. */
  maxActiveTasks: 5,
  /** Stored tasks per account, whatever their state: a bound on storage, not on spend. */
  maxTasks: 20,
  titleCharacters: 80,
  promptCharacters: 2_000,
  /** A failed or unknown run counts; a skipped one (nothing was spent) does not. */
  maxConsecutiveFailures: 3,
  /** Never two runs of one task closer than this, whatever the schedule says. */
  minRunIntervalMs: 20 * 60 * 60 * 1_000,
  /**
   * How late a run may still start. Past this the occurrence is skipped and
   * the next one scheduled: a news summary for 08:00 delivered at 17:00 after
   * an outage is not what anybody asked for, and a backlog must never fire
   * every missed day at once.
   */
  lateGraceMs: 3 * 60 * 60 * 1_000,
  /** A claimed run that has not finished by then is reconciled, never re-sent. */
  runLeaseMs: 15 * 60 * 1_000,
  /**
   * Runs claimed per maintenance tick (every 15 minutes), at most; also the
   * page size the tick reads due tasks in.
   */
  claimBatch: 20,
  /**
   * Due tasks one tick looks at, at most, oldest first. A task the tick cannot
   * start now keeps its due time and is passed over, so it never holds the
   * window shut for the tasks behind it; this bounds how far one tick reads.
   * What reaching it guarantees is written at runScheduledTasksTick.
   */
  dueScanLimit: 200,
  /** Runs executed at once within one tick. */
  executionConcurrency: 2,
  /** A tick's time budget when its caller names no deadline. */
  tickBudgetMs: 240 * 1_000,
  /**
   * Time a run needs left before the tick's deadline to be started at all. A
   * started turn that outlives the deadline is not cut off: it finishes and
   * settles after the tick returns, or the next tick settles it from its
   * Chat attempt.
   */
  runStartReserveMs: 120 * 1_000,
  /** Kept free at the end of the calling request's own time limit. */
  routeDeadlineMarginMs: 30 * 1_000,
});

/** Only paid plans run unattended work (owner direction for scheduled tasks: Pro and above). */
export const SCHEDULED_TASK_PLANS = ["Pro", "Max"] as const;
export const planRunsScheduledTasks = (plan: string | null | undefined) =>
  (SCHEDULED_TASK_PLANS as readonly string[]).includes(plan ?? "");

/**
 * Whether the settings list shows the scheduled-tasks row. Open to this
 * account, or holding tasks it saved earlier (so they can still be seen and
 * deleted). With the switch off and nothing saved the list is unchanged.
 */
export const scheduledTasksEntryVisible = (
  summary: { enabled: boolean; planAllowed: boolean; tasks: readonly unknown[] } | null
) => Boolean(summary && ((summary.enabled && summary.planAllowed) || summary.tasks.length > 0));

export type ScheduledTaskSchedule = {
  frequency: ScheduledTaskFrequency;
  /** "HH:MM", 24-hour, in `timeZone`. */
  timeOfDay: string;
  /** 0 (Sunday) to 6, weekly only. */
  dayOfWeek: number | null;
  /** 1 to 31, monthly only. A shorter month runs on its last day. */
  dayOfMonth: number | null;
  /** "YYYY-MM-DD", once only. */
  runOnDate: string | null;
  /** IANA zone the times above are read in. */
  timeZone: string;
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export type ScheduleProblem =
  | "time_invalid"
  | "day_of_week_invalid"
  | "day_of_month_invalid"
  | "date_invalid"
  | "time_zone_invalid"
  | "fields_mismatch";

const isValidTimeZone = (value: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const parseDate = (value: string) => {
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
};

/** The one place a schedule's fields are judged, for the API and for the database CHECK's shape rule alike. */
export const scheduleProblem = (schedule: ScheduledTaskSchedule): ScheduleProblem | null => {
  if (!TIME_PATTERN.test(schedule.timeOfDay)) return "time_invalid";
  if (!isValidTimeZone(schedule.timeZone)) return "time_zone_invalid";
  const { frequency } = schedule;
  if ((frequency === "weekly") !== (schedule.dayOfWeek !== null)) return "fields_mismatch";
  if ((frequency === "monthly") !== (schedule.dayOfMonth !== null)) return "fields_mismatch";
  if ((frequency === "once") !== (schedule.runOnDate !== null)) return "fields_mismatch";
  if (schedule.dayOfWeek !== null && (!Number.isInteger(schedule.dayOfWeek) || schedule.dayOfWeek < 0 || schedule.dayOfWeek > 6)) {
    return "day_of_week_invalid";
  }
  if (schedule.dayOfMonth !== null && (!Number.isInteger(schedule.dayOfMonth) || schedule.dayOfMonth < 1 || schedule.dayOfMonth > 31)) {
    return "day_of_month_invalid";
  }
  if (schedule.runOnDate !== null && !parseDate(schedule.runOnDate)) return "date_invalid";
  return null;
};

/* ------------------------------------------------------------ zoned time -- */

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (timeZone: string) => {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    if (formatters.size > 200) formatters.clear();
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

const localPartsAt = (instant: number, timeZone: string): LocalParts & { second: number } => {
  const values = new Map(
    formatterFor(timeZone)
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
  return {
    year: values.get("year") ?? 0,
    month: values.get("month") ?? 0,
    day: values.get("day") ?? 0,
    hour: (values.get("hour") ?? 0) % 24,
    minute: values.get("minute") ?? 0,
    second: values.get("second") ?? 0,
  };
};

/** Milliseconds the zone is ahead of UTC at that instant. */
const zoneOffsetAt = (instant: number, timeZone: string) => {
  const local = localPartsAt(instant, timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return asUtc - Math.floor(instant / 1_000) * 1_000;
};

/**
 * The instant a local wall-clock time names in a zone.
 *
 * Two passes, because the offset at the guess and at the answer differ across
 * a DST change. A wall time that does not exist (the hour a spring-forward
 * skips) resolves to the instant one offset later, which is a real time on
 * that day rather than an error -- a daily 02:30 task still runs that day.
 */
export const zonedWallTimeToInstant = (parts: LocalParts, timeZone: string): Date => {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const first = guess - zoneOffsetAt(guess, timeZone);
  const second = guess - zoneOffsetAt(first, timeZone);
  return new Date(second);
};

const addLocalDays = (date: { year: number; month: number; day: number }, days: number) => {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
};

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * The first occurrence strictly after `after`, or null when there is none (a
 * one-off whose time has passed). The arithmetic is in the task's own zone, so
 * "08:00 every day" stays 08:00 across a DST change.
 */
export const nextOccurrence = (schedule: ScheduledTaskSchedule, after: Date): Date | null => {
  if (scheduleProblem(schedule)) return null;
  const [hour, minute] = schedule.timeOfDay.split(":").map(Number) as [number, number];
  const at = (date: { year: number; month: number; day: number }) =>
    zonedWallTimeToInstant({ ...date, hour, minute }, schedule.timeZone);
  const afterMs = after.getTime();

  if (schedule.frequency === "once") {
    const date = parseDate(schedule.runOnDate!)!;
    const instant = at(date);
    return instant.getTime() > afterMs ? instant : null;
  }

  const today = localPartsAt(afterMs, schedule.timeZone);
  if (schedule.frequency === "daily") {
    for (let offset = 0; offset <= 2; offset += 1) {
      const instant = at(addLocalDays(today, offset));
      if (instant.getTime() > afterMs) return instant;
    }
    return null;
  }
  if (schedule.frequency === "weekly") {
    for (let offset = 0; offset <= 8; offset += 1) {
      const date = addLocalDays(today, offset);
      if (new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() !== schedule.dayOfWeek) continue;
      const instant = at(date);
      if (instant.getTime() > afterMs) return instant;
    }
    return null;
  }
  for (let offset = 0; offset <= 13; offset += 1) {
    const monthIndex = today.month - 1 + offset;
    const year = today.year + Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    const day = Math.min(schedule.dayOfMonth!, daysInMonth(year, month));
    const instant = at({ year, month, day });
    if (instant.getTime() > afterMs) return instant;
  }
  return null;
};

/** What the runner does with a due task, decided without touching anything. */
export type DueDecision =
  | { kind: "run"; scheduledFor: Date }
  | { kind: "skip_late"; next: Date | null }
  | { kind: "skip_too_soon"; next: Date | null };

export const decideDueOccurrence = (input: {
  schedule: ScheduledTaskSchedule;
  dueAt: Date;
  now: Date;
  /** The latest earlier run's occurrence, if any. */
  previousScheduledFor: Date | null;
  /**
   * When the task's latest run actually started, if any -- for a run resumed
   * after a lapsed lease, when it was resumed. The minimum interval is a
   * promise about paid runs, so it holds between real start times too: a late
   * run followed by a schedule moved earlier is still kept apart.
   */
  previousStartedAt?: Date | null;
}): DueDecision => {
  const { schedule, dueAt, now, previousScheduledFor, previousStartedAt } = input;
  const next = nextOccurrence(schedule, now);
  if (now.getTime() - dueAt.getTime() > SCHEDULED_TASK_LIMITS.lateGraceMs) return { kind: "skip_late", next };
  if (
    previousScheduledFor &&
    dueAt.getTime() - previousScheduledFor.getTime() < SCHEDULED_TASK_LIMITS.minRunIntervalMs
  ) {
    return { kind: "skip_too_soon", next };
  }
  if (previousStartedAt && now.getTime() - previousStartedAt.getTime() < SCHEDULED_TASK_LIMITS.minRunIntervalMs) {
    return { kind: "skip_too_soon", next };
  }
  return { kind: "run", scheduledFor: dueAt };
};

/* ------------------------------------------------------- outcome mapping -- */

/** Entitlement refusals (docs/policy/credit-and-cost-limits.md §2): nothing ran, the account is out of credits. */
const ENTITLEMENT_CODES = new Set([
  "PLAN_ENTITLEMENT_EXHAUSTED",
  "CREDIT_BALANCE_INSUFFICIENT",
  "CREDIT_COST_ALLOWANCE_INSUFFICIENT",
  "PLAN_DAILY_CREDIT_LIMIT_REACHED",
]);
/** Codes the Chat route answers with when the chosen model cannot run for this account (MODEL_TEMPORARILY_UNAVAILABLE is a passing failure, not this). */
const MODEL_CODES = new Set([
  "MODEL_NOT_AVAILABLE",
  "MODEL_NOT_SELECTED",
  "MODEL_RETIRED",
  "MODEL_ACCESS_FORBIDDEN",
  "PLAN_MODEL_LIMIT_EXCEEDED",
]);
/**
 * Refusals that are the platform's state, not the task's: an operational
 * guardrail, a provider budget, Chat paused by an operator. Nothing was spent
 * and nothing about the task is wrong, so they neither pause it nor count
 * toward its failure streak.
 */
const PLATFORM_CODES = new Set([
  "OPERATIONAL_COST_GUARDRAIL_TRIGGERED",
  "PROVIDER_BUDGET_EXHAUSTED",
  "AI_CHAT_DISABLED_BY_ADMIN",
  "CHAT_CONCURRENCY_EXCEEDED",
  "API_RATE_LIMITED",
]);
export const SCHEDULED_TASK_CREDIT_CAP_CODE = "SCHEDULED_TASK_CREDIT_CAP_EXCEEDED";
/** The reservation guard's answer once the person paused, edited or deleted the task mid-run. */
export const SCHEDULED_TASK_RUN_CLOSED_CODE = "SCHEDULED_TASK_RUN_CLOSED";

export type RunClassification = {
  status: Exclude<ScheduledTaskRunStatus, "running">;
  /** Short machine code shown as a reason; never provider text. */
  outcome: string;
  /** Set when the task must stop until the person acts. */
  pause: ScheduledTaskPauseReason | null;
};

const SAFE_CODE = /^[A-Za-z0-9_]{1,64}$/;
const safeCode = (value: unknown, fallback: string) =>
  typeof value === "string" && SAFE_CODE.test(value) ? value : fallback;

/** A Chat refusal (non-2xx answer) to what the run records and whether the task stops. */
export const classifyChatRefusal = (status: number, code: unknown): RunClassification => {
  const outcome = safeCode(code, `http_${status}`);
  if (ENTITLEMENT_CODES.has(outcome)) return { status: "skipped", outcome, pause: "insufficient_credits" };
  if (outcome === SCHEDULED_TASK_CREDIT_CAP_CODE) return { status: "skipped", outcome, pause: "cost_changed" };
  // The person took the task back; nothing was spent and nothing failed.
  if (outcome === SCHEDULED_TASK_RUN_CLOSED_CODE) return { status: "skipped", outcome: "task_changed", pause: null };
  if (MODEL_CODES.has(outcome)) return { status: "skipped", outcome, pause: "model_unavailable" };
  if (status === 423) return { status: "skipped", outcome, pause: "conversation_locked" };
  if (PLATFORM_CODES.has(outcome)) return { status: "skipped", outcome, pause: null };
  return { status: "failed", outcome, pause: null };
};

/** A drained Chat stream, judged by the durable attempt row it left (docs/policy/chat-durable-draft-and-attempt-recovery.md §3). */
export const classifyAttempt = (
  attempt: { status: string; failureCode: string | null; leaseExpiresAt: Date } | null,
  now: Date
): RunClassification | null => {
  if (!attempt) return { status: "failed", outcome: "no_answer", pause: null };
  if (attempt.status === "completed") return { status: "succeeded", outcome: "completed", pause: null };
  if (attempt.status === "failed") return { status: "failed", outcome: safeCode(attempt.failureCode, "chat_failed"), pause: null };
  if (attempt.status === "cancelled") return { status: "failed", outcome: "cancelled", pause: null };
  // Still claimed or streaming. While its lease lives somebody owns it and the
  // answer may yet arrive; once it has lapsed the outcome cannot be known, and
  // an unknown outcome is never sent again.
  if (attempt.leaseExpiresAt.getTime() > now.getTime()) return null;
  return { status: "unknown", outcome: "outcome_unknown", pause: null };
};

/** Consecutive failures after a run, and whether that run pauses the task. */
export const failureStreakAfter = (
  previous: number,
  classification: RunClassification
): { consecutiveFailures: number; pause: ScheduledTaskPauseReason | null } => {
  if (classification.status === "succeeded") return { consecutiveFailures: 0, pause: null };
  if (classification.status === "skipped") return { consecutiveFailures: previous, pause: classification.pause };
  const consecutiveFailures = previous + 1;
  return {
    consecutiveFailures,
    pause: classification.pause ??
      (consecutiveFailures >= SCHEDULED_TASK_LIMITS.maxConsecutiveFailures ? "repeated_failures" : null),
  };
};

/**
 * Where an unattended run may execute. The tick runs in `after()` of the
 * maintenance request and a started turn may outlive that request: on a
 * long-lived `next start` server (production runs on Railway) `after()` is
 * fully supported and the server finishes pending `after()` callbacks before
 * it exits on SIGTERM (node_modules/next/dist/docs/01-app/02-guides/self-hosting.md,
 * "after"). On a serverless platform the work is bound to the invocation's
 * time limit, so a paid run could be cut off mid-answer: nothing is started
 * there. A run cut by a process exit anyway is settled from its Chat attempt
 * row by the next tick, the same as a Chat turn cut by a deploy.
 */
const SERVERLESS_HOST_MARKERS = Object.freeze([
  "VERCEL",
  "AWS_LAMBDA_FUNCTION_NAME",
  "NETLIFY",
  "FUNCTIONS_WORKER_RUNTIME",
]);

/**
 * A scheduled run always leaves one of the account's Chat slots free for the
 * person (lib/scheduledTaskReservationGuard.ts). A deployment that allows a
 * single Chat request per account (`CHAT_USER_CONCURRENT=1`) has no second
 * slot, so the Chat route refuses every scheduled run there. The tick starts
 * nothing on such a deployment instead of claiming runs that can only be
 * refused.
 */
export const SCHEDULED_TASK_MIN_USER_CONCURRENCY = 2;

export const scheduledTasksHostProblem = (
  env: Record<string, string | undefined>
): "serverless_host" | "chat_concurrency_too_low" | null => {
  if (SERVERLESS_HOST_MARKERS.some((name) => Boolean(env[name]?.trim()))) return "serverless_host";
  const userLimit = resolveChatConcurrencyPlan({ kind: "user", subjectKey: "user:probe", ipKey: "ip:probe" }, env).subject.limit;
  return userLimit < SCHEDULED_TASK_MIN_USER_CONCURRENCY ? "chat_concurrency_too_low" : null;
};
