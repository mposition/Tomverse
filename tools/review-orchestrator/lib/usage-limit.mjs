// A reviewer CLI that has run out of its plan says so in its own output and
// exits non-zero ("You've hit your weekly limit · resets Nov 26, 1am (UTC)").
// That refusal is the vendor's own answer, so it outranks a quota probe: on
// 2026-11-23 the Claude probe kept reading "available" while every Claude
// review failed in two seconds on its weekly limit.

/** How long a provider is held when its message names no reset time we can read. */
export const USAGE_LIMIT_FALLBACK_MS = 60 * 60_000;
/** The longest hold: a week and a day. A later reset is read as a parse error. */
export const USAGE_LIMIT_MAX_MS = 8 * 24 * 60 * 60_000;

const LIMIT_PATTERN = /\b(?:hit|reached) your [\w -]*limit\b|\busage limit reached\b|\blimit reached\W+resets?\b/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The usage limit a failed reviewer reported, or null. Only the tail of its
 * stdout and the head of its stderr are read: that is where a CLI prints the
 * refusal, and a review's own text never gets there.
 */
export function usageLimitFrom({ stdout = "", stderr = "" } = {}, now = Date.now()) {
  const text = `${stdout.slice(-2000)}\n${stderr.slice(0, 2000)}`;
  const match = LIMIT_PATTERN.exec(text);
  if (!match) return null;
  const lineStart = text.lastIndexOf("\n", match.index) + 1;
  const line = text.slice(lineStart).split("\n")[0].trim().slice(0, 300);
  const reset = resetTimeFrom(text.slice(match.index), now);
  const until = reset !== null && reset > now && reset - now <= USAGE_LIMIT_MAX_MS
    ? reset : now + USAGE_LIMIT_FALLBACK_MS;
  return { until, message: line };
}

/** The reset time in the message, as epoch ms, or null when it names none we can read. */
export function resetTimeFrom(text, now = Date.now()) {
  // Older Claude CLIs: "Claude AI usage limit reached|1732582800".
  const epoch = /\|(\d{10})\b/.exec(text);
  if (epoch) return Number(epoch[1]) * 1000;
  // "resets Nov 26, 1am (UTC)", "resets 3:30pm (Australia/Brisbane)", "resets Nov 26 (UTC)".
  const reset = /\bresets?\s+(?:at\s+)?(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s*)?(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm))?\s*(?:\(([^)]+)\))?/i.exec(text);
  if (!reset || (!reset[1] && !reset[3])) return null;
  const zone = reset[6]?.trim() ?? "UTC";
  if (!validZone(zone)) return null;
  let hour = reset[3] ? Number(reset[3]) % 12 + (reset[5].toLowerCase() === "pm" ? 12 : 0) : 0;
  const minute = reset[4] ? Number(reset[4]) : 0;
  if (hour > 23 || minute > 59) return null;
  const today = zonedParts(now, zone);
  if (reset[1]) {
    const month = MONTHS.indexOf(reset[1].toLowerCase());
    const day = Number(reset[2]);
    if (month < 0 || day < 1 || day > 31) return null;
    let at = zonedToUtc(today.year, month, day, hour, minute, zone);
    // "Jan 2" read on Dec 30 is next year's.
    if (at <= now) at = zonedToUtc(today.year + 1, month, day, hour, minute, zone);
    return at;
  }
  let at = zonedToUtc(today.year, today.month, today.day, hour, minute, zone);
  if (at <= now) at = zonedToUtc(today.year, today.month, today.day + 1, hour, minute, zone);
  return at;
}

function validZone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function zonedParts(at, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
  }).formatToParts(new Date(at)).map((part) => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month - 1, day: parts.day, hour: parts.hour, minute: parts.minute };
}

/** The UTC instant of a wall-clock time in `zone` (two passes settle a DST edge). */
function zonedToUtc(year, month, day, hour, minute, zone) {
  const wall = Date.UTC(year, month, day, hour, minute);
  let at = wall;
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = zonedParts(at, zone);
    at += wall - Date.UTC(seen.year, seen.month, seen.day, seen.hour, seen.minute);
  }
  return at;
}
