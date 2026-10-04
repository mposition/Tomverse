import assert from "node:assert/strict";
import { test } from "node:test";

import { planAmuxContentRetentionTrigger,
  runAmuxContentRetentionTrigger } from
  "../lib/amux/ideaContentRetentionTrigger.mjs";

const env = { TOMVERSE_AMUX_V4_CONTENT_RETENTION_TRIGGER: "enabled",
  TOMVERSE_AMUX_V4_CONTENT_RETENTION_APP_ORIGIN: "https://staging.tomverse.app",
  TOMVERSE_AMUX_V4_CONTENT_RETENTION_SECRET:
    "synthetic-retention-token-0123456789" };

test("trigger rejects unrelated origins and product credentials before fetch", async () => {
  assert.deepEqual(planAmuxContentRetentionTrigger({}), { kind: "dark" });
  assert.equal(planAmuxContentRetentionTrigger({ DATABASE_URL:
    "postgresql://synthetic" }).kind, "config_error");
  assert.equal(planAmuxContentRetentionTrigger({ ...env,
    TOMVERSE_AMUX_V4_CONTENT_RETENTION_APP_ORIGIN: "https://outside.example" }).kind,
  "config_error");
  assert.equal(planAmuxContentRetentionTrigger({ ...env,
    DATABASE_URL: "postgresql://synthetic" }).kind, "config_error");
  let called = false;
  const result = await runAmuxContentRetentionTrigger({ ...env,
    AMUX_V4_KEY_STORE_BUCKET: "synthetic" }, async () => { called = true; });
  assert.equal(result.kind, "config_error");
  assert.equal(called, false);
});

test("trigger sends only its own capability and reports a bounded summary", async () => {
  let calls = 0;
  const result = await runAmuxContentRetentionTrigger(env, async (url, init) => {
    calls += 1;
    assert.equal(url, "https://staging.tomverse.app/api/internal/amux/v4/content-retention");
    assert.equal(init.headers["x-amux-agent-id"], "amux-v4-intake-retention");
    assert.match(init.headers.authorization, /^Bearer synthetic-/);
    assert.equal(init.redirect, "error");
    return { ok: true, status: 200, json: async () => ({
      holdNotices: { scanned: 1 }, cancellation: { scanned: 2 },
      raw: { scanned: 3 }, analysis: { scanned: 4 },
    }) };
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { kind: "completed", scanned: {
    notices: 1, cancellations: 2, raw: 3, analysis: 4 } });
});

test("unknown response or network loss stops without retry", async () => {
  let calls = 0;
  const failed = await runAmuxContentRetentionTrigger(env, async () => {
    calls += 1;
    throw new Error("synthetic network loss");
  });
  assert.equal(failed.kind, "outcome_unknown");
  assert.equal(calls, 1);
  const incomplete = await runAmuxContentRetentionTrigger(env, async () => ({
    ok: true, status: 200, json: async () => ({ raw: { scanned: 1 } }),
  }));
  assert.equal(incomplete.kind, "outcome_unknown");
});
