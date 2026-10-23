import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  SUPPORT_TRIAGE_SERVICES,
  SUPPORT_TRIAGE_SERVICE_KINDS,
  postWithTimeout,
  runSupportTriageService,
  supportTriageServiceVariables,
} from "../lib/supportTriageServiceCore.ts";
import { superviseSupportTriageService } from "../scripts/support-triage-service.mjs";

// The Support Triage cron services (docs/policy/support-triage.md §3, §5).

const SECRETS = { worker: "w".repeat(40), retention: "r".repeat(40) };
const envFor = (kind) => ({
  [SUPPORT_TRIAGE_SERVICES[kind].secretVariable]: SECRETS[kind],
  RAILWAY_ENVIRONMENT_NAME: "staging",
  PATH: "/usr/bin",
});

const answering = (status, body) => {
  const calls = [];
  const post = async (url, headers) => {
    calls.push({ url, headers });
    return { status, body };
  };
  return { calls, post };
};

test("per service the deadlines are ordered: supervisor > child request > the route's run budget", async () => {
  const core = await import("../lib/supportTriageCore.ts");
  for (const kind of SUPPORT_TRIAGE_SERVICE_KINDS) {
    const service = SUPPORT_TRIAGE_SERVICES[kind];
    assert.ok(service.supervisorDeadlineMs > service.childRequestTimeoutMs, kind);
    assert.ok(service.childRequestTimeoutMs > service.routeBudgetMs, kind);
    assert.equal(service.routeBudgetMs, core.LANE_TIMEOUTS[kind].deadlineMs, kind);
    // The route may run as long as the child waits, and no longer.
    const route = readFileSync(
      new URL(`../app/api/internal/support-triage/${kind === "worker" ? "run" : "retention"}/route.ts`, import.meta.url),
      "utf8"
    );
    assert.match(route, new RegExp(`maxDuration = ${service.childRequestTimeoutMs / 1000};`), kind);
  }
  // Policy §3: worker 10 min / 9 min, retention 5 min / 4 min.
  assert.equal(SUPPORT_TRIAGE_SERVICES.worker.supervisorDeadlineMs, 600_000);
  assert.equal(SUPPORT_TRIAGE_SERVICES.worker.childRequestTimeoutMs, 540_000);
  assert.equal(SUPPORT_TRIAGE_SERVICES.retention.supervisorDeadlineMs, 300_000);
  assert.equal(SUPPORT_TRIAGE_SERVICES.retention.childRequestTimeoutMs, 240_000);
});

test("each service holds only its own secret, and one service's secret refuses the other's start", async () => {
  assert.deepEqual(supportTriageServiceVariables("worker"), ["SUPPORT_TRIAGE_RUN_SECRET"]);
  assert.deepEqual(supportTriageServiceVariables("retention"), ["SUPPORT_TRIAGE_RETENTION_SECRET"]);
  const crossed = { ...envFor("worker"), SUPPORT_TRIAGE_RETENTION_SECRET: SECRETS.retention };
  assert.deepEqual(await runSupportTriageService("worker", crossed, answering(200, { result: "ok" }).post), {
    exitCode: 1,
    outcome: "refused_to_start",
    reason: "env_not_allowed",
    names: ["SUPPORT_TRIAGE_RETENTION_SECRET"],
  });
});

for (const kind of SUPPORT_TRIAGE_SERVICE_KINDS) {
  test(`${kind}: only an ok with 200 is a success; the destination is the environment's, with the secret as Bearer`, async () => {
    const ok = answering(200, { result: "ok" });
    assert.deepEqual(await runSupportTriageService(kind, envFor(kind), ok.post), { exitCode: 0, outcome: "ran", result: "ok" });
    assert.deepEqual(ok.calls, [
      { url: SUPPORT_TRIAGE_SERVICES[kind].endpoints.staging, headers: { authorization: `Bearer ${SECRETS[kind]}` } },
    ]);
    const prod = answering(200, { result: "ok" });
    await runSupportTriageService(kind, { ...envFor(kind), RAILWAY_ENVIRONMENT_NAME: "production" }, prod.post);
    assert.equal(
      prod.calls[0].url,
      `https://tomverse.app/api/internal/support-triage/${kind === "worker" ? "run" : "retention"}`
    );

    for (const [status, result] of [[429, "daily_cap_exceeded"], [401, "unauthorized"], [500, "internal_error"], [503, "transaction_refused"]]) {
      assert.deepEqual(await runSupportTriageService(kind, envFor(kind), answering(status, { result }).post), {
        exitCode: 1,
        outcome: "ran",
        result,
        status,
      });
    }
    // A code with the wrong status, an unknown code, or no body is not believed.
    for (const [status, body] of [[503, { result: "ok" }], [200, { result: "done" }], [200, { enabled: false }], [502, null]]) {
      assert.deepEqual(await runSupportTriageService(kind, envFor(kind), answering(status, body).post), {
        exitCode: 1,
        outcome: "run_outcome_unknown",
        status,
      });
    }
    const failing = async () => {
      throw new Error("network");
    };
    assert.deepEqual(await runSupportTriageService(kind, envFor(kind), failing), { exitCode: 1, outcome: "run_outcome_unknown" });
  });
}

