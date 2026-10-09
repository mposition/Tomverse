import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BILLING_FINANCE_OPS_RUN_ENDPOINTS,
  billingFinanceOpsSignalUrlUsable,
  runBillingFinanceOpsService,
} from "../lib/billingFinanceOpsServiceCore.ts";

// docs/policy/billing-finance-ops.md §1.3 signal 1: the trigger signals the
// dead-man monitor only when the app answered that today's digest exists or
// that the operator switched the agent off.

const ENV = {
  BILLING_FINANCE_OPS_AGENT_ENABLED: "1",
  BILLING_FINANCE_OPS_RUN_SECRET: "r".repeat(40),
  BILLING_FINANCE_OPS_DEADMAN_URL: "https://monitor.example.invalid/ping/abc",
  RAILWAY_ENVIRONMENT_NAME: "staging",
  PATH: "/usr/bin",
};

const ports = (answer) => {
  const calls = { post: [], signal: [] };
  return {
    calls,
    post: async (url, headers) => {
      calls.post.push({ url, headers });
      if (answer instanceof Error) throw answer;
      return answer;
    },
    signal: async (url) => {
      calls.signal.push(url);
      return { status: 200 };
    },
  };
};

test("today's digest or the operator's off signals once; the route is the fixed one for the environment", async () => {
  for (const [result, status] of [["created", 201], ["replayed", 200], ["conflict", 409], ["disabled", 200]]) {
    const p = ports({ status, body: { result } });
    assert.deepEqual(await runBillingFinanceOpsService(ENV, p), { exitCode: 0, outcome: "ran", result, signalled: true });
    assert.deepEqual(p.calls.signal, [ENV.BILLING_FINANCE_OPS_DEADMAN_URL]);
    assert.equal(p.calls.post[0].url, BILLING_FINANCE_OPS_RUN_ENDPOINTS.staging);
    assert.deepEqual(p.calls.post[0].headers, { authorization: `Bearer ${ENV.BILLING_FINANCE_OPS_RUN_SECRET}` });
  }
});

test("every other answer, a wrong status for a code, an exception or garbage sends no signal", async () => {
  const silent = [
    { status: 401, body: { result: "unauthorized" } },
    { status: 503, body: { result: "control_unreadable" } },
    { status: 409, body: { result: "deadline_exceeded" } },
    { status: 422, body: { result: "refused" } },
    { status: 500, body: { result: "internal_error" } },
    { status: 200, body: { result: "created" } },
    { status: 201, body: { result: "disabled" } },
  ];
  for (const answer of silent) {
    const p = ports(answer);
    const outcome = await runBillingFinanceOpsService(ENV, p);
    assert.equal(outcome.exitCode, 1, JSON.stringify(answer));
    assert.equal(p.calls.signal.length, 0, JSON.stringify(answer));
  }
  for (const answer of [new Error("timeout"), { status: 200, body: null }, { status: 200, body: { result: "fresh" } }]) {
    const p = ports(answer);
    assert.equal((await runBillingFinanceOpsService(ENV, p)).outcome, "run_outcome_unknown");
    assert.equal(p.calls.signal.length, 0);
  }
});

test("a failed signal is an exit 1, not a retry", async () => {
  let signals = 0;
  const outcome = await runBillingFinanceOpsService(ENV, {
    post: async () => ({ status: 201, body: { result: "created" } }),
    signal: async () => {
      signals += 1;
      return { status: 500 };
    },
  });
  assert.deepEqual(outcome, { exitCode: 1, outcome: "ran", result: "created", signalled: false, signal: "failed" });
  assert.equal(signals, 1);
});

test("start refuses an unknown variable name, a short secret or an unusable signal URL; unset deployment calls nothing", async () => {
  const p = ports({ status: 201, body: { result: "created" } });
  assert.equal((await runBillingFinanceOpsService({ ...ENV, DATABASE_URL: "postgres://x" }, p)).outcome, "refused_to_start");
  assert.equal((await runBillingFinanceOpsService({ ...ENV, BILLING_FINANCE_OPS_RUN_SECRET: "short" }, p)).outcome, "refused_to_start");
  assert.equal((await runBillingFinanceOpsService({ ...ENV, BILLING_FINANCE_OPS_DEADMAN_URL: "http://x.invalid" }, p)).outcome, "refused_to_start");
  assert.deepEqual(await runBillingFinanceOpsService({ ...ENV, BILLING_FINANCE_OPS_AGENT_ENABLED: "" }, p), {
    exitCode: 0,
    outcome: "not_deployed",
  });
  assert.equal((await runBillingFinanceOpsService({ ...ENV, RAILWAY_ENVIRONMENT_NAME: "development" }, p)).outcome, "destination_unknown");
  assert.equal(p.calls.post.length, 0);
  assert.equal(p.calls.signal.length, 0);
});

test("the names the deployed image provides do not stop the trigger", async () => {
  // Read in a live Railway container on 2026-10-09 (names only). The first
  // scheduled runs that day, staging and production, refused on these.
  const image = {
    CI: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    NPM_CONFIG_FETCH_RETRIES: "5",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_PRODUCTION: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    RAILPACK_BUILT_AT: "x",
    RAILPACK_VERSION: "x",
    MISE_CACHE_DIR: "/mise/cache",
    MISE_CONFIG_DIR: "/mise",
    MISE_DATA_DIR: "/mise",
    MISE_INSTALLS_DIR: "/mise/installs",
    MISE_SHIMS_DIR: "/mise/shims",
    RAILWAY_BETA_ENABLE_RUNTIME_V2: "1",
    HOME: "/root",
    NODE_VERSION: "22",
    RAILWAY_SERVICE_NAME: "Billing Finance Ops Deadline",
  };
  const p = ports({ status: 201, body: { result: "created" } });
  assert.deepEqual(await runBillingFinanceOpsService({ ...ENV, ...image }, p), {
    exitCode: 0,
    outcome: "ran",
    result: "created",
    signalled: true,
  });
  // A name in the same family that was not measured still stops it.
  assert.equal((await runBillingFinanceOpsService({ ...ENV, ...image, NPM_CONFIG__AUTH: "x" }, p)).outcome, "refused_to_start");
});

test("the signal URL must be https without credentials", () => {
  assert.equal(billingFinanceOpsSignalUrlUsable("https://hc.example.invalid/ping/1"), true);
  assert.equal(billingFinanceOpsSignalUrlUsable("http://hc.example.invalid/ping/1"), false);
  assert.equal(billingFinanceOpsSignalUrlUsable("https://user:pw@hc.example.invalid/"), false);
  assert.equal(billingFinanceOpsSignalUrlUsable("not a url"), false);
});

test("the entry point bounds the run at 90 s, the call at 70 s and the signal at 10 s, and prints no secret", () => {
  const source = readFileSync("scripts/billing-finance-ops-trigger-service.mjs", "utf8");
  assert.match(source, /HARD_TIMEOUT_MS = 90_000/);
  assert.match(source, /RUN_TIMEOUT_MS = 70_000/);
  assert.match(source, /SIGNAL_TIMEOUT_MS = 10_000/);
  assert.equal((source.match(/redirect: "error"/g) ?? []).length, 2);
  const code = source.replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /console\.log\([^)]*(secret|SECRET|DEADMAN|url|headers)/);
});
