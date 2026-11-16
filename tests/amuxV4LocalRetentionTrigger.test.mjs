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
  taskResults: { available: false, reason: "v22_task_result_retention_disabled" },
  readManifests: { available: false, reason: "v19_read_manifest_retention_disabled" },
  sessionResults: { available: false,
    reason: "v19_session_result_retention_disabled" },
};

test("retention refuses an invalid origin before any request", async () => {
  const result = await runAmuxV4LocalRetentionOnce({ origin: "http://example.test/",
    secret, fetchImpl: () => { throw new Error("network reached"); } });
  assert.deepEqual(result, { kind: "refused" });
});

test("one verified retention response completes the tick", async () => {
  let calls = 0;
  const result = await runAmuxV4LocalRetentionOnce({ origin, secret,
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, `${origin}api/internal/amux/v4/content-retention`);
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "manual");
      assert.equal(options.headers.authorization, `Bearer ${secret}`);
      return Response.json(completed);
    } });
  assert.deepEqual(result, { kind: "completed" });
  assert.equal(calls, 1);
});

test("a known disabled response is reported as disabled", async () => {
  const result = await runAmuxV4LocalRetentionOnce({ origin, secret,
    fetchImpl: async () => Response.json({ available: false,
      reason: "content_retention_disabled" }, { status: 409 }) });
  assert.deepEqual(result, { kind: "disabled" });
});

// Operator, 2026-11-16: an unconfirmed tick fails only itself. The app
// decides from its own rows what is due on every request, so the next tick
// simply asks again; no local marker stops it.
test("an unknown response fails this tick and the next tick asks again", async () => {
  let calls = 0;
  const input = { origin, secret,
    fetchImpl: async () => { calls += 1; return Response.json({ retry: false },
      { status: 503 }); } };
  assert.deepEqual(await runAmuxV4LocalRetentionOnce(input), { kind: "unconfirmed" });
  assert.deepEqual(await runAmuxV4LocalRetentionOnce(input), { kind: "unconfirmed" });
  assert.equal(calls, 2);
  const lost = await runAmuxV4LocalRetentionOnce({ origin, secret,
    fetchImpl: async () => { throw new Error("connection reset"); } });
  assert.deepEqual(lost, { kind: "unconfirmed" });
});

test("an invalid success body or a redirect is unconfirmed", async () => {
  for (const fetchImpl of [
    async () => Response.json({ ...completed, raw: { scanned: 0 } }),
    async () => ({ ...Response.json(completed),
      url: "https://other.example.test/", headers: new Headers({
        "content-type": "application/json" }) }),
  ]) {
    assert.deepEqual(await runAmuxV4LocalRetentionOnce({ origin, secret,
      fetchImpl }), { kind: "unconfirmed" });
  }
});

test("retention accepts the deployed route shape with separately gated v19 cleanup", async () => {
  const route = readFileSync(new URL(
    "../app/api/internal/amux/v4/content-retention/route.ts", import.meta.url), "utf8");
  assert.match(route, /available: false, reason: "v22_task_result_retention_disabled"/);
  assert.match(route, /amuxJsonNoStore\(\{ holdNotices, cancellation, raw, analysis,\s*taskResults, readManifests, sessionResults \}\)/);
  assert.deepEqual(await runAmuxV4LocalRetentionOnce({ origin, secret,
    fetchImpl: async () => Response.json(completed) }), { kind: "completed" });
  const v19Only = { ...completed,
    holdNotices: { available: false, reason: "v4_content_retention_disabled" },
    cancellation: { available: false, reason: "v4_content_retention_disabled" },
    raw: { available: false, reason: "v4_content_retention_disabled" },
    analysis: { available: false, reason: "v4_content_retention_disabled" },
    readManifests: { manifests: { bodiesPurged: 0, keysDeleted: 0,
      scanned: 0, batchLimit: 8 },
      orphanKeys: { keysDeleted: 0, scanned: 0, batchLimit: 8 } } };
  assert.deepEqual(await runAmuxV4LocalRetentionOnce({ origin, secret,
    fetchImpl: async () => Response.json(v19Only) }), { kind: "completed" });
});

test("missing, active, or malformed task retention results are unconfirmed", async () => {
  const legacy = { ...completed };
  delete legacy.taskResults;
  for (const body of [
    legacy,
    { ...completed, taskResults: { bodiesPurged: 0, keysDeleted: 0, scanned: 0, batchLimit: 8 } },
    { ...completed, taskResults: { available: true, reason: "v22_task_result_retention_disabled" } },
    { ...completed, taskResults: { available: false, reason: "unknown" } },
    { ...completed, taskResults: null },
    { ...completed, taskResults: { ...completed.taskResults, extra: true } },
    { ...completed, extra: true },
  ]) {
    assert.deepEqual(await runAmuxV4LocalRetentionOnce({ origin, secret,
      fetchImpl: async () => Response.json(body) }), { kind: "unconfirmed" });
  }
});

test("the retention entry point keeps no marker and fails an unconfirmed tick", () => {
  const entry = readFileSync(new URL("../scripts/amux-v4-content-retention-once.mjs",
    import.meta.url), "utf8");
  assert.doesNotMatch(entry, /HaltFile|claim|release/);
  assert.match(entry, /result\.kind !== "completed" && result\.kind !== "disabled"/);
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
