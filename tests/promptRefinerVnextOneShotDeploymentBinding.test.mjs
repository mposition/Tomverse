import assert from "node:assert/strict";
import test from "node:test";

import { assertPromptRefinerVnextOneShotActiveDeploymentForAdmission } from
  "../lib/promptRefinerVnextOneShotDeploymentBinding.ts";

const deploymentId = "12345678-1234-1234-1234-123456789abc";
const commitSha = "a".repeat(40);
const environment = {
  RAILWAY_ENVIRONMENT_NAME: "staging",
  RAILWAY_DEPLOYMENT_ID: deploymentId,
  RAILWAY_GIT_COMMIT_SHA: commitSha,
  RAILWAY_PROJECT_ID: "22345678-1234-1234-1234-123456789abc",
  RAILWAY_SERVICE_ID: "32345678-1234-1234-1234-123456789abc",
  RAILWAY_ENVIRONMENT_ID: "42345678-1234-1234-1234-123456789abc",
  RAILWAY_API_TOKEN: "synthetic-token",
};
const approvedStage = {
  id: "prompt-refiner-vnext-one-shot-v4",
  status: "run_approved",
  runtimeDeploymentId: deploymentId,
  runtimeCommitSha: commitSha,
};

function transaction(rows = [approvedStage]) {
  let calls = 0;
  return {
    get calls() { return calls; },
    $queryRaw: async (sql, ...values) => {
      calls++;
      assert.match(sql.join("?"), /FOR NO KEY UPDATE NOWAIT/);
      assert.deepEqual(values, [approvedStage.id]);
      return rows;
    },
  };
}

function railway(deployment = { id: deploymentId, status: "SUCCESS",
  meta: { commitHash: commitSha } }, active = { id: deploymentId, status: "SUCCESS" }) {
  return async () => ({ ok: true, json: async () => ({
    data: { deployment, deployments: { edges: [{ node: active }] } },
  }) });
}

const check = (tx, overrides = {}) =>
  assertPromptRefinerVnextOneShotActiveDeploymentForAdmission(tx, {
    environment,
    fetchImpl: railway(),
    ...overrides,
  });

test("admission rereads the locked approved row and exact active Railway deployment", async () => {
  const tx = transaction();
  assert.equal(await check(tx), undefined);
  assert.equal(await check(tx), undefined);
  assert.equal(tx.calls, 2);
});

test("missing, closed or malformed approval fails before Railway lookup", async () => {
  for (const [rows, code] of [
    [[], "vnext_one_shot_approved_stage_unavailable"],
    [[{ ...approvedStage, status: "closed" }], "vnext_one_shot_approved_stage_inactive"],
    [[{ ...approvedStage, runtimeCommitSha: "invalid" }],
      "vnext_one_shot_approved_deployment_invalid"],
  ]) {
    let fetches = 0;
    await assert.rejects(
      () => check(transaction(rows), { fetchImpl: async () => { fetches++; throw Error("unexpected"); } }),
      { message: code },
    );
    assert.equal(fetches, 0);
  }
});

test("an approved ID or commit different from the active deployment is refused", async () => {
  for (const change of [
    { runtimeDeploymentId: "52345678-1234-1234-1234-123456789abc" },
    { runtimeCommitSha: "b".repeat(40) },
  ]) {
    await assert.rejects(
      () => check(transaction([{ ...approvedStage, ...change }])),
      { message: "vnext_one_shot_approved_deployment_mismatch" },
    );
  }
});

test("a replaced, pending or unverifiable active deployment is refused", async () => {
  for (const overrides of [
    { fetchImpl: railway(undefined, { id: "52345678-1234-1234-1234-123456789abc",
      status: "SUCCESS" }) },
    { fetchImpl: railway({ id: deploymentId, status: "WAITING",
      meta: { commitHash: commitSha } }) },
    { environment: { ...environment, RAILWAY_API_TOKEN: "" } },
    { fetchImpl: async () => { throw Error("private upstream details"); } },
  ]) {
    await assert.rejects(
      () => check(transaction(), overrides),
      { message: "vnext_one_shot_active_deployment_unverified" },
    );
  }
});

test("lock failure stops admission and is not retried", async () => {
  let calls = 0;
  const tx = { $queryRaw: async () => { calls++; throw Error("lock_not_available"); } };
  await assert.rejects(() => check(tx), { message: "lock_not_available" });
  assert.equal(calls, 1);
});
