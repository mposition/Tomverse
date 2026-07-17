export const DEFAULT_USER_TIME_ZONE = "UTC";
export const USER_TIME_ZONE_CHANGE_COOLDOWN_MS = 30 * 86_400_000;

type LocalDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const dayStartCache = new Map<string, number>();

const formatterFor = (timeZone: string) => {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
};

export const canonicalizeIanaTimeZone = (value: unknown) => {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > 100) return null;

  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: candidate,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
};

export const isValidIanaTimeZone = (value: unknown): value is string =>
  canonicalizeIanaTimeZone(value) !== null;

export const normalizeIanaTimeZone = (value: unknown) =>
  canonicalizeIanaTimeZone(value) || DEFAULT_USER_TIME_ZONE;

export const detectBrowserTimeZone = () => {
  if (typeof Intl === "undefined") return null;
  try {
    return canonicalizeIanaTimeZone(
      Intl.DateTimeFormat().resolvedOptions().timeZone
    );
  } catch {
    return null;
  }
};

const localPartsAt = (date: Date, timeZone: string): LocalDateParts => {
  const values = new Map(
    formatterFor(timeZone)
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );

  return {
    year: values.get("year") || 0,
    month: values.get("month") || 0,
    day: values.get("day") || 0,
    hour: values.get("hour") || 0,
    minute: values.get("minute") || 0,
    second: values.get("second") || 0,
  };
};

const localDateStartToUtc = (
  timeZone: string,
  year: number,
  month: number,
  day: number
) => {
  const cacheKey = `${timeZone}:${year}-${month}-${day}`;
  const cached = dayStartCache.get(cacheKey);
  if (cached !== undefined) return new Date(cached);

  const targetDate = Date.UTC(year, month - 1, day);
  let lower = targetDate - 48 * 60 * 60 * 1000;
  let upper = targetDate + 48 * 60 * 60 * 1000;

  // Search for the first UTC instant whose local calendar date is the target
  // date. This also handles zones whose DST transition skips or repeats local
  // midnight instead of assuming that every local day lasts 24 hours.
  while (upper - lower > 1) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const local = localPartsAt(new Date(middle), timeZone);
    const localDate = Date.UTC(local.year, local.month - 1, local.day);
    if (localDate < targetDate) lower = middle;
    else upper = middle;
  }

  if (dayStartCache.size > 1_000) dayStartCache.clear();
  dayStartCache.set(cacheKey, upper);
  return new Date(upper);
};

export type UserDayWindow = {
  timeZone: string;
  start: Date;
  end: Date;
};

export const getZonedDayWindow = (
  timeZoneValue: unknown,
  now = new Date()
): UserDayWindow => {
  const timeZone = normalizeIanaTimeZone(timeZoneValue);
  const localNow = localPartsAt(now, timeZone);
  const nextLocalDate = new Date(
    Date.UTC(localNow.year, localNow.month - 1, localNow.day + 1)
  );

  const start = localDateStartToUtc(
    timeZone,
    localNow.year,
    localNow.month,
    localNow.day
  );
  const end = localDateStartToUtc(
    timeZone,
    nextLocalDate.getUTCFullYear(),
    nextLocalDate.getUTCMonth() + 1,
    nextLocalDate.getUTCDate()
  );

  return { timeZone, start, end };
};

export const getUserTimeZoneChangeAllowedAt = (
  changedAt: Date | string | null | undefined
) => {
  if (!changedAt) return null;
  const timestamp =
    changedAt instanceof Date ? changedAt.getTime() : Date.parse(changedAt);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp + USER_TIME_ZONE_CHANGE_COOLDOWN_MS);
};
