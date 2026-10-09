// The service entry point (docs/policy/sre-ops.md §3 rules 5 and 7): dark
// unless the switch is exactly "true", no child before the environment passes,
// the child sees only its variables, and a child still running at the deadline
// is killed with SIGKILL and the run reported as failed.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { planStart, supervise } from "../scripts/ops-observer/supervise.mjs";

const PAGE_ENV = {
  OPS_OBSERVER_ENABLED: "true",
  OPS_OBSERVER_SECRET: "s".repeat(40),
  OPS_OBSERVER_HEARTBEAT_URL: "https://dead-man.example/ping/abc",
  OPS_OBSERVER_APP_URL: "https://tomverse.app",
  RAILWAY_DOCKERFILE_PATH: "docker/ops-observer.Dockerfile",
  PATH: "/usr/bin",
};

const quiet = () => {};

function nodeChild(code) {
  return (childEnv) =>
    spawn(process.execPath, ["-e", code], {
      env: { ...childEnv, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      stdio: ["ignore", "pipe", "inherit"],
    });
}

test("dark unless the switch is exactly \"true\", and no child is started", async () => {
  for (const value of [undefined, "", "TRUE", "1", "yes", "true "]) {
    const env = { ...PAGE_ENV, OPS_OBSERVER_ENABLED: value };
    if (value === undefined) delete env.OPS_OBSERVER_ENABLED;
    let spawned = false;
    const code = await supervise({ service: "page", env, spawnChild: () => (spawned = true), log: quiet });
    assert.equal(code, 0, String(value));
    assert.equal(spawned, false);
  }
});

test("a refused environment name stops the run before any child exists", async () => {
  let spawned = false;
  const logs = [];
  const code = await supervise({
    service: "page",
    env: { ...PAGE_ENV, DATABASE_URL: "postgres://value-not-printed" },
    spawnChild: () => (spawned = true),
    log: (line) => logs.push(line),
  });
  assert.equal(code, 1);
  assert.equal(spawned, false);
  assert.match(logs.join("\n"), /reason=env_not_allowed names=\["DATABASE_URL"\]/);
  assert.ok(!logs.join("\n").includes("value-not-printed"));
});

test("missing required variables and a non-production app URL are config errors", () => {
  const missing = { ...PAGE_ENV };
  delete missing.OPS_OBSERVER_HEARTBEAT_URL;
  assert.deepEqual(planStart("page", missing), {
    action: "config_error",
    reason: "env_missing",
    names: ["OPS_OBSERVER_HEARTBEAT_URL"],
  });
  assert.equal(planStart("page", { ...PAGE_ENV, OPS_OBSERVER_APP_URL: "https://staging.tomverse.app" }).reason, "app_url_not_production");
  assert.equal(planStart("page", PAGE_ENV).action, "start");
});

test("the child receives only its listed variables", () => {
  const plan = planStart("page", PAGE_ENV);
  assert.deepEqual(Object.keys(plan.childEnv).sort(), [
    "OPS_OBSERVER_APP_URL",
    "OPS_OBSERVER_HEARTBEAT_URL",
    "OPS_OBSERVER_SECRET",
  ]);
});

test("the child's exit code is the service's exit code", async () => {
  assert.equal(await supervise({ service: "page", env: PAGE_ENV, spawnChild: nodeChild("process.exit(0)"), log: quiet }), 0);
  assert.equal(await supervise({ service: "page", env: PAGE_ENV, spawnChild: nodeChild("process.exit(3)"), log: quiet }), 3);
});

test("a child still running at the deadline is killed and the run fails", async () => {
  const logs = [];
  const started = Date.now();
  const code = await supervise({
    service: "page",
    env: PAGE_ENV,
    spawnChild: nodeChild("setInterval(() => {}, 1000)"),
    deadlineMs: 300,
    log: (line) => logs.push(line),
  });
  assert.equal(code, 1);
  assert.ok(Date.now() - started < 5_000);
  assert.match(logs.join("\n"), /deadline_killed/);
});

test("a child that ignores SIGTERM is still killed", async () => {
  const code = await supervise({
    service: "page",
    env: PAGE_ENV,
    spawnChild: nodeChild("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"),
    deadlineMs: 300,
    log: quiet,
  });
  assert.equal(code, 1);
});

test("a hostile environment name cannot add a log line", async () => {
  const logs = [];
  await supervise({
    service: "page",
    env: { ...PAGE_ENV, "X\nops_observer_supervisor=ok": "1" },
    spawnChild: () => assert.fail("no child"),
    log: (line) => logs.push(line),
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].split("\n").length, 1);
});

test("the digest service needs its webhook and passes its child only its variables", () => {
  const env = {
    OPS_OBSERVER_ENABLED: "true",
    OPS_OBSERVER_DIGEST_SECRET: "d".repeat(40),
    OPS_OBSERVER_DIGEST_HEARTBEAT_URL: "https://dead-man.example/ping/def",
    OPS_OBSERVER_APP_URL: "https://tomverse.app",
  };
  assert.deepEqual(planStart("digest", env).names, ["OPS_OBSERVER_DIGEST_WEBHOOK_URL"]);
  const plan = planStart("digest", { ...env, OPS_OBSERVER_DIGEST_WEBHOOK_URL: "https://hooks.example/d" });
  assert.deepEqual(Object.keys(plan.childEnv).sort(), [
    "OPS_OBSERVER_APP_URL",
    "OPS_OBSERVER_DIGEST_HEARTBEAT_URL",
    "OPS_OBSERVER_DIGEST_SECRET",
    "OPS_OBSERVER_DIGEST_WEBHOOK_URL",
  ]);
  assert.equal(planStart("digest", { ...env, OPS_OBSERVER_SECRET: "x".repeat(40) }).reason, "env_not_allowed");
});

test("a child that cannot be spawned fails the run", async () => {
  const code = await supervise({
    service: "page",
    env: PAGE_ENV,
    spawnChild: (childEnv) => spawn("/nonexistent/ops-observer-child", [], { env: childEnv }),
    log: quiet,
  });
  assert.equal(code, 1);
});
