/**
 * Today's date, told to the model on every chat turn.
 *
 * Without it a model takes its training cutoff for the present: asked in 2026
 * for "events in Bangkok this December", Gemini Flash-Lite searched for and
 * answered with December 2024, and GPT 6 Luna dated "today's Brisbane weather"
 * to a January day it made up.
 *
 * The date only, in UTC, with no time of day. A system block that changed every
 * request would end provider prefix caching for every turn; one that changes
 * once a day costs a single miss at the boundary. When the client reports its
 * IANA time zone the block states the user's local date as well; without one it
 * says the local date may differ by a day.
 */

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** `2026-10-29`, the UTC calendar date of `now`. */
export const utcDateString = (now: Date): string =>
  now.toISOString().slice(0, 10);

const TIME_ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,3}$/;

/**
 * An IANA time zone name the client reported, or null.
 *
 * The request field is client-controlled and ends up in a system block, so it
 * is accepted only when it has the shape of a zone name AND the runtime's own
 * zone database knows it. Anything else is dropped and the block falls back to
 * the UTC wording.
 */
export const parseClientTimeZone = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 64 || !TIME_ZONE_SHAPE.test(value)) {
    return null;
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone
      ? value
      : null;
  } catch {
    return null;
  }
};

/** The browser's own zone, for the request. Null where Intl cannot say. */
export const readBrowserTimeZone = (): string | null => {
  try {
    return parseClientTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
};

/** `{ weekday, date }` of `now` on the calendar of `timeZone`. */
const localCalendarDay = (now: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    weekday: pick("weekday"),
    date: `${pick("year")}-${pick("month")}-${pick("day")}`,
  };
};

export const buildChatCurrentDatePrompt = (
  now: Date = new Date(),
  /** A validated IANA zone (`parseClientTimeZone`). Absent: the UTC wording. */
  timeZone?: string | null
): string => {
  const zone = timeZone ? parseClientTimeZone(timeZone) : null;
  const local = zone ? localCalendarDay(now, zone) : null;
  const today = zone && local
    ? `Today is ${local.weekday}, ${local.date} ` +
      `in the user's time zone (${zone}); the UTC date is ${utcDateString(now)}.`
    : `Today is ${WEEKDAYS[now.getUTCDay()]}, ${utcDateString(now)} (UTC). The ` +
      "user's local date may be one day earlier or later.";
  return [
    "# Current date",
    today,
    "This is the present. Read today, this week, this month, this year, " +
      "this December, upcoming and recent relative to it, not to your " +
      "training data, which ends earlier. When you search for anything dated, " +
      "put the year in the query. Never present an event that ended before " +
      "today as current or upcoming, and if a source does not say which year " +
      "it describes, say so rather than assume.",
  ].join("\n");
};
