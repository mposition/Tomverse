// The sre-ops daily digest payload and request (docs/policy/sre-ops.md §1
// item 3, §9 N-4): built from what the run read, closed, bounded, and parsed
// back by the app before the shared store sees it.

import assert from "node:assert/strict";
import test from "node:test";

import {
  DIGEST_KIND,
  DIGEST_MAX_ENTRIES,
  buildDigestPayload,
  digestIdempotencyKey,
  parseDigestPayload,
  parseDigestRequest,
} from "../scripts/ops-observer/digest-schema-core.mjs";
import { AGENT_DIGEST_KINDS, AGENT_DIGEST_MAX_PAYLOAD_BYTES } from "../lib/agentDigestContract.ts";

const NOW = Date.parse("2026-10-07T21:00:00.000Z");
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
    channelCheckTaken: true,
  };
  assert.equal(parseDigestPayload(largest).ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify(largest)) < AGENT_DIGEST_MAX_PAYLOAD_BYTES / 4);
});

test("the request carries a deadline, its owner date and a payload for that date", () => {
  const body = { runDeadline: new Date(NOW + 60_000).toISOString(), ownerDate: DAY, payload: payload() };
  const parsed = parseDigestRequest(JSON.stringify(body), NOW);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value.runDeadline, new Date(NOW + 60_000));
  assert.deepEqual(parseDigestRequest(JSON.stringify({ ...body, ownerDate: "2026-10-06" }), NOW), { ok: false, error: "payload_shape" });
  assert.deepEqual(parseDigestRequest(JSON.stringify({ ...body, runDeadline: new Date(NOW - 1).toISOString() }), NOW),
    { ok: false, error: "deadline_invalid" });
  assert.deepEqual(parseDigestRequest(JSON.stringify({ ...body, extra: 1 }), NOW), { ok: false, error: "shape" });
  assert.deepEqual(parseDigestRequest("{", NOW), { ok: false, error: "not_json" });
  assert.deepEqual(parseDigestRequest("x".repeat(17_000), NOW), { ok: false, error: "too_large" });
});
