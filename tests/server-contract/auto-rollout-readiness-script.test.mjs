import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { AUTO_ROUTER_LIMITED_RELEASE_APPROVAL } from "../../lib/autoRouterLimitedReleaseApproval.ts";

const root = resolve(import.meta.dirname, "../..");
const moduleUrl = (path) => pathToFileURL(resolve(root, path)).href;
const expiry = Date.parse(AUTO_ROUTER_LIMITED_RELEASE_APPROVAL.expiresAt);

const run = ({ now = expiry, selected = false, overrides = {} } = {}) => {
  const source = `
    import { mock } from 'node:test';
    Date.now = () => ${now};
    mock.module(${JSON.stringify(moduleUrl("lib/autoRouterLimitedReleaseApproval.ts"))}, {
      namedExports: { AUTO_ROUTER_LIMITED_RELEASE_APPROVAL: ${JSON.stringify({ ...AUTO_ROUTER_LIMITED_RELEASE_APPROVAL, ...overrides })} }
    });
    await import(${JSON.stringify(moduleUrl("scripts/check-auto-rollout-readiness.mjs"))});
  `;
  return spawnSync(process.execPath, [
    "--conditions=react-server", "--experimental-test-module-mocks", "--import", "tsx",
    "--input-type=module", "--eval", source,
  ], {
    cwd: root, encoding: "utf8", timeout: 30_000,
    env: { ...process.env,
      NODE_ENV: "production", APP_ENV: "production", RAILWAY_ENVIRONMENT_NAME: "production",
      AUTO_ROUTER_LIMITED_RELEASE_EXCEPTION: selected ? "v1" : "",
      AUTO_ROUTER_ELIGIBLE_PLANS: "Free,Pro,Max", AUTO_ROUTER_ROLLOUT_PERCENT: "100",
      AUTO_ROUTER_COHORT_SALT: "readiness-test", AUTO_ROUTER_KILL_SWITCH: "off",
    },
  });
};

test("inactive approval passes before expiry and remains inactive at and after expiry", () => {
  for (const now of [expiry - 1, expiry, expiry + 86_400_000]) {
    const result = run({ now });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.includes("runtime expiry refusal verified"), now >= expiry);
    assert.doesNotMatch(result.stdout, /would be ROUTED by Auto/);
  }
});

test("explicitly selecting an expired approval still fails deployment readiness", () => {
  const result = run({ selected: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /expiresAt is expired/);
});

test("expiry does not hide malformed approval records", () => {
  for (const overrides of [{ approvedBy: null }, { expiresAt: "not-a-date" }, { policySha256: null }]) {
    const result = run({ overrides });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /runtime expiry refusal verified/);
  }
});