test("retention's not-progressing answer is a failed run; the worker never answers it", async () => {
  const notProgressing = { result: "SUPPORT_TRIAGE_RETENTION_NOT_PROGRESSING" };
  assert.deepEqual(await runSupportTriageService("retention", envFor("retention"), answering(503, notProgressing).post), {
    exitCode: 1,
    outcome: "ran",
    result: notProgressing.result,
    status: 503,
  });
  assert.equal(
    (await runSupportTriageService("worker", envFor("worker"), answering(503, notProgressing).post)).outcome,
    "run_outcome_unknown"
  );
});

test("it refuses to start with any other variable, a short secret, or an unknown environment, and calls nothing", async () => {
  const ENV = envFor("retention");
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
    // A keyword may follow a quoted value with no space.
    [{ ...ENV, MISE_PG: "host='db'password=secret" }, { reason: "env_holds_connection_string", names: ["MISE_PG"] }],
    [{ ...ENV, MISE_PG: "dbname='x'\tpassfile=/p" }, { reason: "env_holds_connection_string", names: ["MISE_PG"] }],
    [{ ...ENV, SUPPORT_TRIAGE_RETENTION_SECRET: "s".repeat(31) }, { reason: "secret_missing_or_short" }],
    [{ ...ENV, SUPPORT_TRIAGE_RETENTION_SECRET: undefined }, { reason: "secret_missing_or_short" }],
  ]) {
    const port = answering(200, { result: "ok" });
    assert.deepEqual(await runSupportTriageService("retention", env, port.post), {
      exitCode: 1,
      outcome: "refused_to_start",
      ...expected,
    });
    assert.equal(port.calls.length, 0);
  }
  // A refusal names variables, never values.
  const leaked = await runSupportTriageService("retention", { ...ENV, OTHER: "secret-value-here" }, answering(200, {}).post);
  assert.ok(!JSON.stringify(leaked).includes("secret-value-here"));
  const dev = answering(200, { result: "ok" });
  assert.deepEqual(await runSupportTriageService("retention", { ...ENV, RAILWAY_ENVIRONMENT_NAME: "dev" }, dev.post), {
    exitCode: 1,
    outcome: "destination_unknown",
  });
  assert.equal(dev.calls.length, 0);
});

test("the names measured in the deployed Agents image are accepted", async () => {
  // Measured 2026-10-03 (lib/productResearchObservationRunnerCore.mjs).
  for (const kind of SUPPORT_TRIAGE_SERVICE_KINDS) {
    const image = {
      ...envFor(kind),
      CI: "true",
      NEXT_TELEMETRY_DISABLED: "1",
      SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
      SSL_CERT_DIR: "/etc/ssl/certs",
      RAILPACK_PACKAGES: "node@22",
      MISE_DATA_DIR: "/mise",
      __MISE_ORIG_PATH: "/usr/bin",
      HOME: "/root",
      NODE_VERSION: "22",
      RAILWAY_SERVICE_NAME: "Support Triage",
      // Named by the retention service's refusal on 2026-10-09, the first
      // time it ran on Railway.
      NPM_CONFIG_FETCH_RETRIES: "5",
      NPM_CONFIG_FUND: "false",
      NPM_CONFIG_PRODUCTION: "false",
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
      RAILWAY_BETA_ENABLE_RUNTIME_V2: "1",
    };
    assert.deepEqual(
      await runSupportTriageService(kind, image, answering(200, { result: "ok" }).post),
      { exitCode: 0, outcome: "ran", result: "ok" },
      kind
    );
  }
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

for (const kind of SUPPORT_TRIAGE_SERVICE_KINDS) {
  for (const [label, script] of Object.entries(CHILDREN)) {
    test(`${kind}: the supervisor kills ${label} at its deadline and exits 1`, async () => {
      const logs = [];
      const started = Date.now();
      const code = await superviseSupportTriageService({
        kind,
        env: envFor(kind),
        deadlineMs: 500,
        log: (line) => logs.push(line),
        spawnChild: () => spawn(process.execPath, [script], { stdio: "ignore" }),
      });
      assert.equal(code, 1);
      assert.ok(Date.now() - started < 5_000, String(Date.now() - started));
      assert.ok(logs.some((line) => line.includes('"deadline_killed"')), logs.join("\n"));
    });
  }
}

test("the supervisor passes a finished child's exit code through, and starts no child when refused", async () => {
  const exitsTwo = fixture("exit-two.mjs", "process.exit(2);\n");
  assert.equal(
    await superviseSupportTriageService({
      kind: "worker",
      env: envFor("worker"),
      deadlineMs: 5_000,
      log: () => {},
      spawnChild: () => spawn(process.execPath, [exitsTwo], { stdio: "ignore" }),
    }),
    2
  );
  let spawned = false;
  assert.equal(
    await superviseSupportTriageService({
      kind: "worker",
      env: { ...envFor("worker"), DATABASE_URL: "postgres://x" },
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
