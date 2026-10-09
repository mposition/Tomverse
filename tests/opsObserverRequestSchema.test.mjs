// The state and confirm request bodies: closed keys, the size cap, a run
// deadline ahead of the clock and at most 180 s out, the state read's owner
// date as a real calendar date, and confirm's ids in the shapes the database
// checks.

import assert from "node:assert/strict";
import test from "node:test";

import {
  REQUEST_BODY_MAX_BYTES,
  parseOpsObserverRequest,
} from "../scripts/ops-observer/request-schema-core.mjs";

const NOW = Date.parse("2026-10-04T01:00:00.000Z");
const at = (ms) => new Date(NOW + ms).toISOString();
const DELIVERY = "11111111-1111-4111-8111-111111111111";
const DAY = "2026-10-04";
const parse = (route, body) => parseOpsObserverRequest(route, typeof body === "string" ? body : JSON.stringify(body), NOW);

test("well-formed bodies parse, with the deadline as a Date", () => {
  assert.deepEqual(parse("state", { runDeadline: at(60_000), ownerDate: DAY }), {
    ok: true,
    value: { runDeadline: new Date(NOW + 60_000), ownerDate: DAY },
  });
  assert.deepEqual(parse("confirm", { runDeadline: at(180_000), deliveryId: DELIVERY, runId: "run:2026-10-04_01" }), {
    ok: true,
    value: { runDeadline: new Date(NOW + 180_000), deliveryId: DELIVERY, runId: "run:2026-10-04_01" },
  });
});

test("the deadline must be an instant ahead of now and at most 180 s out", () => {
  for (const runDeadline of [
    at(0),
    at(-1),
    at(180_001),
    "2026-10-04T01:01:00+00:00",
    "2026-10-04T01:01:00",
    "2026-10-04",
    "2026-02-30T01:01:00Z",
    Date.now(),
    null,
  ]) {
    assert.deepEqual(parse("state", { runDeadline, ownerDate: DAY }), { ok: false, error: "deadline_invalid" }, String(runDeadline));
  }
});

test("an impossible date that would roll into the window is refused", () => {
  // 2026-02-30T01:01Z rolls to 2026-03-02T01:01Z, which is inside the window here.
  const now = Date.parse("2026-03-02T01:00:00.000Z");
  assert.deepEqual(parseOpsObserverRequest("state", JSON.stringify({ runDeadline: "2026-02-30T01:01:00Z", ownerDate: DAY }), now), {
    ok: false,
    error: "deadline_invalid",
  });
  assert.equal(parseOpsObserverRequest("state", JSON.stringify({ runDeadline: "2026-03-02T01:01:00Z", ownerDate: DAY }), now).ok, true);
  assert.equal(parseOpsObserverRequest("state", JSON.stringify({ runDeadline: "2026-03-02T01:00:61Z", ownerDate: DAY }), now).ok, false);
});

test("keys are closed and confirm's ids keep the database's shapes", () => {
  for (const body of [
    {},
    { runDeadline: at(60_000), extra: 1 },
    { runDeadline: at(60_000), deliveryId: DELIVERY },
    { runDeadline: at(60_000), deliveryId: "AAAAAAAA-1111-4111-8111-111111111111", runId: "r1" },
    { runDeadline: at(60_000), deliveryId: DELIVERY, runId: "R1" },
    { runDeadline: at(60_000), deliveryId: DELIVERY, runId: "-r1" },
    { runDeadline: at(60_000), deliveryId: DELIVERY, runId: "r".repeat(129) },
    { runDeadline: at(60_000), deliveryId: DELIVERY, runId: 7 },
  ]) {
    assert.equal(parse("confirm", body).ok, false, JSON.stringify(body));
  }
  assert.deepEqual(parse("state", { runDeadline: at(60_000), ownerDate: DAY, status: "confirmed" }), { ok: false, error: "shape" });
  // The owner date is required and must be a real calendar date.
  for (const ownerDate of [undefined, null, "2026-02-30", "2026-10-4", "20261004", "2026-10-04T00:00:00Z", 20261004]) {
    assert.deepEqual(parse("state", { runDeadline: at(60_000), ownerDate }), { ok: false, error: "shape" }, String(ownerDate));
  }
});

test("anything but a plain JSON object under the cap is refused", () => {
  assert.deepEqual(parse("state", "not json"), { ok: false, error: "not_json" });
  for (const body of ["[]", "null", "\"x\"", "1"]) assert.deepEqual(parse("state", body), { ok: false, error: "shape" });
  const big = JSON.stringify({ runDeadline: at(60_000), pad: "x".repeat(REQUEST_BODY_MAX_BYTES) });
  assert.deepEqual(parse("state", big), { ok: false, error: "too_large" });
  // Counted in bytes, not characters.
  const multibyte = `{"runDeadline":"${at(60_000)}","x":"${"한".repeat(6000)}"}`;
  assert.ok(multibyte.length < REQUEST_BODY_MAX_BYTES);
  assert.deepEqual(parse("state", multibyte), { ok: false, error: "too_large" });
  assert.deepEqual(parseOpsObserverRequest("state", undefined, NOW), { ok: false, error: "too_large" });
});

test("advance and unknown routes are not parsed here", () => {
  for (const route of ["advance", "genesis", "__proto__", ""]) {
    assert.deepEqual(parse(route, { runDeadline: at(60_000) }), { ok: false, error: "route_unknown" }, route);
  }
});
