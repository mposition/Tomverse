// The sre-ops daily digest (docs/policy/sre-ops.md §1 item 3, §3 rule 7,
// §5, §8 S1b, §9 N-4): one closed payload per closed owner date, built by the
// app itself from what it reads -- the digest service only names the date --
// and held to this shape before the shared store keeps it.
//
// Payload, schema version 3:
//
//   { ownerDate, mode, readiness, items, counts, channelCheckTaken }
//
//   mode:      the head's mode when the digest was kept.
//   readiness: "unknown" or { checkName: boolean } -- the readiness checks
//              that are not page keys (digestReadinessNames), at most 20.
//   items:     the owner date's messages in BOTH modes, whichever genesis
//              made them: [{ key, kind, capped, mode, status }], status
//              "reserved" (a reservation; in shadow, would have paged) or
//              "deferred" (the daily cap held it back, §5). At most 20,
//              reserved first.
//   counts:    [{ mode, status, kind, count }] over ALL of the date's
//              messages, one row per non-zero combination -- so a list cut at
//              its cap still reports how many there were.
//
// Version 1 had a capped list of one genesis's reservations and no counts;
// version 2 added counts, over the head mode only. Both are still read back
// (parseStoredDigestPayload), upgraded to this shape.
//
// Names, booleans, enums and dates only: no error text, no counts a person
// produced, no URL. Every bound is fixed here, so a payload that parses is far
// under the shared 16 KiB limit, and the shared store's canonical form and
// secret scan still run on it.

import { S2_PAGE_KEYS } from "./classify-core.mjs";
import { MESSAGE_KINDS } from "./notification-budget-core.mjs";
import { REQUEST_BODY_MAX_BYTES, isOwnerDate, parseRunDeadline } from "./request-schema-core.mjs";
import { ownerDateIsFinal } from "./owner-date-core.mjs";

export const DIGEST_SCHEMA_VERSION = 3;
export const DIGEST_KIND = "daily_digest";
export const DIGEST_MAX_ENTRIES = 20;
/** No date can hold more: a bound for the counts, not a cap on messages. */
export const DIGEST_MAX_COUNT = 10_000;
export const DIGEST_ITEM_STATUSES = Object.freeze(["reserved", "deferred"]);
const MODES = Object.freeze(["shadow", "live"]);

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const hasExactly = (value, keys) =>
  isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const PAYLOAD_KEYS = Object.freeze(["ownerDate", "mode", "readiness", "items", "counts", "channelCheckTaken"]);
const ITEM_KEYS = Object.freeze(["key", "kind", "capped", "mode", "status"]);
const COUNT_KEYS = Object.freeze(["mode", "status", "kind", "count"]);
const LEGACY_ITEM_KEYS = Object.freeze(["key", "kind", "capped"]);
const PAYLOAD_KEYS_V2 = Object.freeze(["ownerDate", "mode", "readiness", "reserved", "reservedCounts", "channelCheckTaken"]);
const PAYLOAD_KEYS_V1 = Object.freeze(["ownerDate", "mode", "readiness", "reserved", "channelCheckTaken"]);
const REQUEST_KEYS = Object.freeze(["runDeadline", "ownerDate"]);

/** The shared table's idempotency key for one owner date's digest. */
export function digestIdempotencyKey(ownerDate) {
  return `sre-ops:daily:${ownerDate}`;
}

/** One count row per non-zero (mode, status, kind), in a fixed order. */
function countRows(items) {
  const rows = [];
  for (const mode of MODES) {
    for (const status of DIGEST_ITEM_STATUSES) {
      for (const kind of MESSAGE_KINDS) {
        const count = items.filter((i) => i.mode === mode && i.status === status && i.kind === kind).length;
        if (count > 0) rows.push({ mode, status, kind, count });
      }
    }
  }
  return rows;
}

/**
 * The payload from what the app read. `readiness` is the snapshot's readiness
 * (or "unknown"), `digestNames` the non-page check names, `items` every
 * message of the date ({ key, kind, capped, mode, status }), reserved first.
 */
export function buildDigestPayload({ ownerDate, mode, readiness, digestNames, items, channelCheckTaken }) {
  const checks =
    readiness === "unknown" || readiness === null || typeof readiness !== "object"
      ? "unknown"
      : Object.fromEntries(
          digestNames
            .filter((name) => typeof readiness[name] === "boolean")
            .slice(0, DIGEST_MAX_ENTRIES)
            .map((name) => [name, readiness[name]]),
        );
  const all = items.map((item) => ({
    key: item.key,
    kind: item.kind,
    capped: item.capped === true,
    mode: item.mode,
    status: item.status,
  }));
  return {
    ownerDate,
    mode,
    readiness: checks,
    items: all.slice(0, DIGEST_MAX_ENTRIES),
    counts: countRows(all),
    channelCheckTaken: channelCheckTaken === true,
  };
}

