/**
 * Pure calendar and aggregation helpers for the Admin Console usage report.
 *
 * Framework-free so plain Node tests import it. The server reader
 * (`lib/adminUsageAnalytics.ts`) asks the database for grouped counts and hands
 * them here to be shaped; nothing in this file reads a clock it was not given.
 *
 * Every period is a calendar question asked in the operator's time zone, not in
 * UTC. "Today" for an operator in Brisbane starts at 00:00 Brisbane, which is
 * 14:00 UTC the previous day -- a UTC day would split one working day across
 * two rows and put the evening peak into tomorrow.
 */

export const OPERATOR_TIME_ZONE = "Australia/Brisbane";

export const USAGE_PERIOD_IDS = [
  "today",
  "yesterday",
  "last7",
  "last30",
  "thisMonth",
  "lastMonth",
] as const;

export type UsagePeriodId = (typeof USAGE_PERIOD_IDS)[number];

export const DEFAULT_USAGE_PERIOD: UsagePeriodId = "today";

/** How many rows a share table shows before folding the rest into "other". */
export const USAGE_SHARE_LIMIT = 8;

/** The key a share row carries when the source value was missing. */
export const UNKNOWN_SEGMENT = "unknown";
export const OTHER_SEGMENT = "other";

export const parseUsagePeriod = (value: unknown): UsagePeriodId => {
  const candidate = Array.isArray(value) ? value[0] : value;
  return (USAGE_PERIOD_IDS as readonly unknown[]).includes(candidate)
    ? (candidate as UsagePeriodId)
    : DEFAULT_USAGE_PERIOD;
};

type CalendarDate = { year: number; month: number; day: number };

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

const partsFormatter = (timeZone: string) => {
  let formatter = partsFormatterCache.get(timeZone);
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
    partsFormatterCache.set(timeZone, formatter);
  }
  return formatter;
};

const zonedParts = (instant: Date, timeZone: string) => {
  const values: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
};

export const zonedCalendarDate = (instant: Date, timeZone: string): CalendarDate => {
  const { year, month, day } = zonedParts(instant, timeZone);
  return { year, month, day };
};

/** Shifts a calendar date by whole days, month and year boundaries included. */
export const addCalendarDays = (date: CalendarDate, days: number): CalendarDate => {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
};

const addCalendarMonths = (date: CalendarDate, months: number): CalendarDate => {
  const shifted = new Date(Date.UTC(date.year, date.month - 1 + months, 1));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: 1 };
};

export const calendarDateKey = (date: CalendarDate) =>
  `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(
    date.day
  ).padStart(2, "0")}`;

/**
 * The UTC instant at which a calendar date starts in the zone.
 *
 * Found by bisection on "has the local date reached this day yet", which is
 * monotonic in time, rather than by subtracting an offset. Offset arithmetic
 * fails where a daylight-saving change happens at midnight: in Santiago on
 * 6 September 2026 00:00 does not exist, the day starts at 01:00, and an
 * offset guess lands on 23:00 the day before. Brisbane has no such day, but
 * the reader takes the zone as a parameter and must not be wrong elsewhere.
 */
export const zonedStartOfDay = (date: CalendarDate, timeZone: string): Date => {
  const target = calendarDateKey(date);
  const midnightUtc = Date.UTC(date.year, date.month - 1, date.day);
  // Every zone's offset lies within -12h..+14h, so local time at these bounds
  // is certainly the day before and certainly on or after the target day.
  let before = midnightUtc - 15 * 3_600_000;
  let reached = midnightUtc + 15 * 3_600_000;
  const reachedTarget = (ms: number) =>
    calendarDateKey(zonedCalendarDate(new Date(ms), timeZone)) >= target;
  while (reached - before > 1000) {
    const middle = Math.floor((before + reached) / 2000) * 1000;
    if (middle === before) break;
    if (reachedTarget(middle)) reached = middle;
    else before = middle;
  }
  return new Date(reached);
};

export type UsageWindow = {
  id: UsagePeriodId;
  timeZone: string;
  start: Date;
  /** Exclusive. `now` for a period still in progress. */
  end: Date;
  previousStart: Date;
  previousEnd: Date;
  /** First and last local calendar day the window touches, inclusive. */
  firstDay: string;
  lastDay: string;
  dayCount: number;
  /** True while the window ends at `now` rather than at a day boundary. */
  inProgress: boolean;
};

const daysBetween = (from: CalendarDate, to: CalendarDate) =>
  Math.round(
    (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) /
      86_400_000
  );

