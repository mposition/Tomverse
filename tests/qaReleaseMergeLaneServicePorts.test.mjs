import assert from "node:assert/strict";
import test from "node:test";

import { qaReleaseMergeLaneEndpoint } from "../lib/qaReleaseDigestEndpointCore.ts";
import { createQaReleaseMergeLaneAppPorts } from "../lib/qaReleaseMergeLaneAppClient.ts";
import { QA_RELEASE_RAILWAY_API, createQaReleaseRailwayPorts } from "../lib/qaReleaseMergeLaneRailway.ts";

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const PROJECT = "0c5f17ad-a42a-4fa8-a245-bcd6a3275a35";
const STAGING = "11111111-2222-3333-4444-555555555555";
const SERVICE_A = "aaaaaaaa-0000-0000-0000-000000000001";
const SERVICE_B = "aaaaaaaa-0000-0000-0000-000000000002";
const json = (status, body) => ({ status, text: JSON.stringify(body) });

function recorder(answer) {
  const calls = [];
  return {
    calls,
    http: async (request) => {
      calls.push(request);
      return answer(request, calls.length);
    },
  };
}

// ---- Railway ---------------------------------------------------------------

function railway(overrides = {}) {
  return (request) => {
    const { query, variables } = JSON.parse(request.body);
    if (query.includes("projectToken")) return overrides.token ?? json(200, { data: { projectToken: { projectId: PROJECT, environmentId: STAGING } } });
    if (query.includes("environment(id")) {
      return overrides.environment ?? json(200, {
        data: {
          environment: {
            id: STAGING,
            name: "staging",
            serviceInstances: {
              edges: [
                { node: { serviceId: SERVICE_A, serviceName: "web", source: { repo: "mposition/Tomverse" } } },
                { node: { serviceId: SERVICE_B, serviceName: "Postgres", source: null } },
              ],
            },
          },
        },
      });
    }
    if (query.includes("deployments(")) {
      const node =
        variables.input.serviceId === SERVICE_A
          ? { id: "d1", status: "SUCCESS", createdAt: "2026-10-05T00:00:00Z", meta: { commitHash: MERGE, branch: "develop" } }
          : { id: "d2", status: "SUCCESS", createdAt: "2026-10-01T00:00:00Z", meta: null };
      return json(200, { data: { deployments: { edges: [{ node }] } } });
    }
    return json(400, {});
  };
}

test("Railway: every staging service's deployments, read with the project token header", async () => {
  const { http, calls } = recorder(railway());
  const deployments = await createQaReleaseRailwayPorts({ http, token: "rw_test" }).stagingDeployments();
  assert.deepEqual(deployments, [
    { serviceId: SERVICE_A, serviceName: "web", status: "SUCCESS", createdAt: "2026-10-05T00:00:00Z", meta: { commitHash: MERGE, branch: "develop" } },
    { serviceId: SERVICE_B, serviceName: "Postgres", status: "SUCCESS", createdAt: "2026-10-01T00:00:00Z", meta: { commitHash: undefined, branch: undefined } },
  ]);
  for (const call of calls) {
    assert.equal(call.url, QA_RELEASE_RAILWAY_API);
    assert.equal(call.method, "POST");
    assert.equal(call.headers["project-access-token"], "rw_test");
    assert.equal(call.headers.authorization, undefined);
    assert.doesNotMatch(JSON.parse(call.body).query, /mutation/);
  }
  const listCall = JSON.parse(calls.at(-1).body);
  assert.deepEqual(listCall.variables, { input: { projectId: PROJECT, environmentId: STAGING, serviceId: SERVICE_B }, first: 25 });
});

test("Railway: another environment, no service from this repository, errors or odd shapes all read as null", async () => {
  const production = { data: { environment: { id: STAGING, name: "production", serviceInstances: { edges: [] } } } };
  const foreign = { data: { environment: { id: STAGING, name: "staging", serviceInstances: { edges: [{ node: { serviceId: SERVICE_A, serviceName: "x", source: { repo: "other/repo" } } }] } } } };
  for (const overrides of [
    { environment: json(200, production) },
    { environment: json(200, foreign) },
    { token: json(200, { errors: [{ message: "Not Authorized" }] }) },
    { token: json(401, {}) },
    { token: json(200, { data: { projectToken: { projectId: "nope", environmentId: STAGING } } }) },
    { token: { status: 200, text: "<html>" } },
  ]) {
    const { http } = recorder(railway(overrides));
    assert.equal(await createQaReleaseRailwayPorts({ http, token: "t" }).stagingDeployments(), null);
  }
  const thrown = createQaReleaseRailwayPorts({ http: async () => { throw new Error("timeout"); }, token: "t" });
  assert.equal(await thrown.stagingDeployments(), null);
});

// ---- App -------------------------------------------------------------------

const ENV = {
  RAILWAY_ENVIRONMENT_NAME: "production",
  QA_RELEASE_MERGE_LANE_SECRET: "lane-secret",
  QA_RELEASE_CONTROL_REVISION: " 3 ",
};

const appPorts = (answer) => {
  const rec = recorder(answer);
  return { ...rec, app: createQaReleaseMergeLaneAppPorts({ http: rec.http, env: ENV }) };
};

