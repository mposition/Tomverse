import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { runAmuxV4LocalRetentionOnce } from
  "../lib/amux/ideaLocalRetentionTrigger.mjs";

const origin = "https://staging.tomverse.test/";
const secret = "synthetic-retention-secret-0123456789";
const completed = {
  holdNotices: { sent: 0, scanned: 0, batchLimit: 8 },
  cancellation: { cancelled: 0, scanned: 0, batchLimit: 8 },
  raw: { bodiesPurged: 0, keysDeleted: 0, scanned: 0, batchLimit: 8 },
  analysis: { bodiesPurged: 0, keysDeleted: 0, scanned: 0, batchLimit: 8 },
};

function marker() {
  let marked = false;
  return {
    async claim() {
      if (marked) return false;
      marked = true;
      return true;
    },
    async release() { marked = false; },
    isMarked: () => marked,
  };
}

test("retention refuses an invalid origin before acquiring a marker", async () => {
  const state = marker();
  const result = await runAmuxV4LocalRetentionOnce({ origin: "http://example.test/",
    secret, ...state, fetchImpl: () => { throw new Error("network reached"); } });
  assert.deepEqual(result, { kind: "refused" });
  assert.equal(state.isMarked(), false);
});

test("one verified retention response clears the marker", async () => {
  const state = marker();
  let calls = 0;
  const result = await runAmuxV4LocalRetentionOnce({ origin, secret,
    ...state, fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(state.isMarked(), true);
      assert.equal(url, `${origin}api/internal/amux/v4/content-retention`);
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "manual");
      assert.equal(options.headers.authorization, `Bearer ${secret}`);
      return Response.json(completed);
    } });
  assert.deepEqual(result, { kind: "completed" });
  assert.equal(calls, 1);
  assert.equal(state.isMarked(), false);
});

test("a known disabled response clears the marker without a cleanup claim", async () => {
  const state = marker();
  const result = await runAmuxV4LocalRetentionOnce({ origin, secret, ...state,
    fetchImpl: async () => Response.json({ available: false,
      reason: "content_retention_disabled" }, { status: 409 }) });
  assert.deepEqual(result, { kind: "disabled" });
  assert.equal(state.isMarked(), false);
});

test("unknown response halts the next timer tick before another HTTP request", async () => {
  const state = marker();
  let calls = 0;
  const input = { origin, secret, ...state,
    fetchImpl: async () => { calls += 1; return Response.json({ retry: false },
      { status: 503 }); } };
  assert.deepEqual(await runAmuxV4LocalRetentionOnce(input), { kind: "halted" });
  assert.equal(state.isMarked(), true);
  assert.deepEqual(await runAmuxV4LocalRetentionOnce(input), { kind: "halted" });
  assert.equal(calls, 1);
});

test("invalid success body and redirect both keep the halt marker", async () => {
  for (const fetchImpl of [
    async () => Response.json({ ...completed, raw: { scanned: 0 } }),
    async () => ({ ...Response.json(completed),
      url: "https://other.example.test/", headers: new Headers({
        "content-type": "application/json" }) }),
  ]) {
    const state = marker();
    assert.deepEqual(await runAmuxV4LocalRetentionOnce({ origin, secret,
      ...state, fetchImpl }), { kind: "halted" });
    assert.equal(state.isMarked(), true);
  }
});

test("retention timer has no automatic retry after a failed tick", () => {
  const service = readFileSync(new URL("../scripts/systemd/amux-v4-content-retention.service",
    import.meta.url), "utf8");
  const timer = readFileSync(new URL("../scripts/systemd/amux-v4-content-retention.timer",
    import.meta.url), "utf8");
  assert.match(service, /TimeoutStartSec=650s/);
  assert.match(service, /ReadWritePaths=%h\/\.local\/state\/tomverse-amux-v4-content-retention/);
  assert.doesNotMatch(service, /^Restart=/m);
  assert.match(timer, /OnUnitInactiveSec=1h/);
  assert.match(timer, /Persistent=false/);
});