/**
 * Resolves a period to its instants and to the comparison window before it.
 *
 * A period in progress is compared with the same elapsed span of the previous
 * one -- today until 15:00 against yesterday until 15:00 -- because a whole
 * previous day would make every morning look like a collapse.
 */
export const resolveUsageWindow = (
  id: UsagePeriodId,
  now: Date,
  timeZone: string = OPERATOR_TIME_ZONE
): UsageWindow => {
  const today = zonedCalendarDate(now, timeZone);
  const startOf = (date: CalendarDate) => zonedStartOfDay(date, timeZone);
  const elapsedToday = now.getTime() - startOf(today).getTime();

  const rolling = (days: number): UsageWindow => {
    const first = addCalendarDays(today, -(days - 1));
    const previousFirst = addCalendarDays(first, -days);
    return {
      id,
      timeZone,
      start: startOf(first),
      end: now,
      previousStart: startOf(previousFirst),
      previousEnd: new Date(startOf(addCalendarDays(today, -days)).getTime() + elapsedToday),
      firstDay: calendarDateKey(first),
      lastDay: calendarDateKey(today),
      dayCount: days,
      inProgress: true,
    };
  };

  switch (id) {
    case "yesterday": {
      const day = addCalendarDays(today, -1);
      return {
        id,
        timeZone,
        start: startOf(day),
        end: startOf(today),
        previousStart: startOf(addCalendarDays(day, -1)),
        previousEnd: startOf(day),
        firstDay: calendarDateKey(day),
        lastDay: calendarDateKey(day),
        dayCount: 1,
        inProgress: false,
      };
    }
    case "last7":
      return rolling(7);
    case "last30":
      return rolling(30);
    case "thisMonth": {
      const first = { ...today, day: 1 };
      const previousFirst = addCalendarMonths(first, -1);
      const previousStart = startOf(previousFirst);
      const previousCap = startOf(first);
      const aligned = new Date(
        startOf(addCalendarDays(previousFirst, today.day - 1)).getTime() + elapsedToday
      );
      return {
        id,
        timeZone,
        start: startOf(first),
        end: now,
        previousStart,
        // A 31st has no counterpart in a 30-day month; the comparison stops
        // at the end of that month instead of running into this one.
        previousEnd: aligned < previousCap ? aligned : previousCap,
        firstDay: calendarDateKey(first),
        lastDay: calendarDateKey(today),
        dayCount: today.day,
        inProgress: true,
      };
    }
    case "lastMonth": {
      const thisFirst = { ...today, day: 1 };
      const first = addCalendarMonths(thisFirst, -1);
      const last = addCalendarDays(thisFirst, -1);
      return {
        id,
        timeZone,
        start: startOf(first),
        end: startOf(thisFirst),
        previousStart: startOf(addCalendarMonths(first, -1)),
        previousEnd: startOf(first),
        firstDay: calendarDateKey(first),
        lastDay: calendarDateKey(last),
        dayCount: daysBetween(first, last) + 1,
        inProgress: false,
      };
    }
    case "today":
    default:
      return {
        id: "today",
        timeZone,
        start: startOf(today),
        end: now,
        previousStart: startOf(addCalendarDays(today, -1)),
        previousEnd: new Date(startOf(addCalendarDays(today, -1)).getTime() + elapsedToday),
        firstDay: calendarDateKey(today),
        lastDay: calendarDateKey(today),
        dayCount: 1,
        inProgress: true,
      };
  }
};

/** Local calendar day keys a window covers, oldest first. */
export const windowDayKeys = (window: Pick<UsageWindow, "firstDay" | "dayCount">) => {
  const [year, month, day] = window.firstDay.split("-").map(Number);
  return Array.from({ length: window.dayCount }, (_, index) =>
    calendarDateKey(addCalendarDays({ year, month, day }, index))
  );
};

/**
 * Relative change against the previous window, in percent.
 *
 * `null` when there is nothing to compare with: a rise from zero has no
 * percentage, and printing "+100%" or "∞" would invent one.
 */
export const percentChange = (current: number, previous: number): number | null =>
  previous > 0 ? ((current - previous) / previous) * 100 : null;

/** `null` rather than 0 when the denominator is empty. */
export const safeRatio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null;

export type ShareInput = { key: string | null | undefined; count: number };

export type ShareRow = { key: string; count: number; share: number };

export type ShareTable = { total: number; rows: ShareRow[] };