test("App: each call goes to its fixed URL with the lane secret and the revision", async () => {
  const { app, calls } = appPorts((request) => {
    if (request.url.endsWith("/state")) return json(200, { dbNowMs: 5, latched: false, openAttempt: null });
    if (request.url.endsWith("/instruction")) return json(200, { issued: true, attemptId: "att_1", controlRevision: 3, expiresAt: "x" });
    if (request.url.endsWith("/consume")) return json(200, { consumed: true });
    return json(200, { recorded: true, moved: true, latched: null, revisionMatched: true });
  });
  assert.deepEqual(await app.readState(), { dbNowMs: 5, latched: false, openAttempt: null });
  assert.deepEqual(await app.issue({ pullRequestNumber: 12, headSha: HEAD }), { issued: true, attemptId: "att_1" });
  assert.deepEqual(await app.consume({ attemptId: "att_1", pullRequestNumber: 12, headSha: HEAD, base: "develop" }), { consumed: true });
  assert.deepEqual(await app.report("att_1", { kind: "unreported" }), { recorded: true });
  assert.deepEqual(calls.map((call) => call.url), ["state", "instruction", "consume", "report"].map((name) => qaReleaseMergeLaneEndpoint(ENV, name)));
  assert.equal(calls[0].url, "https://tomverse.app/api/internal/agents/qa-release/merge-lane/state");
  for (const call of calls) {
    assert.equal(call.method, "POST");
    assert.equal(call.headers.authorization, "Bearer lane-secret");
    assert.equal(call.headers["x-qa-release-control-revision"], "3");
  }
  assert.deepEqual(JSON.parse(calls[3].body), { attemptId: "att_1", report: { kind: "unreported" } });
});

test("App: a 409 refusal is an answer; a 5xx, a late round or a wrong shape is thrown as unknown", async () => {
  const refused = appPorts((request) =>
    request.url.endsWith("/instruction")
      ? json(409, { issued: false, reason: "lane_switch_off" })
      : request.url.endsWith("/consume")
        ? json(409, { consumed: false, reason: "expired" })
        : json(409, { recorded: false, reason: "attempt_not_open" }),
  ).app;
  assert.deepEqual(await refused.issue({ pullRequestNumber: 1, headSha: HEAD }), { issued: false, reason: "lane_switch_off" });
  assert.deepEqual(await refused.consume({ attemptId: "a", pullRequestNumber: 1, headSha: HEAD, base: "develop" }), { consumed: false, reason: "expired" });
  assert.deepEqual(await refused.report("a", { kind: "unreported" }), { recorded: false, reason: "attempt_not_open" });

  for (const answer of [json(503, { error: "deadline_passed" }), json(500, {}), json(401, {}), json(200, { issued: "yes" }), { status: 200, text: "<html>" }]) {
    const { app } = appPorts(() => answer);
    await assert.rejects(app.issue({ pullRequestNumber: 1, headSha: HEAD }));
    await assert.rejects(app.readState());
  }
  const unnamed = createQaReleaseMergeLaneAppPorts({ http: async () => json(200, {}), env: { ...ENV, RAILWAY_ENVIRONMENT_NAME: "development" } });
  await assert.rejects(unnamed.readState(), /qa_release_digest_environment_unknown/);
});

test("App: the state read is validated, including the merge commit an attempt awaiting deploy must carry", async () => {
  const attempt = { id: "att_1", state: "awaiting_deploy", pullRequestNumber: 12, headSha: HEAD, mergeCommitSha: MERGE, issuedAtMs: 1, mergeNotBeforeMs: 2 };
  const ok = appPorts(() => json(200, { dbNowMs: 9, latched: true, openAttempt: attempt })).app;
  assert.deepEqual(await ok.readState(), { dbNowMs: 9, latched: true, openAttempt: attempt });
  for (const bad of [
    { ...attempt, mergeCommitSha: null },
    { ...attempt, state: "closed" },
    { ...attempt, headSha: "x" },
    { ...attempt, issuedAtMs: "1" },
  ]) {
    const { app } = appPorts(() => json(200, { dbNowMs: 9, latched: false, openAttempt: bad }));
    await assert.rejects(app.readState(), /app_shape/);
  }
});

test("the entry script stops itself at the 10-minute hard timeout (policy section 10)", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../scripts/qa-release-merge-lane-service.mjs", import.meta.url), "utf8");
  assert.match(source, /const HARD_TIMEOUT_MS = 10 \* 60 \* 1000;/);
  assert.match(source, /setTimeout\(\(\) => \{\s*console\.log\(JSON\.stringify\(\{ exitCode: 1, outcome: "hard_timeout" \}\)\);\s*process\.exit\(1\);\s*\}, HARD_TIMEOUT_MS\)/);
  // Armed before any port is built, so no call can outlive it.
  assert.ok(source.indexOf("const supervisor = setTimeout") < source.indexOf("await runQaReleaseMergeLaneRound"));
  const { QA_RELEASE_RESULT_SILENCE_MS } = await import("../lib/qaReleaseMergeLaneServiceCore.ts");
  assert.ok(10 * 60 * 1000 < QA_RELEASE_RESULT_SILENCE_MS);
});
