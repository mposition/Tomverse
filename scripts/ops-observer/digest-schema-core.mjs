// The sre-ops daily digest (docs/policy/sre-ops.md §1 item 3, §3 rule 7,
// §8 S1b, §9 N-4): one closed payload per closed owner date, built by the app
// itself from what it reads -- the digest service only names the date -- and
// held to this shape before the shared store keeps it.
//
// Payload, schema version 1:
//
//   { ownerDate, mode, readiness, reserved, channelCheckTaken }
//
//   readiness: "unknown" or { checkName: boolean } -- the readiness checks
//              that are not page keys (digestReadinessNames), at most 20.
//   reserved:  the owner date's reservation items as the cap counted them,
//              [{ key, kind, capped }], at most 20 -- in shadow, the
//              would-have-paged list and, by kind, its expected counts.
//
// Names, booleans, enums and dates only: no error text, no counts a person
// produced, no URL. Every bound is fixed here, so a payload that parses is far
// under the shared 16 KiB limit, and the shared store's canonical form and
// secret scan still run on it.

import { S2_PAGE_KEYS } from "./classify-core.mjs";
import { MESSAGE_KINDS } from "./notification-budget-core.mjs";
import { REQUEST_BODY_MAX_BYTES, isOwnerDate, parseRunDeadline } from "./request-schema-core.mjs";
import { ownerDateIsFinal } from "./owner-date-core.mjs";

export const DIGEST_SCHEMA_VERSION = 1;
export const DIGEST_KIND = "daily_digest";
export const DIGEST_MAX_ENTRIES = 20;

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const hasExactly = (value, keys) =>
  isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const PAYLOAD_KEYS = Object.freeze(["ownerDate", "mode", "readiness", "reserved", "channelCheckTaken"]);
const RESERVED_KEYS = Object.freeze(["key", "kind", "capped"]);
const REQUEST_KEYS = Object.freeze(["runDeadline", "ownerDate"]);

/** The shared table's idempotency key for one owner date's digest. */
export function digestIdempotencyKey(ownerDate) {
  return `sre-ops:daily:${ownerDate}`;
}

/**
 * The payload from what the run read. `readiness` is the snapshot's readiness
 * (or "unknown"), `digestNames` the non-page check names, `budget` the
 * state's budget for the owner date.
 */
export function buildDigestPayload({ ownerDate, mode, readiness, digestNames, budget }) {
  const checks =
    readiness === "unknown" || readiness === null || typeof readiness !== "object"
      ? "unknown"
      : Object.fromEntries(
          digestNames
            .filter((name) => typeof readiness[name] === "boolean")
            .slice(0, DIGEST_MAX_ENTRIES)
            .map((name) => [name, readiness[name]]),
        );
  return {
    ownerDate,
    mode,
    readiness: checks,
    reserved: budget.reservedToday
      .slice(0, DIGEST_MAX_ENTRIES)
      .map((item) => ({ key: item.key, kind: item.kind, capped: item.capped === true })),
    channelCheckTaken: budget.channelCheckTaken === true,
  };
}

/** `{ ok: true, payload }` for a payload in the closed shape, else `{ ok: false, error }`. */
export function parseDigestPayload(value) {
  const refuse = (error) => ({ ok: false, error });
  if (!hasExactly(value, PAYLOAD_KEYS)) return refuse("payload_shape");
  const { ownerDate, mode, readiness, reserved, channelCheckTaken } = value;
  if (!isOwnerDate(ownerDate)) return refuse("payload_shape");
  if (mode !== "shadow" && mode !== "live") return refuse("payload_shape");
  if (typeof channelCheckTaken !== "boolean") return refuse("payload_shape");
  if (readiness !== "unknown") {
    if (!isPlainObject(readiness)) return refuse("payload_shape");
    const entries = Object.entries(readiness);
    if (entries.length > DIGEST_MAX_ENTRIES) return refuse("payload_shape");
    if (entries.some(([name, ok]) => !IDENTIFIER.test(name) || typeof ok !== "boolean")) return refuse("payload_shape");
  }
  if (!Array.isArray(reserved) || reserved.length > DIGEST_MAX_ENTRIES) return refuse("payload_shape");
  for (const item of reserved) {
    if (!hasExactly(item, RESERVED_KEYS)) return refuse("payload_shape");
    if (!S2_PAGE_KEYS.includes(item.key) || !MESSAGE_KINDS.includes(item.kind) || typeof item.capped !== "boolean") {
      return refuse("payload_shape");
    }
  }
  return { ok: true, payload: value };
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
