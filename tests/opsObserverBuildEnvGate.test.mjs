// The build-time gate (docs/policy/sre-ops.md §3 rule 6): it fails the build
// when any runtime secret or credential-shaped name is in the build
// environment, prints names but never values, and passes a clean environment.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildEnvironmentViolations } from "../scripts/ops-observer/runtime-variables-core.mjs";

const gate = fileURLToPath(new URL("../scripts/ops-observer/build-env-gate.mjs", import.meta.url));

function runGate(extra) {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...extra };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return spawnSync(process.execPath, [gate], { env, encoding: "utf8" });
}

test("every runtime secret and destination of both services is a violation", () => {
  const names = [
    "OPS_OBSERVER_SECRET",
    "OPS_OBSERVER_DIGEST_SECRET",
    "OPS_OBSERVER_PAGE_WEBHOOK_URL",
    "OPS_OBSERVER_DIGEST_WEBHOOK_URL",
    "OPS_OBSERVER_HEARTBEAT_URL",
    "OPS_OBSERVER_DIGEST_HEARTBEAT_URL",
    "DATABASE_URL",
    "GITHUB_TOKEN",
  ];
  assert.deepEqual(buildEnvironmentViolations(names), [...names].sort());
});

test("switches, paths and ordinary build names are not violations", () => {
  assert.deepEqual(
    buildEnvironmentViolations(["OPS_OBSERVER_ENABLED", "OPS_OBSERVER_APP_URL", "RAILWAY_DOCKERFILE_PATH", "PATH", "HOME", "NODE_ENV"]),
    [],
  );
});

test("a clean build environment passes with one line", () => {
  const result = runGate({});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "ops_observer_build_env_gate=pass");
});

test("a runtime secret fails the build and is named but never printed", () => {
  const value = "hook-value-that-must-not-print-7f3a";
  const result = runGate({ OPS_OBSERVER_PAGE_WEBHOOK_URL: value, STRIPE_SECRET_KEY: value });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ops_observer_build_env_gate=fail names=OPS_OBSERVER_PAGE_WEBHOOK_URL,STRIPE_SECRET_KEY/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(value));
});
