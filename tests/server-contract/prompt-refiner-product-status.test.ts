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

test("recorded capability stays distinct from admission and pending Router gates", async () => {
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
    state: "recorded",
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

test("stored rollout alone never becomes recorded product capability", async () => {
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

test("runtime, release, approval and genuine rollout-off boundaries are explicit", async (t) => {
  const cases = [
    {
      name: "missing runtime commit",
      env: { RAILWAY_DEPLOYMENT_ID: deploymentId },
      readRollout: async () => true,
      readRelease: undefined,
      expectedState: "runtime_identity_unavailable",
      expectedRollout: "enabled",
    },
    {
      name: "non-UUID runtime deployment",
      env: { RAILWAY_GIT_COMMIT_SHA: commitSha,
        RAILWAY_DEPLOYMENT_ID: "deployment-not-a-uuid" },
      readRollout: async () => true,
      readRelease: undefined,
      expectedState: "runtime_identity_unavailable",
      expectedRollout: "enabled",
    },
    {
      name: "overlong runtime deployment",
      env: { RAILWAY_GIT_COMMIT_SHA: commitSha,
        RAILWAY_DEPLOYMENT_ID: "d".repeat(129) },
      readRollout: async () => true,
      readRelease: undefined,
      expectedState: "runtime_identity_unavailable",
      expectedRollout: "enabled",
    },
    {
      name: "release read failure",
      env: base.env,
      readRollout: async () => true,
      readRelease: async () => { throw new Error("release unavailable"); },
      expectedState: "unavailable",
      expectedRollout: "enabled",
    },
    {
      name: "invalid approval audit id",
      env: base.env,
      readRollout: async () => true,
      readRelease: async () => Object.freeze({
        explicitEnabled: true,
        autoEnabled: false,
        runtimeCommitSha: commitSha,
        runtimeDeploymentId: deploymentId,
        approvalAuditLogId: "",
      }),
      expectedState: "unavailable",
      expectedRollout: "enabled",
    },
    {
      name: "overlong approval audit id",
      env: base.env,
      readRollout: async () => true,
      readRelease: async () => Object.freeze({
        explicitEnabled: true,
        autoEnabled: false,
        runtimeCommitSha: commitSha,
        runtimeDeploymentId: deploymentId,
        approvalAuditLogId: "a".repeat(129),
      }),
      expectedState: "unavailable",
      expectedRollout: "enabled",
    },
    {
      name: "release recorded for another commit",
      env: base.env,
      readRollout: async () => true,
      readRelease: async () => Object.freeze({
        explicitEnabled: true,
        autoEnabled: true,
        runtimeCommitSha: "b".repeat(40),
        runtimeDeploymentId: deploymentId,
        approvalAuditLogId: "approval-audit-1",
      }),
      expectedState: "unavailable",
      expectedRollout: "enabled",
    },
    {
      name: "release recorded for another deployment",
      env: base.env,
      readRollout: async () => true,
      readRelease: async () => Object.freeze({
        explicitEnabled: true,
        autoEnabled: true,
        runtimeCommitSha: commitSha,
        runtimeDeploymentId: "223e4567-e89b-42d3-a456-426614174000",
        approvalAuditLogId: "approval-audit-1",
      }),
      expectedState: "unavailable",
      expectedRollout: "enabled",
    },
    {
      name: "genuine stored rollout off",
      env: base.env,
      readRollout: async () => false,
      readRelease: undefined,
      expectedState: "disabled_by_rollout",
      expectedRollout: "disabled",
    },
  ] as const;

  for (const item of cases) {
    await t.test(item.name, async () => {
      let releaseReads = 0;
      const snapshot = await readPromptRefinerProductStatus({
        env: item.env,
        now: base.now,
        readRollout: item.readRollout,
        readRelease: item.readRelease ?? (async () => {
          releaseReads += 1;
          throw new Error("release must not be read");
        }),
      });
      assert.equal(snapshot.controls.rollout, item.expectedRollout);
      assert.equal(snapshot.release.state, item.expectedState);
      assert.equal(snapshot.release.approvalAuditLogId, null);
      if (item.expectedState === "runtime_identity_unavailable" ||
          item.expectedState === "disabled_by_rollout") {
        assert.equal(releaseReads, 0);
      }
    });
  }
});

test("E2E database-disabled mode is unknown rather than rollout off", async () => {
  const previous = {
    database: process.env.E2E_DISABLE_DATABASE,
    nextAuthUrl: process.env.NEXTAUTH_URL,
  };
  let rolloutReads = 0;
  process.env.E2E_DISABLE_DATABASE = "true";
  process.env.NEXTAUTH_URL = "http://127.0.0.1:3100";
  try {
    const snapshot = await readPromptRefinerProductStatus({
      ...base,
      readRollout: async () => {
        rolloutReads += 1;
        return false;
      },
    });
    assert.equal(rolloutReads, 0);
    assert.equal(snapshot.controls.rollout, "unknown");
    assert.equal(snapshot.release.state, "unavailable");
  } finally {
    if (previous.database === undefined) delete process.env.E2E_DISABLE_DATABASE;
    else process.env.E2E_DISABLE_DATABASE = previous.database;
    if (previous.nextAuthUrl === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = previous.nextAuthUrl;
  }
});
