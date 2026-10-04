// The request body of the ops-observer advance route (docs/policy/sre-ops.md
// §3-3, §3-9, §5, §6): the run's next key states and, at most, one
// reservation. Closed, and checked against itself before any transaction
// opens:
//
//   { runDeadline, runId, baseGenesisId, baseGeneration, keys, reservation }
//   reservation: null | { ownerDate, channelCheck, items: [{ signal, scope,
//                kind, origin, openedAt }] }
//
// The request does not say whether an item counts against the daily cap, and
// its kind is not taken on trust either: new_open and a key's first worsening
// of the day are outside the cap (§5), so a label would be an exemption. The
// parser refuses, early, items that cannot agree with the key state the same
// request writes (one item per page key, the same incident open time, a kind
// the next state can carry). The store then derives what the move from the
// current keys to these keys owes with owedMessages() -- the rules
// evaluateKey() applies -- and reserves only items in that set.

import { REOPEN_WINDOW_MS, S2_PAGE_KEYS, S2_PAGE_SIGNALS } from "./classify-core.mjs";
import { ITEM_ORIGINS, MESSAGE_KINDS } from "./delivery-core.mjs";
import { keysAreValid } from "./keys-schema-core.mjs";
import {
  REQUEST_BODY_MAX_BYTES,
  RUN_ID_PATTERN,
  UUID_PATTERN,
  parseRunDeadline,
} from "./request-schema-core.mjs";

/** The largest epoch millisecond a Date can hold. */
const MAX_DATE_MS = 8.64e15;

const BODY_KEYS = Object.freeze(["runDeadline", "runId", "baseGenesisId", "baseGeneration", "keys", "reservation"]);
const RESERVATION_KEYS = Object.freeze(["ownerDate", "channelCheck", "items"]);
const ITEM_KEYS = Object.freeze(["signal", "scope", "kind", "origin", "openedAt"]);

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const hasExactly = (value, keys) =>
  isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function isOwnerDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const refuse = (error) => ({ ok: false, error });

/**
 * The early check: whether an item could agree with the key state this same
 * request writes. It cannot see the previous state, so it is necessary, not
 * sufficient -- the store holds every item to owedMessage() over the current
 * and next keys before it reserves anything.
 */
function itemMatchesKey(signal, item, keyState, ownerDate) {
  if (item.openedAt !== keyState.openedAt) return false;
  if (item.kind === "recovery") return keyState.status === "closed" && keyState.recoveredAt !== null;
  if (keyState.status !== "open") return false;
  // A new open stamps today's owner date; a reopen keeps an earlier one or
  // follows a recovery inside the window.
  // A reopen always follows a recovery, so it carries a recovery time; a new
  // open has none, or one older than the reopen window.
  if (item.kind === "new_open") {
    return (
      item.origin === "new" &&
      keyState.newOpenOwnerDate === ownerDate &&
      (keyState.recoveredAt === null || keyState.openedAt - keyState.recoveredAt >= REOPEN_WINDOW_MS)
    );
  }
  if (item.kind === "reopen") return item.origin === "reopen" && keyState.recoveredAt !== null;
  // worsening: the key sits past its signal's first band.
  return signal.bands.indexOf(keyState.lastBand) > 0;
}

/**
 * The message one key's move from `prev` to `next` owes, by the rules
 * evaluateKey() applies (policy §1, §5), or null. `next` must be a state
 * evaluateKey() produced from `prev`; the store checks the reservation against
 * this, so the kind -- and with it whether the message is capped -- is derived,
 * never taken from the request.
 */
export function owedMessage(signal, prev, next, ownerDate) {
  if (prev.status === "closed" && next.status === "open") {
    const isReopen =
      prev.newOpenOwnerDate === ownerDate ||
      (prev.recoveredAt !== null && next.openedAt - prev.recoveredAt < REOPEN_WINDOW_MS);
    return isReopen ? "reopen" : "new_open";
  }
  if (prev.status === "open" && next.status === "open") {
    return signal.bands.indexOf(next.lastBand) > signal.bands.indexOf(prev.lastBand) ? "worsening" : null;
  }
  if (prev.status === "open" && next.status === "closed") return "recovery";
  return null;
}

