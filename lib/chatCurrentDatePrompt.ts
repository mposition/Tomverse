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
 * once a day costs a single miss at the boundary. The client sends no time
 * zone, so the block says the user's local date may differ by a day.
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

export const buildChatCurrentDatePrompt = (now: Date = new Date()): string =>
  [
    "# Current date",
    `Today is ${WEEKDAYS[now.getUTCDay()]}, ${utcDateString(now)} (UTC). The ` +
      "user's local date may be one day earlier or later.",
    "This is the present. Read today, this week, this month, this year, " +
      "this December, upcoming and recent relative to it, not to your " +
      "training data, which ends earlier. When you search for anything dated, " +
      "put the year in the query. Never present an event that ended before " +
      "today as current or upcoming, and if a source does not say which year " +
      "it describes, say so rather than assume.",
  ].join("\n");
