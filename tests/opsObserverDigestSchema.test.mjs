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
  parseStoredDigestPayload,
} from "../scripts/ops-observer/digest-schema-core.mjs";
import { AGENT_DIGEST_KINDS, AGENT_DIGEST_MAX_PAYLOAD_BYTES } from "../lib/agentDigestContract.ts";

const DAY = "2026-10-07";
const KEY = "P3#credit_reservation_reconciliation";
const items = [
  { key: KEY, kind: "new_open", capped: false, mode: "shadow", status: "reserved" },
  { key: KEY, kind: "recovery", capped: true, mode: "shadow", status: "deferred" },
  { key: KEY, kind: "reopen", capped: true, mode: "live", status: "reserved" },
];
const payload = () =>
  buildDigestPayload({
    ownerDate: DAY,
    mode: "live",
    readiness: { database: true, imageProviderBudget: false, emailUnsubscribeKeyring: true, unknownCheck: "x" },
    digestNames: ["emailUnsubscribeKeyring", "imageProviderBudget", "unknownCheck"],
    items,
    channelCheckTaken: false,
  });

test("the kind and key are the shared contract's for sre-ops", () => {
  assert.deepEqual(AGENT_DIGEST_KINDS["sre-ops"], [DIGEST_KIND]);
  assert.equal(digestIdempotencyKey(DAY), "sre-ops:daily:2026-10-07");
});

test("a built payload holds the non-page checks and every message of the date, both modes and statuses", () => {
  const built = payload();
  assert.deepEqual(built, {
    ownerDate: DAY,
    mode: "live",
    readiness: { emailUnsubscribeKeyring: true, imageProviderBudget: false },
    items,
    counts: [
      { mode: "shadow", status: "reserved", kind: "new_open", count: 1 },
      { mode: "shadow", status: "deferred", kind: "recovery", count: 1 },
      { mode: "live", status: "reserved", kind: "reopen", count: 1 },
    ],
    channelCheckTaken: false,
  });
  assert.deepEqual(parseDigestPayload(built), { ok: true, payload: built });
  assert.equal(
    buildDigestPayload({ ownerDate: DAY, mode: "shadow", readiness: "unknown", digestNames: [], items: [], channelCheckTaken: true }).readiness,
    "unknown",
  );
});

test("anything outside the closed shape is refused", () => {
  const good = payload();
  const row = good.counts[0];
  for (const bad of [
    { ...good, extra: 1 },
    { ...good, ownerDate: "2026-02-30" },
    { ...good, mode: "paused" },
    { ...good, channelCheckTaken: "no" },
    { ...good, readiness: { "bad name": true } },
    { ...good, readiness: { database: "yes" } },
    { ...good, items: [{ ...items[0], key: "P9#unknown" }] },
    { ...good, items: [{ ...items[0], kind: "page" }] },
    { ...good, items: [{ ...items[0], mode: "paused" }] },
    { ...good, items: [{ ...items[0], status: "sent" }] },
    { ...good, items: [{ ...items[0], note: "x" }] },
    { ...good, items: Array.from({ length: DIGEST_MAX_ENTRIES + 1 }, () => items[0]) },
    { ...good, readiness: Object.fromEntries(Array.from({ length: DIGEST_MAX_ENTRIES + 1 }, (_, i) => [`c${i}`, true])) },
    // Counts: whole, positive, one row per combination, and never fewer than the list holds.
    { ...good, counts: [{ ...row, count: 0 }, ...good.counts.slice(1)] },
    { ...good, counts: [{ ...row, count: 1.5 }, ...good.counts.slice(1)] },
    { ...good, counts: [{ ...row, count: DIGEST_MAX_COUNT + 1 }, ...good.counts.slice(1)] },
    { ...good, counts: [...good.counts, row] },
    { ...good, counts: [{ ...row, status: "sent" }, ...good.counts.slice(1)] },
    { ...good, counts: [{ ...row, extra: 1 }, ...good.counts.slice(1)] },
    { ...good, counts: good.counts.slice(1) },
  ]) {
    assert.deepEqual(parseDigestPayload(bad), { ok: false, error: "payload_shape" }, JSON.stringify(bad).slice(0, 120));
  }
});

