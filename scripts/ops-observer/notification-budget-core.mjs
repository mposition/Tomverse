// Which owed messages a run may reserve, and the daily maximum that follows.
//
// docs/policy/sre-ops.md §5 is the contract:
// - at most one page message per run; everything owed in a run is bundled;
// - each kind at most once per incident (the store's unique enforces it);
// - new opens are never capped (classify already makes them once per key per
//   owner date);
// - the first worsening of a key on an owner date is not capped; every later
//   worsening of that key on that date is;
// - reopens, recoveries and those later worsenings share a cap of 6 per owner
//   date; past it they are not sent and go to the digest instead;
// - the weekly channel check is once per owner date and counted on its own.
//
// The store re-runs the same functions inside the reservation transaction, so
// the runner and the database cannot disagree about what was admissible.

export const DAILY_CAPPED_LIMIT = 6;

export const MESSAGE_KINDS = ["new_open", "worsening", "reopen", "recovery"];

/**
 * Split owed items into those the run may reserve and those deferred to the
 * digest.
 *
 * `reservedToday` are items already reserved for this genesis on this owner
 * date: `{ key, kind, capped }`. `owed` are this run's items: `{ key, kind }`.
 * Returns `{ admitted, deferred }`, each item annotated with `capped`.
 */
export function admitOwedItems({ reservedToday, owed }) {
  for (const item of [...reservedToday, ...owed]) {
    if (!MESSAGE_KINDS.includes(item.kind)) throw new Error("ops_observer_message_kind_unknown");
    if (typeof item.key !== "string" || item.key.length === 0) throw new Error("ops_observer_key_invalid");
  }

  let cappedUsed = reservedToday.filter((item) => item.capped).length;
  const worsenedKeys = new Set(reservedToday.filter((i) => i.kind === "worsening").map((i) => i.key));
  const admitted = [];
  const deferred = [];

  for (const item of owed) {
    let capped;
    if (item.kind === "new_open") capped = false;
    else if (item.kind === "worsening") capped = worsenedKeys.has(item.key);
    else capped = true;

    if (item.kind === "worsening") worsenedKeys.add(item.key);

    if (capped && cappedUsed >= DAILY_CAPPED_LIMIT) {
      deferred.push({ ...item, capped });
      continue;
    }
    if (capped) cappedUsed += 1;
    admitted.push({ ...item, capped });
  }
  return { admitted, deferred };
}

/**
 * The run's single message, or `null` when nothing is owed.
 *
 * `admitted` comes from `admitOwedItems`; `channelCheckDue` is true when the
 * run is inside the check window and today's check has not been reserved.
 */
export function planRunMessage({ admitted, channelCheckDue }) {
  if (admitted.length === 0 && !channelCheckDue) return null;
  if (admitted.length === 0) return { kind: "channel_check", items: [], withChannelCheck: true };
  return { kind: "page", items: admitted, withChannelCheck: Boolean(channelCheckDue) };
}

/**
 * The most page messages one owner date can carry for one genesis.
 *
 * `keyCount` new opens (one per key per date) + `worseningKeyCount` first
 * worsenings + the shared cap, plus one on a channel-check day. A genesis day
 * may carry a second genesis's worth (see `maxMessagesOnGenesisDay`).
 */
export function maxDailyMessages({ keyCount, worseningKeyCount, channelCheckDay = false }) {
  for (const n of [keyCount, worseningKeyCount]) {
    if (!Number.isInteger(n) || n < 0) throw new Error("ops_observer_count_invalid");
  }
  if (worseningKeyCount > keyCount) throw new Error("ops_observer_count_invalid");
  return keyCount + worseningKeyCount + DAILY_CAPPED_LIMIT + (channelCheckDay ? 1 : 0);
}

/** A genesis restarts counts, and at most one genesis per date may send. */
export function maxMessagesOnGenesisDay({ keyCount, worseningKeyCount }) {
  return (
    maxDailyMessages({ keyCount, worseningKeyCount, channelCheckDay: true }) +
    maxDailyMessages({ keyCount, worseningKeyCount })
  );
}
