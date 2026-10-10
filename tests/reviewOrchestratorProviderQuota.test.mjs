import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cursorCreditCentsFromBalance, cursorQuota, cursorQuotaFromUsage } from "../tools/review-orchestrator/lib/cursor-quota.mjs";
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

test("Cursor credit keeps an exhausted included pool available; no credit pauses it", () => {
  // The 2026-10-10 account: included $400 used up, bonus used up, $100 of credit grants left.
  const spent = { planUsage: { totalSpend: 325122, includedSpend: 40000, bonusSpend: 285122, limit: 40000,
    remainingBonus: false, autoPercentUsed: 100, apiPercentUsed: 100, totalPercentUsed: 100 } };
  assert.deepEqual(cursorQuotaFromUsage(spent, 10000), { state: "available", remainingPercent: 0, creditUsd: 100 });
  assert.deepEqual(cursorQuotaFromUsage(spent, 0), { state: "exhausted", remainingPercent: 0, creditUsd: 0 });
  // A balance that could not be read proves nothing: the exhausted pool stays exhausted.
  assert.deepEqual(cursorQuotaFromUsage(spent, null), { state: "exhausted", remainingPercent: 0 });
  // Credit is reported beside a pool that still has room, and changes nothing there.
  assert.deepEqual(cursorQuotaFromUsage({ planUsage: { totalPercentUsed: 40 } }, 2550),
    { state: "available", remainingPercent: 60, creditUsd: 25.5 });

  assert.equal(cursorCreditCentsFromBalance({ hasCreditGrants: true, creditBalanceCents: "10000", totalCents: "10000" }), 10000);
  assert.equal(cursorCreditCentsFromBalance({ creditBalanceCents: 1234 }), 1234);
  assert.equal(cursorCreditCentsFromBalance({ hasCreditGrants: false }), 0);
  assert.equal(cursorCreditCentsFromBalance({ creditBalanceCents: "-50" }), 0);
  for (const unknown of [null, {}, { hasCreditGrants: true }, { creditBalanceCents: "ten" }, { creditBalanceCents: "1e3" },
    { creditBalanceCents: "99999999999999999999" }, { creditBalanceCents: 1.5 }]) {
    assert.equal(cursorCreditCentsFromBalance(unknown), null, JSON.stringify(unknown));
  }
});

test("Cursor probe reads the CLI account token and makes only the usage and credit-balance requests", async () => {
  const requests = [];
  const provider = { passEnv: ["CURSOR_API_KEY"] };
  let credit = () => new Response(JSON.stringify({ hasCreditGrants: true, creditBalanceCents: "10000", totalCents: "10000" }));
  const options = { sourceEnv: { HOME: tmpdir(), CURSOR_API_KEY: "fake-key" },
    readCredentials: (path) => {
      assert.equal(path.endsWith(join(process.platform === "win32" ? "Cursor" : "cursor", "auth.json")), true);
      return { accessToken: "fake-token", apiKey: "fake-key" };
    },
    fetchUsage: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/GetCreditGrantsBalance")) return credit();
      return new Response(JSON.stringify({ planUsage: { remaining: 0, limit: 2000 } }));
    } };
  assert.deepEqual(await cursorQuota(provider, options), { state: "available", remainingPercent: 0, creditUsd: 100 });
  assert.deepEqual(requests.map((request) => request.url), [
    "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
    "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCreditGrantsBalance",
  ]);
  for (const request of requests) {
    assert.equal(request.init.headers.Authorization, "Bearer fake-token");
    assert.equal(request.init.body, "{}");
    assert.equal(request.init.redirect, "error");
  }
  // A credit read that fails leaves the exhausted pool exhausted.
  credit = () => new Response("denied", { status: 403 });
  assert.deepEqual(await cursorQuota(provider, options), { state: "exhausted", remainingPercent: 0 });
  credit = () => { throw new TypeError("fetch failed"); };
  assert.deepEqual(await cursorQuota(provider, options), { state: "exhausted", remainingPercent: 0 });
  const before = requests.length;
  const expired = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
  assert.deepEqual(await cursorQuota(provider, { ...options,
    readCredentials: () => ({ accessToken: expired, apiKey: "fake-key" }) }), { state: "unknown" });
  assert.deepEqual(await cursorQuota(provider, { ...options,
    readCredentials: () => ({ accessToken: "fake-token", apiKey: "different-account-key" }) }), { state: "unknown" });
  assert.equal(requests.length, before, "no request without a usable token for this account");
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

test("Copilot saved CLI login stays enabled when no explicit account token is configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-copilot-saved-login-"));
  const log = join(root, "requests.json");
  try {
    const result = await copilotQuota({ command: "copilot" }, {
      sourceEnv: { HOME: root },
      spawnChild: (_command, args, opts) => {
        assert.equal(args.includes("--no-auto-login"), false);
        assert.equal(args.includes("--auth-token-env"), false);
        assert.equal(args.includes("--headless") && args.includes("--stdio"), true);
        return spawn(process.execPath, [resolve("tests/fixtures/review-orchestrator/fake-quota-server.mjs")], {
          ...opts, env: { ...opts.env, FAKE_QUOTA_LOG: log, FAKE_QUOTA_RESULT: JSON.stringify(snapshot(65.8)) },
        });
      },
    });
    assert.deepEqual(result, { state: "available", remainingPercent: 65.8 });
    assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), {
      methods: ["connect", "account.getQuota"], tokenPassed: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