/** `{ ok: true, payload }` for a payload in the closed shape, else `{ ok: false, error }`. */
export function parseDigestPayload(value) {
  const refuse = (error) => ({ ok: false, error });
  if (!hasExactly(value, PAYLOAD_KEYS)) return refuse("payload_shape");
  const { ownerDate, mode, readiness, items, counts, channelCheckTaken } = value;
  if (!isOwnerDate(ownerDate)) return refuse("payload_shape");
  if (!MODES.includes(mode)) return refuse("payload_shape");
  if (typeof channelCheckTaken !== "boolean") return refuse("payload_shape");
  if (readiness !== "unknown") {
    if (!isPlainObject(readiness)) return refuse("payload_shape");
    const entries = Object.entries(readiness);
    if (entries.length > DIGEST_MAX_ENTRIES) return refuse("payload_shape");
    if (entries.some(([name, ok]) => !IDENTIFIER.test(name) || typeof ok !== "boolean")) return refuse("payload_shape");
  }
  if (!Array.isArray(items) || items.length > DIGEST_MAX_ENTRIES) return refuse("payload_shape");
  for (const item of items) {
    if (!hasExactly(item, ITEM_KEYS)) return refuse("payload_shape");
    if (!S2_PAGE_KEYS.includes(item.key) || !MESSAGE_KINDS.includes(item.kind) || typeof item.capped !== "boolean") {
      return refuse("payload_shape");
    }
    if (!MODES.includes(item.mode) || !DIGEST_ITEM_STATUSES.includes(item.status)) return refuse("payload_shape");
  }
  if (!Array.isArray(counts) || counts.length > MODES.length * DIGEST_ITEM_STATUSES.length * MESSAGE_KINDS.length) {
    return refuse("payload_shape");
  }
  const seen = new Set();
  for (const row of counts) {
    if (!hasExactly(row, COUNT_KEYS)) return refuse("payload_shape");
    if (!MODES.includes(row.mode) || !DIGEST_ITEM_STATUSES.includes(row.status) || !MESSAGE_KINDS.includes(row.kind)) {
      return refuse("payload_shape");
    }
    if (!Number.isSafeInteger(row.count) || row.count < 1 || row.count > DIGEST_MAX_COUNT) return refuse("payload_shape");
    const id = `${row.mode}:${row.status}:${row.kind}`;
    if (seen.has(id)) return refuse("payload_shape");
    seen.add(id);
  }
  // The list is the first items of the same messages the counts cover.
  for (const item of items) {
    const listed = items.filter((i) => i.mode === item.mode && i.status === item.status && i.kind === item.kind).length;
    const row = counts.find((r) => r.mode === item.mode && r.status === item.status && r.kind === item.kind);
    if (!row || listed > row.count) return refuse("payload_shape");
  }
  return { ok: true, payload: value };
}

/**
 * A kept digest read back under the schema version it was stored with:
 * `{ ok: true, payload, countsComplete }` or `{ ok: false, error }`, the
 * payload always in the version 3 shape. Versions 1 and 2 listed only the
 * head mode's reservations: their items take that mode and "reserved", and
 * `countsComplete` is false because neither recorded the other mode or what
 * the cap held back (version 1 also derived its counts from a list it may have
 * cut). Any other version is refused.
 */
export function parseStoredDigestPayload(value, schemaVersion) {
  if (schemaVersion === DIGEST_SCHEMA_VERSION) {
    const parsed = parseDigestPayload(value);
    return parsed.ok ? { ...parsed, countsComplete: true } : parsed;
  }
  const legacy =
    (schemaVersion === 1 && hasExactly(value, PAYLOAD_KEYS_V1)) ||
    (schemaVersion === 2 && hasExactly(value, PAYLOAD_KEYS_V2) && hasExactly(value.reservedCounts, MESSAGE_KINDS));
  if (!legacy || !Array.isArray(value.reserved) || !MODES.includes(value.mode)) {
    return { ok: false, error: "payload_shape" };
  }
  if (value.reserved.some((item) => !hasExactly(item, LEGACY_ITEM_KEYS))) return { ok: false, error: "payload_shape" };
  const items = value.reserved.map((item) => ({ ...item, mode: value.mode, status: "reserved" }));
  const counts =
    schemaVersion === 1
      ? countRows(items)
      : MESSAGE_KINDS.filter((kind) => value.reservedCounts[kind] !== 0).map((kind) => ({
          mode: value.mode,
          status: "reserved",
          kind,
          count: value.reservedCounts[kind],
        }));
  const parsed = parseDigestPayload({
    ownerDate: value.ownerDate,
    mode: value.mode,
    readiness: value.readiness,
    items,
    counts,
    channelCheckTaken: value.channelCheckTaken,
  });
  return parsed.ok ? { ...parsed, countsComplete: false } : parsed;
}

/**
 * Parses the digest route's body: `{ runDeadline, ownerDate }` -- the service
 * names the date; the app builds the payload itself from what it reads. The
 * date must be closed at `nowMs` (ownerDateIsFinal), so its reservations can
 * no longer change under the digest. `{ ok: true, value }` or
 * `{ ok: false, error }` with `too_large`, `not_json`, `shape`,
 * `deadline_invalid` or `date_not_final`.
 */
export function parseDigestRequest(bodyText, nowMs) {
  if (typeof bodyText !== "string" || Buffer.byteLength(bodyText, "utf8") > REQUEST_BODY_MAX_BYTES) {
    return { ok: false, error: "too_large" };
  }
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { ok: false, error: "not_json" };
  }
  if (!hasExactly(body, REQUEST_KEYS)) return { ok: false, error: "shape" };
  const runDeadline = parseRunDeadline(body.runDeadline, nowMs);
  if (!runDeadline) return { ok: false, error: "deadline_invalid" };
  if (!isOwnerDate(body.ownerDate)) return { ok: false, error: "shape" };
  if (!ownerDateIsFinal(body.ownerDate, nowMs)) return { ok: false, error: "date_not_final" };
  return { ok: true, value: { runDeadline, ownerDate: body.ownerDate } };
}
