import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertQaReleaseMonitorEndpoint,
  qaReleaseMonitorEndpoint,
} from "../lib/qaReleaseDigestEndpointCore.ts";
import { runQaReleaseMonitorService } from "../lib/qaReleaseMonitorServiceCore.ts";

const env = (overrides = {}) => ({
  PATH: "/usr/bin",
  RAILWAY_ENVIRONMENT_NAME: "production",
  QA_RELEASE_MONITOR_SECRET: "m".repeat(40),
  QA_RELEASE_CONTROL_REVISION: "5",
  ...overrides,
});

const ports = (answer) => {
  const calls = [];
  return {
    calls,
    postJson: async (url, headers) => {
      calls.push({ url, headers });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
};

test("the Monitor calls its one fixed destination with its secret and the control revision", async () => {
  const p = ports({ status: 200, body: { verdict: "stale", alerted: true } });
  assert.deepEqual(await runQaReleaseMonitorService(env(), p), { exitCode: 0, outcome: "checked", verdict: "stale" });
  assert.deepEqual(p.calls, [{
    url: "https://tomverse.app/api/internal/agents/qa-release/monitor",
    headers: { authorization: `Bearer ${"m".repeat(40)}`, "x-qa-release-control-revision": "5" },
  }]);
});

test("a foreign variable or no Railway name stops it before any call", async () => {
  for (const [overrides, outcome] of [[{ DATABASE_URL: "postgres://x" }, "refused_to_start"], [{ RAILWAY_ENVIRONMENT_NAME: "pr-12" }, "destination_unknown"]]) {
    const p = ports({ status: 200, body: { verdict: "fresh" } });
    assert.deepEqual(await runQaReleaseMonitorService(env(overrides), p), { exitCode: 1, outcome });
    assert.equal(p.calls.length, 0);
  }
});

test("a refusal, a failure or an answer without a known verdict fails the run once", async () => {
  assert.deepEqual(await runQaReleaseMonitorService(env(), ports({ status: 409, body: { error: "control_revision_mismatch" } })), {
    exitCode: 1, outcome: "check_refused", status: 409,
  });
  assert.deepEqual(await runQaReleaseMonitorService(env(), ports({ status: 503, body: { error: "monitor_read_failed" } })), {
    exitCode: 1, outcome: "check_outcome_unknown", status: 503,
  });
  assert.deepEqual(await runQaReleaseMonitorService(env(), ports({ status: 200, body: { verdict: "maybe" } })), {
    exitCode: 1, outcome: "check_outcome_unknown", status: 200,
  });
  assert.deepEqual(await runQaReleaseMonitorService(env(), ports(new Error("timeout"))), {
    exitCode: 1, outcome: "check_outcome_unknown",
  });
});

test("the Monitor destination is exactly one origin plus its path", () => {
  assert.equal(qaReleaseMonitorEndpoint({ RAILWAY_ENVIRONMENT_NAME: "staging" }), "https://staging.tomverse.app/api/internal/agents/qa-release/monitor");
  for (const bad of [
    "https://tomverse.app/api/internal/agents/qa-release/digest",
    "https://tomverse.app/api/internal/agents/qa-release/monitor/../monitor",
    "http://tomverse.app/api/internal/agents/qa-release/monitor",
  ]) {
    assert.throws(() => assertQaReleaseMonitorEndpoint(bad), /not_allowed|invalid/, bad);
  }
});

test("the entry follows no redirect, times out, and imports only its core", () => {
  const source = readFileSync(new URL("../scripts/qa-release-monitor-service.mjs", import.meta.url), "utf8");
  assert.deepEqual([...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]), ["../lib/qaReleaseMonitorServiceCore.ts"]);
  assert.match(source, /redirect: "error"/);
  assert.match(source, /signal: AbortSignal\.timeout\(/);
  // Never shorter than the route's own round budget, or an in-budget round
  // would end as an unknown outcome on this side.
  const number = (text, name) => Number(new RegExp(`const ${name} = ([0-9_]+);`).exec(text)?.[1].replaceAll("_", ""));
  const route = readFileSync(new URL("../lib/qaReleaseMonitor.ts", import.meta.url), "utf8");
  assert.ok(number(source, "HTTP_TIMEOUT_MS") > number(route, "MONITOR_ROUND_BUDGET_MS"));
});
