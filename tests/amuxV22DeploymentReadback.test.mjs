import assert from "node:assert/strict";
import test from "node:test";

import { readAmuxV22DeploymentOutcome } from
  "../lib/amux/v22DeploymentReadback.ts";

const deploymentId = "00000000-0000-4000-8000-000000000001";
const commitSha = "a".repeat(40);
const input = { deploymentId, commitSha, environment: "staging" };
const active = { id: deploymentId, commitSha, status: "SUCCESS" };
const sample = { deploymentId, commitSha, deploymentStatus: "success" };
const observation = { controlPlane: [active],
  buildInfo: Array.from({ length: 5 }, () => sample), ready: [] };

test("deployment readback confirms only one exact serving deployment and fresh samples", async () => {
  let observedEnvironment = null;
  const result = await readAmuxV22DeploymentOutcome(input, async (environment) => {
    observedEnvironment = environment;
    return observation;
  });
  assert.equal(observedEnvironment, "staging");
  assert.deepEqual(result, { status: "confirmed", reference: deploymentId });
});

test("missing, drifted or incomplete deployment evidence stays unknown", async () => {
  const variants = [
    { ...observation, controlPlane: null },
    { ...observation, controlPlane: [active, { ...active, id: "other" }] },
    { ...observation, controlPlane: Array.from({ length: 10 }, () => active) },
    { ...observation, controlPlane: [{ ...active, commitSha: "b".repeat(40) }] },
    { ...observation, buildInfo: observation.buildInfo.slice(1) },
    { ...observation, buildInfo: [null, ...observation.buildInfo.slice(1)] },
    { ...observation, buildInfo: [{ ...sample, deploymentId: "other" },
      ...observation.buildInfo.slice(1)] },
  ];
  for (const value of variants) {
    const result = await readAmuxV22DeploymentOutcome(input, async () => value);
    assert.equal(result.status, "outcome_unknown");
  }
  assert.equal((await readAmuxV22DeploymentOutcome(input,
    async () => { throw new Error("offline"); })).status, "outcome_unknown");
});

test("production additionally requires every fresh readiness sample", async () => {
  const production = { ...input, environment: "production" };
  assert.equal((await readAmuxV22DeploymentOutcome(production,
    async () => observation)).status, "outcome_unknown");
  assert.deepEqual(await readAmuxV22DeploymentOutcome(production,
    async () => ({ ...observation, ready: [true, true, true, true, true] })),
  { status: "confirmed", reference: deploymentId });
});

test("invalid binding avoids the deployment probe", async () => {
  let calls = 0;
  const result = await readAmuxV22DeploymentOutcome({ ...input,
    commitSha: "invalid" }, async () => { calls += 1; return observation; });
  assert.deepEqual(result, { status: "outcome_unknown", reason: "invalid_binding" });
  assert.equal(calls, 0);
});
