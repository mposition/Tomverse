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
 */

export type QuietHours = { start: string; end: string; tz: string };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const minutesOf = (value: string): number | null => {
  const match = HHMM.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

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
  return { start, end, tz };
};

/** Wall-clock minutes since local midnight in `tz`, and the seconds past the minute. */
const localClock = (now: Date, tz: string) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { minutes: read("hour") * 60 + read("minute"), seconds: read("second") };
};

/**
 * The instant the window ends if `now` is inside it, otherwise null.
 *
 * The window is `[start, end)` in the profile's zone and may cross midnight
 * (21:00 to 08:00). The end is computed by wall-clock distance, which is exact
 * for zones without a daylight-saving change inside the window -- Asia/Seoul
 * has none. Where a zone does shift inside the window, the result can be up to
 * the size of that shift early or late; a profile for such a zone should be
 * reviewed with that in mind before it names a window.
 */
export const quietHoursEnd = (quietHours: QuietHours, now: Date): Date | null => {
  const start = minutesOf(quietHours.start)!;
  const end = minutesOf(quietHours.end)!;
  const { minutes, seconds } = localClock(now, quietHours.tz);

  const inside =
    start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  if (!inside) return null;

  const minutesUntilEnd = (end - minutes + 1440) % 1440;
  const ms = now.getTime() - seconds * 1_000 - (now.getTime() % 1_000);
  return new Date(ms + minutesUntilEnd * 60_000);
};
