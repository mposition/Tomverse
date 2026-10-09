// The sre-ops daily digest payload and request (docs/policy/sre-ops.md §1
// item 3, §9 N-4): the payload built by the app from its own reads, closed and
// bounded; the request only a deadline and a closed owner date.

import assert from "node:assert/strict";
import test from "node:test";

import {
  DIGEST_KIND,
  DIGEST_MAX_COUNT,
  DIGEST_MAX_ENTRIES,
  buildDigestPayload,
  digestIdempotencyKey,
  parseDigestPayload,
  parseDigestRequest,
} from "../scripts/ops-observer/digest-schema-core.mjs";
import { AGENT_DIGEST_KINDS, AGENT_DIGEST_MAX_PAYLOAD_BYTES } from "../lib/agentDigestContract.ts";

const DAY = "2026-10-07";
const budget = {
  reservedToday: [
    { key: "P3#credit_reservation_reconciliation", kind: "new_open", capped: false },
    { key: "P3#credit_reservation_reconciliation", kind: "recovery", capped: true },
  ],
  channelCheckTaken: false,
};
const payload = () =>
  buildDigestPayload({
    ownerDate: DAY,
    mode: "shadow",
    readiness: { database: true, imageProviderBudget: false, emailUnsubscribeKeyring: true, unknownCheck: "x" },
    digestNames: ["emailUnsubscribeKeyring", "imageProviderBudget", "unknownCheck"],
    budget,
  });

test("the kind and key are the shared contract's for sre-ops", () => {
  assert.deepEqual(AGENT_DIGEST_KINDS["sre-ops"], [DIGEST_KIND]);
  assert.equal(digestIdempotencyKey(DAY), "sre-ops:daily:2026-10-07");
});

test("a built payload holds only the non-page checks and the reserved items, and parses back", () => {
  const built = payload();
  assert.deepEqual(built, {
    ownerDate: DAY,
    mode: "shadow",
    readiness: { emailUnsubscribeKeyring: true, imageProviderBudget: false },
    reserved: budget.reservedToday,
    reservedCounts: { new_open: 1, worsening: 0, reopen: 0, recovery: 1 },
    channelCheckTaken: false,
  });
  assert.deepEqual(parseDigestPayload(built), { ok: true, payload: built });
  assert.equal(buildDigestPayload({ ownerDate: DAY, mode: "live", readiness: "unknown", digestNames: [], budget }).readiness, "unknown");
});

test("anything outside the closed shape is refused", () => {
  const good = payload();
  for (const bad of [
    { ...good, extra: 1 },
    { ...good, ownerDate: "2026-02-30" },
    { ...good, mode: "paused" },
    { ...good, channelCheckTaken: "no" },
    { ...good, readiness: { "bad name": true } },
    { ...good, readiness: { database: "yes" } },
    { ...good, reserved: [{ key: "P9#unknown", kind: "new_open", capped: false }] },
    { ...good, reserved: [{ key: "P1a#database", kind: "page", capped: false }] },
    { ...good, reserved: [{ key: "P1a#database", kind: "reopen", capped: true, note: "x" }] },
    { ...good, reserved: Array.from({ length: DIGEST_MAX_ENTRIES + 1 }, () => good.reserved[0]) },
    { ...good, readiness: Object.fromEntries(Array.from({ length: DIGEST_MAX_ENTRIES + 1 }, (_, i) => [`c${i}`, true])) },
    // Counts: every kind, whole numbers, and never fewer than the list holds.
    { ...good, reservedCounts: { new_open: 1, worsening: 0, reopen: 0 } },
    { ...good, reservedCounts: { ...good.reservedCounts, page: 0 } },
    { ...good, reservedCounts: { ...good.reservedCounts, worsening: -1 } },
    { ...good, reservedCounts: { ...good.reservedCounts, worsening: 1.5 } },
    { ...good, reservedCounts: { ...good.reservedCounts, worsening: "2" } },
    { ...good, reservedCounts: { ...good.reservedCounts, new_open: 0 } },
    { ...good, reservedCounts: { ...good.reservedCounts, worsening: DIGEST_MAX_COUNT + 1 } },
  ]) {
    assert.deepEqual(parseDigestPayload(bad), { ok: false, error: "payload_shape" }, JSON.stringify(bad).slice(0, 80));
  }
});

test("the largest payload the shape allows is far under the shared 16 KiB limit", () => {
  const largest = {
    ownerDate: DAY,
    mode: "shadow",
    readiness: Object.fromEntries(Array.from({ length: DIGEST_MAX_ENTRIES }, (_, i) => [`c${"x".repeat(60)}${i}`, true])),
    reserved: Array.from({ length: DIGEST_MAX_ENTRIES }, () => ({
      key: "P3#credit_reservation_reconciliation", kind: "worsening", capped: true })),
    reservedCounts: { new_open: DIGEST_MAX_COUNT, worsening: DIGEST_MAX_COUNT, reopen: DIGEST_MAX_COUNT, recovery: DIGEST_MAX_COUNT },
    channelCheckTaken: true,
  };
  assert.equal(parseDigestPayload(largest).ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify(largest)) < AGENT_DIGEST_MAX_PAYLOAD_BYTES / 4);
});

test("a date with more items than the list holds keeps the first twenty and counts them all", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    key: "P3#credit_reservation_reconciliation", kind: i % 3 === 0 ? "worsening" : "new_open", capped: i % 2 === 0 }));
  const built = buildDigestPayload({ ownerDate: DAY, mode: "shadow", readiness: "unknown", digestNames: [],
    budget: { reservedToday: many, channelCheckTaken: true } });
  assert.equal(built.reserved.length, DIGEST_MAX_ENTRIES);
  assert.deepEqual(built.reserved, many.slice(0, DIGEST_MAX_ENTRIES));
  assert.deepEqual(built.reservedCounts, { new_open: 20, worsening: 10, reopen: 0, recovery: 0 });
  assert.equal(Object.values(built.reservedCounts).reduce((a, b) => a + b, 0), 30);
  assert.equal(parseDigestPayload(built).ok, true);
});

test("the request names a deadline and a closed owner date, and nothing else", () => {
  // 2026-10-07 in Brisbane ends at 2026-10-07T14:00Z; it is final 390 s later.
  const end = Date.parse("2026-10-07T14:00:00.000Z");
  const at = end + 390_000;
  const body = { runDeadline: new Date(at + 60_000).toISOString(), ownerDate: DAY };
  const parsed = parseDigestRequest(JSON.stringify(body), at);
  assert.deepEqual(parsed, { ok: true, value: { runDeadline: new Date(at + 60_000), ownerDate: DAY } });
  // Not yet closed: a late page run may still reserve under it.
  const early = end + 389_000;
  assert.deepEqual(parseDigestRequest(JSON.stringify({ ...body, runDeadline: new Date(early + 60_000).toISOString() }), early),
    { ok: false, error: "date_not_final" });
  // The service sends no payload: the app builds it.
  assert.deepEqual(parseDigestRequest(JSON.stringify({ ...body, payload: payload() }), at), { ok: false, error: "shape" });
  assert.deepEqual(parseDigestRequest(JSON.stringify({ ...body, ownerDate: "2026-02-30" }), at), { ok: false, error: "shape" });
  assert.deepEqual(parseDigestRequest(JSON.stringify({ ...body, runDeadline: new Date(at - 1).toISOString() }), at),
    { ok: false, error: "deadline_invalid" });
  assert.deepEqual(parseDigestRequest("{", at), { ok: false, error: "not_json" });
  assert.deepEqual(parseDigestRequest("x".repeat(17_000), at), { ok: false, error: "too_large" });
});
