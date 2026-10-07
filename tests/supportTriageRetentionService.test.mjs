import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  SUPPORT_TRIAGE_RETENTION_CHILD_REQUEST_TIMEOUT_MS,
  SUPPORT_TRIAGE_RETENTION_ENDPOINTS,
  SUPPORT_TRIAGE_RETENTION_ROUTE_BUDGET_MS,
  SUPPORT_TRIAGE_RETENTION_SUPERVISOR_DEADLINE_MS,
  postWithTimeout,
  runSupportTriageRetentionService,
} from "../lib/supportTriageRetentionServiceCore.ts";
import { superviseSupportTriageRetention } from "../scripts/support-triage-retention-service.mjs";

// The Support Triage Retention service (docs/policy/support-triage.md §3, §5).

const SECRET = "r".repeat(40);
const ENV = { SUPPORT_TRIAGE_RETENTION_SECRET: SECRET, RAILWAY_ENVIRONMENT_NAME: "staging", PATH: "/usr/bin" };

const answering = (status, body) => {
  const calls = [];
  const post = async (url, headers) => {
    calls.push({ url, headers });
    return { status, body };
  };
  return { calls, post };
};

test("the deadlines are ordered: supervisor > child request > the route's run budget", () => {
  assert.ok(SUPPORT_TRIAGE_RETENTION_SUPERVISOR_DEADLINE_MS > SUPPORT_TRIAGE_RETENTION_CHILD_REQUEST_TIMEOUT_MS);
  assert.ok(SUPPORT_TRIAGE_RETENTION_CHILD_REQUEST_TIMEOUT_MS > SUPPORT_TRIAGE_RETENTION_ROUTE_BUDGET_MS);
  assert.equal(SUPPORT_TRIAGE_RETENTION_SUPERVISOR_DEADLINE_MS, 300_000);
  assert.equal(SUPPORT_TRIAGE_RETENTION_CHILD_REQUEST_TIMEOUT_MS, 240_000);
});

test("the route's run budget and maxDuration agree with the app", async () => {
  const { readFileSync } = await import("node:fs");
  const core = await import("../lib/supportTriageCore.ts");
  assert.equal(core.LANE_TIMEOUTS.retention.deadlineMs, SUPPORT_TRIAGE_RETENTION_ROUTE_BUDGET_MS);
  const route = readFileSync(new URL("../app/api/internal/support-triage/retention/route.ts", import.meta.url), "utf8");
  // The route may run as long as the child waits, and no longer.
  assert.match(route, new RegExp(`maxDuration = ${SUPPORT_TRIAGE_RETENTION_CHILD_REQUEST_TIMEOUT_MS / 1000};`));
});

test("only an ok with 200 is a success; the destination is the environment's, with the secret as Bearer", async () => {
  const ok = answering(200, { result: "ok", deleted: 3 });
  assert.deepEqual(await runSupportTriageRetentionService(ENV, ok.post), { exitCode: 0, outcome: "ran", result: "ok" });
  assert.deepEqual(ok.calls, [
    { url: SUPPORT_TRIAGE_RETENTION_ENDPOINTS.staging, headers: { authorization: `Bearer ${SECRET}` } },
  ]);
  const prod = answering(200, { result: "ok" });
  await runSupportTriageRetentionService({ ...ENV, RAILWAY_ENVIRONMENT_NAME: "production" }, prod.post);
  assert.equal(prod.calls[0].url, "https://tomverse.app/api/internal/support-triage/retention");

  for (const [status, result] of [
    [503, "SUPPORT_TRIAGE_RETENTION_NOT_PROGRESSING"],
    [429, "daily_cap_exceeded"],
    [401, "unauthorized"],
    [500, "internal_error"],
  ]) {
    assert.deepEqual(await runSupportTriageRetentionService(ENV, answering(status, { result }).post), {
      exitCode: 1,
      outcome: "ran",
      result,
      status,
    });
  }
  // A code with the wrong status, an unknown code, or no body is not believed.
  for (const [status, body] of [[200, { result: "SUPPORT_TRIAGE_RETENTION_NOT_PROGRESSING" }], [200, { result: "done" }], [502, null]]) {
    assert.deepEqual(await runSupportTriageRetentionService(ENV, answering(status, body).post), {
      exitCode: 1,
      outcome: "run_outcome_unknown",
      status,
    });
  }
  const failing = async () => {
    throw new Error("network");
  };
  assert.deepEqual(await runSupportTriageRetentionService(ENV, failing), { exitCode: 1, outcome: "run_outcome_unknown" });
});

