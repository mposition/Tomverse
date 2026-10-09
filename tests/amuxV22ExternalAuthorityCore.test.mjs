import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_V22_WORKER_AUTHORITY_NOTICE,
  assertAmuxV22LocalCliTools,
  classifyAmuxV22DeploymentReadback,
  classifyAmuxV22PrReadback,
  decideAmuxV22ExternalAuthority,
} from "../lib/amux/v22ExternalAuthorityCore.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000001";

test("v22 workers and the app cannot publish, merge or deploy", () => {
  const writes = ["publish_develop_pr", "publish_main_pr", "merge_develop",
    "merge_main", "deploy_staging", "deploy_production"];
  for (const actor of ["v22_worker", "amux_app", "engineering_publisher"]) {
    for (const action of writes) {
      assert.equal(decideAmuxV22ExternalAuthority({ actor, action }).allowed,
        false, `${actor} ${action}`);
    }
    assert.deepEqual(decideAmuxV22ExternalAuthority({ actor,
      action: "publish_main_pr" }),
    { allowed: false, reason: "main_pr_owner_only" });
  }
  assert.match(AMUX_V22_WORKER_AUTHORITY_NOTICE, /Do not push/);
  assert.match(AMUX_V22_WORKER_AUTHORITY_NOTICE, /main PR/);
  assert.match(AMUX_V22_WORKER_AUTHORITY_NOTICE, /main merge/);
});

test("only the app can observe external PR and deployment state", () => {
  for (const action of ["observe_pr", "observe_deployment"]) {
    assert.equal(decideAmuxV22ExternalAuthority({ actor: "amux_app", action }).allowed,
      true);
    assert.equal(decideAmuxV22ExternalAuthority({ actor: "v22_worker", action }).allowed,
      false);
  }
});

test("one-shot tool roles reject command, network and duplicate capabilities", () => {
  assert.doesNotThrow(() => assertAmuxV22LocalCliTools("Read,Grep,Glob,Edit,Write"));
  for (const unsafe of ["Bash", "Read,Bash", "Read,WebFetch", "Read,mcp__github",
    "Read,Read", "Read, Write", ""]) {
    assert.throws(() => assertAmuxV22LocalCliTools(unsafe), /v22 CLI role/);
  }
});

test("a lost PR response requires exact unique branch/base/head readback", () => {
  const expected = { expectedBranch: "agent/engineering/run-1",
    expectedBaseSha: SHA_A, expectedHeadSha: SHA_B };
  const pr = { number: 42, branch: expected.expectedBranch,
    baseSha: SHA_A, headSha: SHA_B };
  assert.deepEqual(classifyAmuxV22PrReadback({ ...expected, observed: [pr] }),
    { status: "confirmed", reference: "42" });
  for (const observed of [null, [], [pr, pr],
    [{ ...pr, headSha: SHA_A }], [{ ...pr, baseSha: SHA_B }]]) {
    assert.equal(classifyAmuxV22PrReadback({ ...expected, observed }).status,
      "outcome_unknown");
  }
});

test("deployment readback never treats an absent or mismatched release as retryable", () => {
  const expected = { expectedDeploymentId: DEPLOYMENT_ID,
    expectedCommitSha: SHA_B, expectedEnvironment: "staging" };
  const row = { deploymentId: DEPLOYMENT_ID, commitSha: SHA_B,
    environment: "staging", status: "success" };
  assert.deepEqual(classifyAmuxV22DeploymentReadback({ ...expected, observed: row }),
    { status: "confirmed", reference: DEPLOYMENT_ID });
  for (const observed of [null, { ...row, status: "building" },
    { ...row, commitSha: SHA_A }, { ...row, environment: "production" },
    { ...row, deploymentId: "00000000-0000-4000-8000-000000000002" }]) {
    assert.equal(classifyAmuxV22DeploymentReadback({ ...expected, observed }).status,
      "outcome_unknown");
  }
});
