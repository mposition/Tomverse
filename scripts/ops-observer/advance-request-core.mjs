// The request body of the ops-observer advance route (docs/policy/sre-ops.md
// §3-3, §3-9, §5, §6): the run's next key states and, at most, one
// reservation. Closed, and checked against itself before any transaction
// opens:
//
//   { runDeadline, runId, baseGenesisId, baseGeneration, keys, reservation }
//   reservation: null | { ownerDate, channelCheck, items: [{ signal, scope,
//                kind, origin, openedAt }] }
//
// The request does not say whether an item counts against the daily cap: the
// store derives that from the kind and the day's earlier reservations (§5),
// so a caller cannot exempt a message by labelling it. Each item must name a
// page key and agree with the key state the same request writes -- the same
// incident open time, an open key for an open/reopen/worsening message and a
// closed, recovered key for a recovery -- so a request cannot reserve a
// message for an incident its own keys do not describe.

import { S2_PAGE_KEYS } from "./classify-core.mjs";
import { ITEM_ORIGINS, MESSAGE_KINDS } from "./delivery-core.mjs";
import { keysAreValid } from "./keys-schema-core.mjs";
import {
  REQUEST_BODY_MAX_BYTES,
  RUN_ID_PATTERN,
  UUID_PATTERN,
  parseRunDeadline,
} from "./request-schema-core.mjs";

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

/** Whether an item agrees with the key state this same request writes. */
function itemMatchesKey(item, keyState) {
  if (item.openedAt !== keyState.openedAt) return false;
  if (item.kind === "recovery") return keyState.status === "closed" && keyState.recoveredAt !== null;
  if (keyState.status !== "open") return false;
  if (item.kind === "new_open") return item.origin === "new";
  if (item.kind === "reopen") return item.origin === "reopen";
  return true; // worsening, of an incident that began either way
}

function parseReservation(reservation, keys) {
  if (reservation === null) return { ok: true, value: null };
  if (!hasExactly(reservation, RESERVATION_KEYS)) return refuse("shape");
  const { ownerDate, channelCheck, items } = reservation;
  if (!isOwnerDate(ownerDate) || typeof channelCheck !== "boolean" || !Array.isArray(items)) return refuse("shape");
  // Something must be sent; one item per key and kind; never more items than keys.
  if (items.length > S2_PAGE_KEYS.length || (items.length === 0 && !channelCheck)) return refuse("reservation_invalid");
  const seen = new Set();
  const parsed = [];
  for (const item of items) {
    if (!hasExactly(item, ITEM_KEYS)) return refuse("shape");
    const { signal, scope, kind, origin, openedAt } = item;
    if (typeof signal !== "string" || typeof scope !== "string") return refuse("shape");
    if (!MESSAGE_KINDS.includes(kind) || !ITEM_ORIGINS.includes(origin)) return refuse("shape");
    if (!Number.isSafeInteger(openedAt) || openedAt < 0) return refuse("shape");
    const key = `${signal}#${scope}`;
    if (!S2_PAGE_KEYS.includes(key)) return refuse("reservation_invalid");
    if (seen.has(`${key}|${kind}`)) return refuse("reservation_invalid");
    seen.add(`${key}|${kind}`);
    if (!itemMatchesKey(item, keys[key])) return refuse("reservation_invalid");
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