test("it refuses to start with any other variable, a short secret, or an unknown environment, and calls nothing", async () => {
  for (const [env, expected] of [
    [{ ...ENV, DATABASE_URL: "postgres://x" }, { reason: "env_not_allowed", names: ["DATABASE_URL"] }],
    [{ ...ENV, SUPPORT_TRIAGE_HEARTBEAT_SECRET: "h".repeat(40) }, { reason: "env_not_allowed", names: ["SUPPORT_TRIAGE_HEARTBEAT_SECRET"] }],
    // RAILWAY_ is an exact list, not a prefix.
    [{ ...ENV, RAILWAY_DATABASE_TOKEN: "t" }, { reason: "env_not_allowed", names: ["RAILWAY_DATABASE_TOKEN"] }],
    // An allowed name holding a connection string.
    [{ ...ENV, RAILPACK_SOMETHING: "postgresql://u:p@h/db" }, { reason: "env_holds_connection_string", names: ["RAILPACK_SOMETHING"] }],
    [{ ...ENV, CI: "host=db port=5432 password=x" }, { reason: "env_holds_connection_string", names: ["CI"] }],
    // libpq needs no host: a service name or a password alone connects.
    [{ ...ENV, MISE_DATABASE_URL: "service=tomverse password=secret" }, { reason: "env_holds_connection_string", names: ["MISE_DATABASE_URL"] }],
    [{ ...ENV, RAILPACK_PG: "password=secret" }, { reason: "env_holds_connection_string", names: ["RAILPACK_PG"] }],
    [{ ...ENV, MISE_PG: "passfile=/run/pgpass" }, { reason: "env_holds_connection_string", names: ["MISE_PG"] }],
    [{ ...ENV, SUPPORT_TRIAGE_RETENTION_SECRET: "s".repeat(31) }, { reason: "secret_missing_or_short" }],
    [{ ...ENV, SUPPORT_TRIAGE_RETENTION_SECRET: undefined }, { reason: "secret_missing_or_short" }],
  ]) {
    const port = answering(200, { result: "ok" });
    assert.deepEqual(await runSupportTriageRetentionService(env, port.post), {
      exitCode: 1,
      outcome: "refused_to_start",
      ...expected,
    });
    assert.equal(port.calls.length, 0);
  }
  // A refusal names variables, never values.
  const leaked = await runSupportTriageRetentionService({ ...ENV, OTHER: "secret-value-here" }, answering(200, {}).post);
  assert.ok(!JSON.stringify(leaked).includes("secret-value-here"));
  const dev = answering(200, { result: "ok" });
  assert.deepEqual(await runSupportTriageRetentionService({ ...ENV, RAILWAY_ENVIRONMENT_NAME: "dev" }, dev.post), {
    exitCode: 1,
    outcome: "destination_unknown",
  });
  assert.equal(dev.calls.length, 0);
});

test("the names measured in the deployed Agents image are accepted", async () => {
  // Measured 2026-10-03 (lib/productResearchObservationRunnerCore.mjs).
  const image = {
    ...ENV,
    CI: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
    SSL_CERT_DIR: "/etc/ssl/certs",
    RAILPACK_PACKAGES: "node@22",
    MISE_DATA_DIR: "/mise",
    __MISE_ORIG_PATH: "/usr/bin",
    HOME: "/root",
    NODE_VERSION: "22",
    RAILWAY_ENVIRONMENT_NAME: "staging",
    RAILWAY_SERVICE_NAME: "Support Triage Retention",
  };
  const port = answering(200, { result: "ok" });
  assert.deepEqual(await runSupportTriageRetentionService(image, port.post), { exitCode: 0, outcome: "ran", result: "ok" });
});

test("the child's port gives up on a server that never answers, within its timeout", async () => {
  const server = createServer(() => {
    // Never answers.
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const started = Date.now();
    await assert.rejects(postWithTimeout(300)(`http://127.0.0.1:${port}/`, {}));
    assert.ok(Date.now() - started < 3_000, String(Date.now() - started));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// The supervisor against real child processes that would never end by themselves.
const fixtureDir = mkdtempSync(join(tmpdir(), "support-triage-supervisor-"));
const fixture = (name, source) => {
  const path = join(fixtureDir, name);
  writeFileSync(path, source);
  return path;
};
const CHILDREN = {
  "a synchronous infinite loop": fixture("loop.mjs", "for (;;) {}\n"),
  "a child that ignores SIGTERM": fixture(
    "ignore-term.mjs",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n"
  ),
  "an open handle": fixture("open-handle.mjs", "setInterval(() => {}, 1000);\n"),
};

for (const [label, script] of Object.entries(CHILDREN)) {
  test(`the supervisor kills ${label} at its deadline and exits 1`, async () => {
    const logs = [];
    const started = Date.now();
    const code = await superviseSupportTriageRetention({
      env: ENV,
      deadlineMs: 500,
      log: (line) => logs.push(line),
      spawnChild: () => spawn(process.execPath, [script], { stdio: "ignore" }),
    });
    assert.equal(code, 1);
    assert.ok(Date.now() - started < 5_000, String(Date.now() - started));
    assert.ok(logs.some((line) => line.includes('"deadline_killed"')), logs.join("\n"));
  });
}

test("the supervisor passes a finished child's exit code through, and starts no child when refused", async () => {
  const exitsTwo = fixture("exit-two.mjs", "process.exit(2);\n");
  assert.equal(
    await superviseSupportTriageRetention({
      env: ENV,
      deadlineMs: 5_000,
      log: () => {},
      spawnChild: () => spawn(process.execPath, [exitsTwo], { stdio: "ignore" }),
    }),
    2
  );
  let spawned = false;
  assert.equal(
    await superviseSupportTriageRetention({
      env: { ...ENV, DATABASE_URL: "postgres://x" },
      log: () => {},
      spawnChild: () => {
        spawned = true;
        throw new Error("must not spawn");
      },
    }),
    1
  );
  assert.equal(spawned, false);
});

test("cleanup", () => {
  rmSync(fixtureDir, { recursive: true, force: true });
});
