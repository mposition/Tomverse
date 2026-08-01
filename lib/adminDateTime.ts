/**
 * The admin console's one date formatter.
 *
 * Every timestamp an administrator reads is rendered in the *customer's* time
 * zone by default, so "until 09:00" means the same instant to the reader and
 * to the person the control applies to.
 */
export const adminDateTimeLabel = (
  value: string | null | undefined,
  timeZone = "UTC"
) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }
};
