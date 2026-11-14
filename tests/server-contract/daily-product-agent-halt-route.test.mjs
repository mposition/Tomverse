import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const mod = path => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let notices = [], alerts = [], changed = true;
mock.module(mod("lib/dailyProductAgentStore.ts"), { namedExports: {
  recordDailyProductHalt: async input => { notices.push(input); return { ok: true, changed }; },
} });
mock.module(mod("lib/operationalMonitoring.ts"), { namedExports: {
  reportOperationalIncident: async input => { alerts.push(input); return { notified: true }; },
} });
const { POST } = await import(mod("app/api/internal/product-improvements/halt/route.ts"));
const before = { ...process.env };
const notice = { runId: "11111111-2222-4333-8444-555555555555", reason: "publish_unknown", attempted: 9, prOpened: 1, lastPrUrl: "https://github.com/mposition/Tomverse/pull/1" };
const request = (body = notice, headers = {}) => new Request("https://app.example.test/api/internal/product-improvements/halt", {
  method: "POST", headers: { authorization: `Bearer ${"s".repeat(32)}`, "content-type": "application/json", "x-autorec-work-mode": "daily-product", ...headers }, body: JSON.stringify(body),
});
test.beforeEach(() => {
  notices = []; alerts = []; changed = true;
  process.env.AUTO_ROUTER_REC_AGENT_SECRET = "s".repeat(32);
  process.env.DAILY_PRODUCT_AGENT_ALERTS_ENABLED = "true";
});
test.after(() => {
  for (const key of ["AUTO_ROUTER_REC_AGENT_SECRET", "DAILY_PRODUCT_AGENT_ALERTS_ENABLED"]) {
    if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
  }
});
test("a notice requires the existing secret, daily mode and explicit activation", async () => {
  for (const headers of [{ authorization: "Bearer wrong" }, { "x-autorec-work-mode": "router" }]) {
    assert.equal((await POST(request(notice, headers))).status, 404);
  }
  delete process.env.DAILY_PRODUCT_AGENT_ALERTS_ENABLED;
  assert.equal((await POST(request())).status, 404);
  assert.equal(notices.length, 0);
  assert.equal(alerts.length, 0);
});
test("only closed codes, bounded counts and a Tomverse PR link can reach the notifier", async () => {
  for (const fields of [{ reason: "arbitrary secret text" }, { attempted: 25 }, { prOpened: 10 }, { lastPrUrl: "https://example.test/private" }, { modelOutput: "must not leave" }]) {
    assert.equal((await POST(request({ ...notice, ...fields }))).status, 400);
  }
  assert.equal(alerts.length, 0);
});
test("a new durable notice reaches the existing operator channels; a replay never sends", async () => {
  assert.equal((await POST(request())).status, 200);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].code, "DAILY_PRODUCT_AGENT_STOPPED");
  assert.equal(alerts[0].context.reason, "publish_unknown");
  assert.ok(alerts[0].context.admin.endsWith("/admin/alerts?tab=deliveries"));
  changed = false;
  assert.equal((await POST(request())).status, 200);
  assert.equal(alerts.length, 1);
});