test("the largest payload the shape allows is far under the shared 16 KiB limit", () => {
  const counts = [];
  for (const mode of ["shadow", "live"]) {
    for (const status of ["reserved", "deferred"]) {
      for (const kind of ["new_open", "worsening", "reopen", "recovery"]) counts.push({ mode, status, kind, count: DIGEST_MAX_COUNT });
    }
  }
  const largest = {
    ownerDate: DAY,
    mode: "shadow",
    readiness: Object.fromEntries(Array.from({ length: DIGEST_MAX_ENTRIES }, (_, i) => [`c${"x".repeat(60)}${i}`, true])),
    items: Array.from({ length: DIGEST_MAX_ENTRIES }, () => ({ key: KEY, kind: "worsening", capped: true, mode: "shadow", status: "deferred" })),
    counts,
    channelCheckTaken: true,
  };
  assert.equal(parseDigestPayload(largest).ok, true);
  // Version 3 carries both modes and statuses; still half the shared limit at most.
  assert.ok(Buffer.byteLength(JSON.stringify(largest)) < AGENT_DIGEST_MAX_PAYLOAD_BYTES / 2);
});

test("a date with more messages than the list holds keeps the first twenty and counts them all", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    key: KEY, kind: i % 3 === 0 ? "worsening" : "new_open", capped: i % 2 === 0, mode: "shadow",
    status: i < 25 ? "reserved" : "deferred" }));
  const built = buildDigestPayload({ ownerDate: DAY, mode: "shadow", readiness: "unknown", digestNames: [], items: many,
    channelCheckTaken: true });
  assert.equal(built.items.length, DIGEST_MAX_ENTRIES);
  assert.deepEqual(built.items, many.slice(0, DIGEST_MAX_ENTRIES));
  assert.equal(built.counts.reduce((sum, r) => sum + r.count, 0), 30);
  assert.equal(parseDigestPayload(built).ok, true);
});

test("a kept body reads back under the version it was stored with, upgraded to the current shape", () => {
  const v3 = payload();
  assert.deepEqual(parseStoredDigestPayload(v3, 3), { ok: true, payload: v3, countsComplete: true });
  const v1 = { ownerDate: DAY, mode: "shadow", readiness: "unknown",
    reserved: [{ key: KEY, kind: "new_open", capped: false }], channelCheckTaken: false };
  const upgradedItems = [{ key: KEY, kind: "new_open", capped: false, mode: "shadow", status: "reserved" }];
  assert.deepEqual(parseStoredDigestPayload(v1, 1), { ok: true, countsComplete: false, payload: {
    ownerDate: DAY, mode: "shadow", readiness: "unknown", items: upgradedItems,
    counts: [{ mode: "shadow", status: "reserved", kind: "new_open", count: 1 }], channelCheckTaken: false } });
  const v2 = { ...v1, reservedCounts: { new_open: 4, worsening: 0, reopen: 0, recovery: 0 } };
  assert.deepEqual(parseStoredDigestPayload(v2, 2).payload.counts, [{ mode: "shadow", status: "reserved", kind: "new_open", count: 4 }]);
  assert.equal(parseStoredDigestPayload(v2, 2).countsComplete, false);
  // Each version holds its own shape only, and no other version is read.
  assert.equal(parseStoredDigestPayload(v1, 2).ok, false);
  assert.equal(parseStoredDigestPayload(v2, 1).ok, false);
  assert.equal(parseStoredDigestPayload(v2, 3).ok, false);
  assert.equal(parseStoredDigestPayload(v3, 2).ok, false);
  assert.equal(parseStoredDigestPayload({ ...v2, reservedCounts: { new_open: 0, worsening: 0, reopen: 0, recovery: 0 } }, 2).ok, false);
  assert.equal(parseStoredDigestPayload(v3, 4).ok, false);
  assert.equal(parseStoredDigestPayload(null, 1).ok, false);
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
