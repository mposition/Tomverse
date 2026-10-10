import assert from "node:assert/strict";
import test from "node:test";

import { readPromptRefinerProductStatus } from
  "@/lib/promptRefinerProductStatus";

const commitSha = "a".repeat(40);
const deploymentId = "123e4567-e89b-42d3-a456-426614174000";
const observedAt = Date.parse("2026-10-10T02:00:00.000Z");
const base = {
  env: {
    RAILWAY_GIT_COMMIT_SHA: commitSha,
    RAILWAY_DEPLOYMENT_ID: deploymentId,
  },
  now: () => observedAt,
};

test("verified capability stays distinct from rollout and pending Router gates", async () => {
  const snapshot = await readPromptRefinerProductStatus({
    ...base,
    readRollout: async () => true,
    readRelease: async () => Object.freeze({
      explicitEnabled: true,
      autoEnabled: false,
      runtimeCommitSha: commitSha,
      runtimeDeploymentId: deploymentId,
      approvalAuditLogId: "approval-audit-1",
    }),
  });
  assert.equal(snapshot.observedAt, "2026-10-10T02:00:00.000Z");
  assert.deepEqual(snapshot.controls, {
    rollout: "enabled", killSwitchEngaged: false,
  });
  assert.deepEqual(snapshot.release, {
    state: "verified",
    explicitEnabled: true,
    autoEnabled: false,
    approvalAuditLogId: "approval-audit-1",
  });
  assert.equal(snapshot.router.ready, false);
  assert.deepEqual(snapshot.router.outstanding, [
    "shadow_report",
    "offline_quality_evaluation",
    "attempt_manifest_boundary",
  ]);
  assert.equal(snapshot.completionClaim,
    "not_established_by_status_readback");
});

test("stored rollout alone never becomes verified product capability", async () => {
  const snapshot = await readPromptRefinerProductStatus({
    ...base,
    readRollout: async () => true,
    readRelease: async () => Object.freeze({
      explicitEnabled: false,
      autoEnabled: false,
      runtimeCommitSha: null,
      runtimeDeploymentId: null,
      approvalAuditLogId: null,
    }),
  });
  assert.equal(snapshot.controls.rollout, "enabled");
  assert.deepEqual(snapshot.release, {
    state: "closed_or_unavailable",
    explicitEnabled: null,
    autoEnabled: null,
    approvalAuditLogId: null,
  });
});

test("kill switch and unknown reads stay explicit without calling release", async () => {
  let releaseReads = 0;
  const killed = await readPromptRefinerProductStatus({
    ...base,
    env: { ...base.env, PROMPT_REFINER_KILL_SWITCH: "1" },
    readRelease: async () => {
      releaseReads += 1;
      throw new Error("must not read");
    },
  });
  assert.equal(killed.controls.rollout, "unknown");
  assert.equal(killed.release.state, "blocked_by_kill_switch");
  assert.equal(killed.release.explicitEnabled, false);
  assert.equal(releaseReads, 0);

  const unknown = await readPromptRefinerProductStatus({
    ...base,
    readRollout: async () => { throw new Error("database unavailable"); },
    readRelease: async () => {
      releaseReads += 1;
      throw new Error("must not read");
    },
  });
  assert.equal(unknown.controls.rollout, "unknown");
  assert.equal(unknown.release.state, "unavailable");
  assert.equal(unknown.release.explicitEnabled, null);
  assert.equal(releaseReads, 0);
});

test("a release for any other runtime identity is unavailable", async () => {
  const snapshot = await readPromptRefinerProductStatus({
    ...base,
    readRollout: async () => true,
    readRelease: async () => Object.freeze({
      explicitEnabled: true,
      autoEnabled: true,
      runtimeCommitSha: "b".repeat(40),
      runtimeDeploymentId: deploymentId,
      approvalAuditLogId: "approval-audit-1",
    }),
  });
  assert.equal(snapshot.serving.exactProductIdentity, true);
  assert.equal(snapshot.release.state, "unavailable");
  assert.equal(snapshot.release.approvalAuditLogId, null);
});
