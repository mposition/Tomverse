/**
 * When a marketing message may not be delivered because of a night-time rule.
 *
 * Contract: docs/policy/email-notifications.md §5.2 E5, §12.6, §21 Q4.
 *
 * Pure and dependency-free. The lane reads the profile and calls this.
 *
 * ## What the rule is
 *
 * Korea's 정보통신망법 제50조제3항 requires separate prior consent for
 * advertising sent between 21:00 and 08:00. Whether e-mail is one of the media
 * the enforcement decree exempts is Q4 and unanswered, so the KR profile
 * carries the window and §21 Q4 says to apply it until that is confirmed.
 * Until this module the window was stored, shown in the admin console, and
 * consulted by nothing that sends.
 *
 * ## Deferred, not skipped
 *
 * §12.6 says campaigns respect quiet hours "by delaying automatically". A
 * message reached at 23:00 Seoul time is not refused; it waits for 08:00 and
 * goes then. Skipping would turn every evening campaign wave into a silent
 * loss for Korean recipients.
 *
 * ## Whose clock
 *
 * The profile's own zone (`tz`), never the server's and never the recipient's
 * browser. The rule attaches to the jurisdiction, and a Korean resident reading
 * mail abroad is still inside it.
 *
 * ## Zones with daylight saving are refused
 *
 * The end of the window is computed by wall-clock distance, which is exact only
 * where the UTC offset does not change. Rather than send an hour early on the
 * night a clock moves, `parseQuietHours()` refuses a zone whose offset differs
 * between January and July. Asia/Seoul has no daylight saving. A profile that
 * needs a zone with it needs a zone-aware implementation first.
 */

export type QuietHours = { start: string; end: string; tz: string };

/**
 * How close to the start of a window counts as inside it.
 *
 * A delivery is checked, then rendered and handed to the provider; a check at
 * 20:59:59 must not produce a send at 21:00:03. Five minutes is far longer than
 * that path takes and costs a message at most five minutes' delay.
 */
export const QUIET_HOURS_START_MARGIN_MS = 5 * 60 * 1_000;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const minutesOf = (value: string): number | null => {
  const match = HHMM.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

/** Wall-clock minutes since local midnight in `tz`, and the seconds past the minute. */
const localClock = (at: Date, tz: string) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { minutes: read("hour") * 60 + read("minute"), seconds: read("second") };
};

/** Offset from UTC in minutes at an instant, modulo a day. */
const offsetMinutes = (at: Date, tz: string) =>
  (localClock(at, tz).minutes - (at.getUTCHours() * 60 + at.getUTCMinutes()) + 1440) % 1440;

/** Reads the stored JSON, refusing anything malformed rather than guessing. */
export const parseQuietHours = (value: unknown): QuietHours | null | "invalid" => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return "invalid";
  const { start, end, tz } = value as Record<string, unknown>;
  if (typeof start !== "string" || typeof end !== "string" || typeof tz !== "string") {
    return "invalid";
  }
  if (minutesOf(start) === null || minutesOf(end) === null || start === end) {
    return "invalid";
  }
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
  } catch {
    return "invalid";
  }
  // Refuse a zone that observes daylight saving in either hemisphere.
  const year = new Date().getUTCFullYear();
  if (
    offsetMinutes(new Date(Date.UTC(year, 0, 15, 12)), tz) !==
    offsetMinutes(new Date(Date.UTC(year, 6, 15, 12)), tz)
  ) {
    return "invalid";
  }
  return { start, end, tz };
};

const isInside = (quietHours: QuietHours, at: Date) => {
  const start = minutesOf(quietHours.start)!;
  const end = minutesOf(quietHours.end)!;
  const { minutes } = localClock(at, quietHours.tz);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
};

/**
 * The instant the window ends if `now` is inside it -- or within
 * `QUIET_HOURS_START_MARGIN_MS` of its start -- otherwise null.
 *
 * The window is `[start, end)` in the profile's zone and may cross midnight
 * (21:00 to 08:00).
 */
export const quietHoursEnd = (quietHours: QuietHours, now: Date): Date | null => {
  const probe = isInside(quietHours, now)
    ? now
    : isInside(quietHours, new Date(now.getTime() + QUIET_HOURS_START_MARGIN_MS))
      ? new Date(now.getTime() + QUIET_HOURS_START_MARGIN_MS)
      : null;
  if (!probe) return null;

  const end = minutesOf(quietHours.end)!;
  const { minutes, seconds } = localClock(probe, quietHours.tz);
  const minutesUntilEnd = (end - minutes + 1440) % 1440;
  const flooredToMinute = probe.getTime() - seconds * 1_000 - (probe.getTime() % 1_000);
  return new Date(flooredToMinute + minutesUntilEnd * 60_000);
};

/**
 * The latest end among several windows, or "invalid" if any cannot be read.
 * The lane consults both the pinned and the currently resolved profile.
 */
export const deferralFor = (
  windows: Array<{ profileKey: string; quietHours: unknown }>,
  now: Date
): { until: Date | null } | { invalid: string } => {
  let until: Date | null = null;
  for (const window of windows) {
    const quietHours = parseQuietHours(window.quietHours);
    if (quietHours === "invalid") return { invalid: window.profileKey };
    const end = quietHours ? quietHoursEnd(quietHours, now) : null;
    if (end && (!until || end > until)) until = end;
  }
  return { until };
};