/**
 * Every message the move from `previousKeys` to `nextKeys` owes, one per key at
 * most, as { signal, scope, kind, openedAt(ms) }.
 */
export function owedMessages(previousKeys, nextKeys, ownerDate) {
  const owed = [];
  for (const signal of S2_PAGE_SIGNALS) {
    for (const scope of signal.scopes) {
      const key = `${signal.id}#${scope}`;
      const kind = owedMessage(signal, previousKeys[key], nextKeys[key], ownerDate);
      if (kind) owed.push({ signal: signal.id, scope, kind, openedAt: nextKeys[key].openedAt });
    }
  }
  return owed;
}

/** Whether every reserved item is a message the move actually owes. */
export function reservationIsOwed(items, owed) {
  return items.every((item) =>
    owed.some(
      (o) => o.signal === item.signal && o.scope === item.scope && o.kind === item.kind && o.openedAt === item.openedAt.getTime(),
    ),
  );
}

function parseReservation(reservation, keys) {
  if (reservation === null) return { ok: true, value: null };
  if (!hasExactly(reservation, RESERVATION_KEYS)) return refuse("shape");
  const { ownerDate, channelCheck, items } = reservation;
  if (!isOwnerDate(ownerDate) || typeof channelCheck !== "boolean" || !Array.isArray(items)) return refuse("shape");
  // Something must be sent; one key's move owes one message, so one item per key.
  if (items.length > S2_PAGE_KEYS.length || (items.length === 0 && !channelCheck)) return refuse("reservation_invalid");
  const seen = new Set();
  const parsed = [];
  for (const item of items) {
    if (!hasExactly(item, ITEM_KEYS)) return refuse("shape");
    const { signal, scope, kind, origin, openedAt } = item;
    if (typeof signal !== "string" || typeof scope !== "string") return refuse("shape");
    if (!MESSAGE_KINDS.includes(kind) || !ITEM_ORIGINS.includes(origin)) return refuse("shape");
    if (!Number.isSafeInteger(openedAt) || openedAt < 0 || openedAt > MAX_DATE_MS) return refuse("shape");
    const key = `${signal}#${scope}`;
    if (!S2_PAGE_KEYS.includes(key)) return refuse("reservation_invalid");
    if (seen.has(key)) return refuse("reservation_invalid");
    seen.add(key);
    const signalDef = S2_PAGE_SIGNALS.find((s) => s.id === signal);
    if (!itemMatchesKey(signalDef, item, keys[key], ownerDate)) return refuse("reservation_invalid");
    parsed.push({ signal, scope, kind, origin, openedAt: new Date(openedAt) });
  }
  return { ok: true, value: { ownerDate, channelCheck, items: parsed } };
}

/**
 * Parses an advance body. Returns `{ ok: true, value }` or `{ ok: false, error }`
 * with one of `too_large`, `not_json`, `shape`, `deadline_invalid`,
 * `keys_invalid`, `reservation_invalid`.
 */
export function parseAdvanceRequest(bodyText, nowMs) {
  if (typeof bodyText !== "string" || Buffer.byteLength(bodyText, "utf8") > REQUEST_BODY_MAX_BYTES) {
    return refuse("too_large");
  }
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return refuse("not_json");
  }
  if (!hasExactly(body, BODY_KEYS)) return refuse("shape");
  const { runDeadline, runId, baseGenesisId, baseGeneration, keys, reservation } = body;
  const deadline = parseRunDeadline(runDeadline, nowMs);
  if (!deadline) return refuse("deadline_invalid");
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) return refuse("shape");
  if (typeof baseGenesisId !== "string" || !UUID_PATTERN.test(baseGenesisId)) return refuse("shape");
  if (!Number.isSafeInteger(baseGeneration) || baseGeneration < 0) return refuse("shape");
  if (!keysAreValid(keys)) return refuse("keys_invalid");
  const parsedReservation = parseReservation(reservation, keys);
  if (!parsedReservation.ok) return parsedReservation;
  return {
    ok: true,
    value: { runDeadline: deadline, runId, baseGenesisId, baseGeneration, keys, reservation: parsedReservation.value },
  };
}
