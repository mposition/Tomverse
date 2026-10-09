import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cursorQuota, cursorQuotaFromUsage } from "../tools/review-orchestrator/lib/cursor-quota.mjs";
import { copilotQuota, copilotQuotaFromUsage } from "../tools/review-orchestrator/lib/copilot-quota.mjs";

const snapshot = (remainingPercentage, usedRequests = 100 - remainingPercentage) => ({
  quotaSnapshots: { premium_interactions: { remainingPercentage, usedRequests,
    entitlementRequests: 100, isUnlimitedEntitlement: false } },
});

test("Cursor current-period account usage blocks an exhausted pool and unrecognized responses", () => {
  assert.deepEqual(cursorQuotaFromUsage({ planUsage: { remaining: 1000, limit: 2000, totalPercentUsed: 50 } }),
    { state: "available", remainingPercent: 50 });
  assert.deepEqual(cursorQuotaFromUsage({ planUsage: { remaining: 1000, apiPercentUsed: 100, autoPercentUsed: 50 } }),
    { state: "exhausted", remainingPercent: 0 });
  assert.deepEqual(cursorQuotaFromUsage({ planUsage: { remaining: 0, limit: 2000 } }),
    { state: "exhausted", remainingPercent: 0 });
  assert.deepEqual(cursorQuotaFromUsage({ planUsage: {} }), { state: "unknown" });
  assert.deepEqual(cursorQuotaFromUsage({ planUsage: { remaining: 1000, apiPercentUsed: "100" } }), { state: "unknown" });
  assert.deepEqual(cursorQuotaFromUsage({ spendLimitUsage: { individualRemaining: 1000 } }), { state: "unknown" });
});

test("Cursor probe reads the CLI account token and makes only the account-usage request", async () => {
  const requests = [];
  const provider = { passEnv: ["CURSOR_API_KEY"] };
  const options = { sourceEnv: { HOME: tmpdir(), CURSOR_API_KEY: "fake-key" },
    readCredentials: (path) => {
      assert.equal(path.endsWith(join(process.platform === "win32" ? "Cursor" : "cursor", "auth.json")), true);
      return { accessToken: "fake-token", apiKey: "fake-key" };
    },
    fetchUsage: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ planUsage: { remaining: 0, limit: 2000 } }));
    } };
  assert.deepEqual(await cursorQuota(provider, options), { state: "exhausted", remainingPercent: 0 });
  assert.equal(requests.length, 1);
  const expired = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
  assert.deepEqual(await cursorQuota(provider, { ...options,
    readCredentials: () => ({ accessToken: expired, apiKey: "fake-key" }) }), { state: "unknown" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage");
  assert.equal(requests[0].init.headers.Authorization, "Bearer fake-token");
  assert.equal(requests[0].init.body, "{}");
  assert.equal(requests[0].init.redirect, "error");
  assert.deepEqual(await cursorQuota(provider, { ...options,
    readCredentials: () => ({ accessToken: "fake-token", apiKey: "different-account-key" }) }), { state: "unknown" });
  assert.equal(requests.length, 1);
  assert.deepEqual(await cursorQuota(provider, { ...options,
    fetchUsage: async () => new Response("denied", { status: 401 }) }), { state: "unknown" });
});

test("Copilot entitlement is checked from the selected account quota, not session usage", () => {
  assert.deepEqual(copilotQuotaFromUsage(snapshot(25)), { state: "available", remainingPercent: 25 });
  assert.deepEqual(copilotQuotaFromUsage(snapshot(0)), { state: "exhausted", remainingPercent: 0 });
  assert.deepEqual(copilotQuotaFromUsage(snapshot(50, 100)), { state: "exhausted", remainingPercent: 0 });
  assert.deepEqual(copilotQuotaFromUsage({ quotaSnapshots: { chat: snapshot(50).quotaSnapshots.premium_interactions } }),
    { state: "unknown" });
  assert.deepEqual(copilotQuotaFromUsage({ quotaSnapshots: { premium_interactions:
    { isUnlimitedEntitlement: true, entitlementRequests: -1 } } }),
    { state: "available", remainingPercent: 100, unlimited: true });
});

test("Copilot headless probe handles framed responses and sends no session or model methods", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-copilot-quota-"));
  const provider = { command: "copilot", passEnv: ["COPILOT_GITHUB_TOKEN"] };
  try {
    for (const legacy of [false, true]) {
      const log = join(root, `requests-${legacy}.json`);
      const result = await copilotQuota(provider, {
        sourceEnv: { HOME: root, COPILOT_GITHUB_TOKEN: "fake-token", REVIEW_ORCH_SECRET_PROBE: "secret" },
        spawnChild: (command, args, opts) => {
          assert.equal(command, "copilot");
          assert.equal(args.includes("--headless") && args.includes("--stdio"), true);
          assert.equal(opts.env.REVIEW_ORCH_SECRET_PROBE, undefined);
          assert.equal(args.includes("fake-token"), false);
          return spawn(process.execPath, [resolve("tests/fixtures/review-orchestrator/fake-quota-server.mjs")], {
            ...opts, env: { ...opts.env, FAKE_QUOTA_LOG: log, FAKE_QUOTA_RESULT: JSON.stringify(snapshot(0)),
              FAKE_QUOTA_LEGACY: String(legacy) },
          });
        },
      });
      assert.deepEqual(result, { state: "exhausted", remainingPercent: 0 });
      assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), {
        methods: legacy ? ["connect", "ping", "account.getQuota"] : ["connect", "account.getQuota"], tokenPassed: true,
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Copilot missing credentials and oversized frames fail closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-copilot-quota-bad-"));
  try {
    const provider = { command: "copilot", passEnv: ["COPILOT_GITHUB_TOKEN"] };
    assert.deepEqual(await copilotQuota(provider, { sourceEnv: {},
      spawnChild: () => { throw new Error("must not spawn without the configured account token"); } }), { state: "unknown" });
    assert.deepEqual(await copilotQuota(provider, { sourceEnv: { HOME: root, COPILOT_GITHUB_TOKEN: "fake-token" },
      spawnChild: (_command, _args, opts) => spawn(process.execPath,
        [resolve("tests/fixtures/review-orchestrator/fake-quota-server.mjs")], {
          ...opts, env: { ...opts.env, FAKE_QUOTA_LOG: join(root, "requests.json"), FAKE_QUOTA_OVERSIZE: "true" },
        }) }), { state: "unknown" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
