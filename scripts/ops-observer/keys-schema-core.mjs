// The closed schema of the ops-observer key states (docs/policy/sre-ops.md §1,
// §5): what OpsObserverState.keys holds and what an advance request carries.
// It is T2 of the trust check, and the store checks an advance's keys with the
// same function before it writes them.
//
// Closed means: exactly the S2 page keys, each with exactly the six fields
// evaluateKey() reads and writes, every field in the shape that function can
// produce. An open key has its open time, its owner date and one of its own
// signal's bands; a closed key has no band. Anything else -- an extra key, a
// missing field, a band from another signal -- is not a state this agent wrote.

import { RECOVERY_STREAK, S2_PAGE_SIGNALS, STREAK_MAX } from "./classify-core.mjs";

const FIELDS = Object.freeze(["status", "streak", "openedAt", "lastBand", "recoveredAt", "newOpenOwnerDate"]);

const SIGNAL_BY_KEY = new Map(
  S2_PAGE_SIGNALS.flatMap((signal) => signal.scopes.map((scope) => [`${signal.id}#${scope}`, signal])),
);

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const isInstantMs = (value) => Number.isSafeInteger(value) && value >= 0;

function isOwnerDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Whether one key's state is one evaluateKey() could have produced for `signal`. */
export function isKeyState(signal, state) {
  if (!isPlainObject(state)) return false;
  const keys = Object.keys(state);
  if (keys.length !== FIELDS.length || !FIELDS.every((field) => Object.hasOwn(state, field))) return false;
  const { status, streak, openedAt, lastBand, recoveredAt, newOpenOwnerDate } = state;
  if (!Number.isSafeInteger(streak) || streak < 0 || streak > STREAK_MAX) return false;
  if (!(openedAt === null || isInstantMs(openedAt))) return false;
  if (!(recoveredAt === null || isInstantMs(recoveredAt))) return false;
  if (!(newOpenOwnerDate === null || isOwnerDate(newOpenOwnerDate))) return false;
  if (status === "open") {
    // An open key counts good samples toward recovery and recovers at
    // RECOVERY_STREAK, so it never holds that many. It was opened (time and
    // owner date set); a recovery time, if any, is from an earlier incident.
    return (
      streak < RECOVERY_STREAK &&
      openedAt !== null &&
      newOpenOwnerDate !== null &&
      signal.bands.includes(lastBand) &&
      (recoveredAt === null || recoveredAt <= openedAt)
    );
  }
  if (status === "closed") {
    // A closed key counts bad samples toward opening and opens at openAfter.
    if (streak >= signal.openAfter || lastBand !== null) return false;
    // Either it never opened (all three unset) or it opened and recovered
    // (all three set, recovered no earlier than opened). evaluateKey() writes
    // no other combination, and a mixed one would change whether the next
    // open is a capped reopen or an uncapped new open (policy §5).
    const never = openedAt === null && recoveredAt === null && newOpenOwnerDate === null;
    const recovered =
      openedAt !== null && recoveredAt !== null && newOpenOwnerDate !== null && recoveredAt >= openedAt;
    return never || recovered;
  }
  return false;
}

/** T2: `keys` is exactly the S2 page keys, each a valid state for its signal. */
export function keysAreValid(keys) {
  if (!isPlainObject(keys)) return false;
  const names = Object.keys(keys);
  if (names.length !== SIGNAL_BY_KEY.size) return false;
  return names.every((name) => SIGNAL_BY_KEY.has(name) && isKeyState(SIGNAL_BY_KEY.get(name), keys[name]));
}
