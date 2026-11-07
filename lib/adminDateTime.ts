import { formatAestDateTime } from "@/lib/adminUiCore";

const FALLBACK_TIME_ZONE = "Australia/Brisbane";

/**
 * The admin console's one date formatter for a customer's instant.
 *
 * Every timestamp an administrator reads about a customer is rendered in the
 * *customer's* time zone by default, so "until 09:00" means the same instant to
 * the reader and to the person the control applies to. A customer zone that
 * reads "UTC" is the customer's own data and is shown as it is.
 *
 * When there is no customer zone, or it cannot be read, the console falls back
 * to AEST (Brisbane), the time the operator reads everywhere else.
 */
export const adminDateTimeLabel = (
  value: string | null | undefined,
  timeZone: string | null | undefined = FALLBACK_TIME_ZONE
) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const zone = timeZone || FALLBACK_TIME_ZONE;
  if (zone === FALLBACK_TIME_ZONE) return formatAestDateTime(date) ?? "-";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).format(date);
  } catch {
    return formatAestDateTime(date) ?? "-";
  }
};
