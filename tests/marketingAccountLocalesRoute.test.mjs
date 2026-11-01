import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

// POST /api/admin/marketing/accounts/[channelId]/locales (operator decision
// 2026-11-01). The permission, step-up, kill switch and audit row are the
// shared wrapper's, swept for every marketing route in
// tests/marketingS2b1Store.test.mjs; this pins what the route hands it.

const child = spawnSync(
  process.execPath,
  [
    "--experimental-test-module-mocks",
    "--conditions=react-server",
    "--import",
    "tsx",
    resolve("tests/support/marketingAccountLocalesRouteHarness.mjs"),
  ],
  { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
);
assert.equal(child.status, 0, `harness failed\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
const line = child.stdout
  .split(/\r?\n/u)
  .find((candidate) => candidate.startsWith("MARKETING_ACCOUNT_LOCALES_ROUTE="));
assert.ok(line, child.stdout);
const route = JSON.parse(line.slice("MARKETING_ACCOUNT_LOCALES_ROUTE=".length));

test("the route records its own audit action against the account, behind the kill switch", () => {
  assert.equal(route.action, "marketing_account.locales_changed");
  assert.equal(route.targetType, "MarketingChannel");
  assert.equal(route.targetId, "channel-1");
  assert.equal(route.gate, "account_control");
  assert.equal(route.bucket, "admin-marketing-account-locales");
  assert.deepEqual(route.metadata, {
    expectedDefaultLocale: "en",
    expectedAllowedLocales: ["ko", "en", "zh-Hant"],
    defaultLocale: "en",
    allowedLocales: ["en"],
  });
});

test("the body names the languages it replaces and only known languages", () => {
  assert.deepEqual(route.parses, {
    valid: true,
    unknownLocale: false,
    noLocales: false,
    extraKey: false,
    missingExpected: false,
  });
});

test("the store's language refusals keep their status and anything else falls through", () => {
  assert.deepEqual(route.refusal.own, {
    code: "locales_change_conflict",
    status: 409,
    message: "moved",
  });
  assert.equal(route.refusal.other, null);
});

test("the change runs in the wrapper's transaction against the route's account", () => {
  assert.equal(route.run.sameTx, true);
  assert.deepEqual(route.run.input, {
    id: "channel-1",
    expectedDefaultLocale: "en",
    expectedAllowedLocales: ["ko", "en", "zh-Hant"],
    defaultLocale: "en",
    allowedLocales: ["en"],
  });
  assert.deepEqual(route.run.result, {
    id: "channel-1",
    defaultLocale: "en",
    allowedLocales: ["en"],
    droppedLocales: ["ko"],
  });
});
