/**
 * The office's clock: every time it shows is Brisbane time (AEST), the
 * operator's own. Records keep their UTC instants; only what is drawn moves.
 */

/** Brisbane's offset from UTC. Queensland keeps no daylight saving, so AEST holds all year. */
const BRISBANE_OFFSET_MS = 10 * 60 * 60 * 1000;

/**
 * An instant as an ISO string on Brisbane's wall clock (the `Z` no longer
 * means UTC), or null when the instant does not parse. A fixed offset rather
 * than Intl, so the server and any browser draw the same digits.
 */
export function brisbaneIso(iso: string): string | null {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at + BRISBANE_OFFSET_MS).toISOString() : null;
}

/** An instant as `MM-DD HH:mm AEST`. */
export function aestStamp(iso: string): string {
  const local = brisbaneIso(iso);
  return local ? `${local.slice(5, 10)} ${local.slice(11, 16)} AEST` : "—";
}

/** An instant as `HH:mm AEST`, for a line said today. */
export function aestClock(iso: string): string {
  const local = brisbaneIso(iso);
  return local ? `${local.slice(11, 16)} AEST` : "—";
}
