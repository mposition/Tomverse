// The request bodies of the ops-observer internal routes that read state and
// close reservations (docs/policy/sre-ops.md §6, §3-3). Closed: an unknown
// key, a missing key or a value of the wrong shape is refused before any
// transaction opens, and so is a body over the size cap.
//
// Every request carries its run deadline. Here it must be an ISO instant ahead
// of the server clock and at most 180 s ahead -- the same bound the database
// claim check enforces on every row a run writes, so a request the database
// would refuse is refused before it costs a transaction. The database clock
// remains the one that decides (§6); this is the early, cheaper refusal.

import { RUN_DEADLINE_MS } from "./transaction-bounds-core.mjs";

/**
 * Request body cap: the same 16 KiB docs/policy/sre-ops.md §9 (decision N-4)
 * fixes for an agent digest item, so no request can carry more than the item
 * it may turn into.
 */
export const REQUEST_BODY_MAX_BYTES = 16 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The same pattern as OpsObserverDelivery_runId_check. */
const RUN_ID = /^[0-9a-z][0-9a-z:_-]{0,127}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const SHAPES = Object.freeze({
  // The owner date the run counts its daily budget under (policy §5): the
  // state answer carries that date's reservations, so the run can hold what
  // it reserves to the cap the advance will enforce.
  state: Object.freeze({ runDeadline: "deadline", ownerDate: "ownerDate" }),
  confirm: Object.freeze({ runDeadline: "deadline", deliveryId: "uuid", runId: "runId" }),
});

export { UUID as UUID_PATTERN, RUN_ID as RUN_ID_PATTERN };

/** A real calendar date as YYYY-MM-DD, or false. */
export function isOwnerDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const REQUEST_ROUTES = Object.freeze(Object.keys(SHAPES));

const refuse = (error) => ({ ok: false, error });

/** The run deadline of any request, or null: an ISO instant in (now, now + 180 s]. */
export function parseRunDeadline(value, nowMs) {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms <= nowMs || ms > nowMs + RUN_DEADLINE_MS) return null;
  // Date.parse rolls an impossible date over (02-30 becomes 03-02), so the
  // instant must print back as the same calendar date and time.
  const printed = new Date(ms).toISOString();
  if (printed.slice(0, 19) !== value.slice(0, 19)) return null;
  return new Date(ms);
}

/**
 * Parses a raw request body for `route`. Returns `{ ok: true, value }` with
 * `runDeadline` as a Date, or `{ ok: false, error }` with one of
 * `route_unknown`, `too_large`, `not_json`, `shape`, `deadline_invalid`.
 */
export function parseOpsObserverRequest(route, bodyText, nowMs) {
  if (!Object.hasOwn(SHAPES, route)) return refuse("route_unknown");
  if (typeof bodyText !== "string" || Buffer.byteLength(bodyText, "utf8") > REQUEST_BODY_MAX_BYTES) {
    return refuse("too_large");
  }
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return refuse("not_json");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype) {
    return refuse("shape");
  }
  const shape = SHAPES[route];
  const keys = Object.keys(body);
  if (keys.length !== Object.keys(shape).length || !keys.every((key) => Object.hasOwn(shape, key))) {
    return refuse("shape");
  }

  const value = {};
  for (const [key, kind] of Object.entries(shape)) {
    const raw = body[key];
    if (kind === "deadline") {
      const parsed = parseRunDeadline(raw, nowMs);
      if (!parsed) return refuse("deadline_invalid");
      value[key] = parsed;
    } else if (kind === "uuid") {
      if (typeof raw !== "string" || !UUID.test(raw)) return refuse("shape");
      value[key] = raw;
    } else if (kind === "runId") {
      if (typeof raw !== "string" || !RUN_ID.test(raw)) return refuse("shape");
      value[key] = raw;
    } else if (kind === "ownerDate") {
      if (!isOwnerDate(raw)) return refuse("shape");
      value[key] = raw;
    }
  }
  return { ok: true, value };
}