/**
 * Sorts counts into a share table, folding the tail into one "other" row.
 *
 * Missing keys become "unknown" and stay a visible row: a distribution that
 * dropped them would report shares of the people it could classify as if they
 * were shares of everyone.
 */
export const shareTable = (
  input: readonly ShareInput[],
  limit: number = USAGE_SHARE_LIMIT
): ShareTable => {
  const merged = new Map<string, number>();
  for (const row of input) {
    const key = row.key?.trim() ? row.key.trim() : UNKNOWN_SEGMENT;
    merged.set(key, (merged.get(key) ?? 0) + Number(row.count));
  }
  const sorted = [...merged.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = sorted.reduce((sum, [, count]) => sum + count, 0);
  const head = sorted.length > limit ? sorted.slice(0, limit - 1) : sorted;
  const tail = sorted.length > limit ? sorted.slice(limit - 1) : [];
  const rows = head.map(([key, count]) => ({ key, count, share: total ? count / total : 0 }));
  if (tail.length) {
    const count = tail.reduce((sum, [, value]) => sum + value, 0);
    rows.push({ key: OTHER_SEGMENT, count, share: total ? count / total : 0 });
  }
  return { total, rows };
};

/**
 * A 7 x 24 matrix of counts, Monday first.
 *
 * `dow` is PostgreSQL's `EXTRACT(DOW ...)`: 0 is Sunday. Monday first because
 * that is how an operator reads a working week.
 */
export const weekHourMatrix = (
  rows: readonly { dow: number; hour: number; count: number }[]
): number[][] => {
  const matrix = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const row of rows) {
    const dow = Number(row.dow);
    const hour = Number(row.hour);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) continue;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    matrix[(dow + 6) % 7][hour] += Number(row.count);
  }
  return matrix;
};

export const matrixHourTotals = (matrix: readonly (readonly number[])[]) =>
  Array.from({ length: 24 }, (_, hour) =>
    matrix.reduce((sum, day) => sum + (day[hour] ?? 0), 0)
  );

export const matrixDayTotals = (matrix: readonly (readonly number[])[]) =>
  matrix.map((day) => day.reduce((sum, value) => sum + value, 0));

/** The busiest hour, or `null` when nothing happened. Earliest wins a tie. */
export const peakIndex = (values: readonly number[]): number | null => {
  let best: number | null = null;
  values.forEach((value, index) => {
    if (value > 0 && (best === null || value > values[best])) best = index;
  });
  return best;
};

/**
 * The continent part of an IANA zone, used as a coarse geography.
 *
 * An account's time zone is set by its browser on first sign-in, so unlike a
 * declared country it exists for nearly every account. It is a proxy, and the
 * screen says so: a VPN or a travelling laptop moves it.
 */
export const timeZoneRegion = (timeZone: string | null | undefined): string => {
  const value = timeZone?.trim();
  if (!value) return UNKNOWN_SEGMENT;
  if (value === "UTC" || value.startsWith("Etc/") || value === "GMT") return "UTC";
  const [region] = value.split("/");
  return [
    "Africa",
    "America",
    "Antarctica",
    "Arctic",
    "Asia",
    "Atlantic",
    "Australia",
    "Europe",
    "Indian",
    "Pacific",
  ].includes(region)
    ? region
    : UNKNOWN_SEGMENT;
};

export type DailyPoint = {
  day: string;
  accounts: number;
  guests: number;
  requests: number;
  messages: number;
};

/** Fills every day of the window, so a quiet day is a zero bar, not a gap. */
export const denseDailySeries = (
  dayKeys: readonly string[],
  rows: readonly Partial<DailyPoint>[]
): DailyPoint[] => {
  const byDay = new Map<string, Partial<DailyPoint>>();
  for (const row of rows) {
    if (!row.day) continue;
    const existing = byDay.get(row.day) ?? {};
    byDay.set(row.day, { ...existing, ...row });
  }
  return dayKeys.map((day) => {
    const row = byDay.get(day) ?? {};
    return {
      day,
      accounts: Number(row.accounts ?? 0),
      guests: Number(row.guests ?? 0),
      requests: Number(row.requests ?? 0),
      messages: Number(row.messages ?? 0),
    };
  });
};

/**
 * Average daily active accounts over complete days, divided by the distinct
 * accounts over the same span. `null` below one active account.
 */
export const stickiness = (dailyAccounts: readonly number[], distinctAccounts: number) => {
  if (!dailyAccounts.length) return null;
  const average = dailyAccounts.reduce((sum, value) => sum + value, 0) / dailyAccounts.length;
  return safeRatio(average, distinctAccounts);
};
