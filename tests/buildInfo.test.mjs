import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  BUILD_ENVIRONMENTS,
  formatShortCommitSha,
  getPublicBuildInfo,
  mapRailwayDeploymentStatus,
  resetDeploymentTimelineCacheForTests,
  validateCommitSha,
  validateDeploymentTimestamp,
  validateEnvironment,
  validateIsoTimestamp,
} from "../lib/buildInfo.ts";

const withEnv = async (overrides, run) => {
  const original = {};
  for (const key of Object.keys(overrides)) {
    original[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return await run();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
};

// A fetch stub that never hits the network -- every test either supplies its
// own response or relies on RAILWAY_API_TOKEN being unset (the default in
// this suite) so resolveDeploymentTimeline short-circuits before ever
// calling fetch.
const jsonResponse = (body, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
});

const deploymentGraphqlResponse = ({
  id,
  status = "SUCCESS",
  createdAt,
  statusUpdatedAt,
  commitHash,
}) =>
  jsonResponse({
    data: {
      deployment: {
        id,
        status,
        createdAt,
        statusUpdatedAt,
        meta: commitHash ? { commitHash } : {},
      },
    },
  });

test("validateCommitSha accepts a full 40-char SHA", () => {
  const sha = "c12e84489559ed1320293e1cf8099dd17a7e80a6".slice(0, 40);
  assert.equal(validateCommitSha(sha), sha.toLowerCase());
});

test("validateCommitSha accepts a short 7-char SHA", () => {
  assert.equal(validateCommitSha("c12e844"), "c12e844");
});

test("validateCommitSha lowercases mixed-case input", () => {
  assert.equal(validateCommitSha("C12E844"), "c12e844");
});

test("validateCommitSha rejects malformed input", () => {
  assert.equal(validateCommitSha("not-a-sha"), null);
  assert.equal(validateCommitSha("abc"), null); // too short
  assert.equal(validateCommitSha(""), null);
  assert.equal(validateCommitSha(null), null);
  assert.equal(validateCommitSha(undefined), null);
  assert.equal(validateCommitSha(12345), null);
});

test("formatShortCommitSha takes the first 7 characters", () => {
  assert.equal(
    formatShortCommitSha("c12e84489559ed1320293e1cf8099dd17a7e80a6"),
    "c12e844"
  );
});

test("formatShortCommitSha passes through an already-short sha unchanged", () => {
  assert.equal(formatShortCommitSha("c12e844"), "c12e844");
});

test("formatShortCommitSha returns null for null input", () => {
  assert.equal(formatShortCommitSha(null), null);
});

test("validateIsoTimestamp accepts a real ISO 8601 timestamp", () => {
  assert.equal(
    validateIsoTimestamp("2026-07-25T04:21:10.000Z"),
    "2026-07-25T04:21:10.000Z"
  );
});

test("validateIsoTimestamp rejects invalid or missing timestamps", () => {
  assert.equal(validateIsoTimestamp("not a date"), null);
  assert.equal(validateIsoTimestamp(""), null);
  assert.equal(validateIsoTimestamp(null), null);
  assert.equal(validateIsoTimestamp(undefined), null);
  assert.equal(validateIsoTimestamp(12345), null);
});

test("validateEnvironment only accepts the allow-listed environment names", () => {
  for (const env of BUILD_ENVIRONMENTS) {
    assert.equal(validateEnvironment(env), env);
    assert.equal(validateEnvironment(env.toUpperCase()), env);
    assert.equal(validateEnvironment(`  ${env}  `), env);
  }
  assert.equal(validateEnvironment("prod"), null);
  assert.equal(validateEnvironment("stg"), null);
  assert.equal(validateEnvironment(""), null);
  assert.equal(validateEnvironment(null), null);
});

// -- AUD-R002: deployment timestamp validation --

test("validateDeploymentTimestamp accepts a plausible past timestamp", () => {
  const now = Date.parse("2026-07-26T13:36:04.051Z");
  assert.equal(
    validateDeploymentTimestamp("2026-07-26T13:33:25.691Z", now),
    "2026-07-26T13:33:25.691Z"
  );
});

test("validateDeploymentTimestamp rejects malformed timestamps", () => {
  assert.equal(validateDeploymentTimestamp("not a date"), null);
  assert.equal(validateDeploymentTimestamp(null), null);
  assert.equal(validateDeploymentTimestamp(undefined), null);
  assert.equal(validateDeploymentTimestamp(12345), null);
});

test("validateDeploymentTimestamp rejects a timestamp in the future", () => {
  const now = Date.parse("2026-07-26T13:36:04.051Z");
  const oneHourAhead = new Date(now + 60 * 60 * 1000).toISOString();
  assert.equal(validateDeploymentTimestamp(oneHourAhead, now), null);
});

test("validateDeploymentTimestamp rejects an implausibly old timestamp", () => {
  const now = Date.parse("2026-07-26T13:36:04.051Z");
  assert.equal(validateDeploymentTimestamp("2010-01-01T00:00:00.000Z", now), null);
});

test("mapRailwayDeploymentStatus classifies Railway's deployment statuses", () => {
  assert.equal(mapRailwayDeploymentStatus("SUCCESS"), "success");
  assert.equal(mapRailwayDeploymentStatus("BUILDING"), "in_progress");
  assert.equal(mapRailwayDeploymentStatus("DEPLOYING"), "in_progress");
  assert.equal(mapRailwayDeploymentStatus("QUEUED"), "in_progress");
  assert.equal(mapRailwayDeploymentStatus("FAILED"), "failed");
  assert.equal(mapRailwayDeploymentStatus("CRASHED"), "failed");
  assert.equal(mapRailwayDeploymentStatus("REMOVED"), "failed");
  assert.equal(mapRailwayDeploymentStatus("SOMETHING_NEW"), "unknown");
  assert.equal(mapRailwayDeploymentStatus(null), "unknown");
});

// -- AUD-R002: getPublicBuildInfo deployment timeline resolution --

test("getPublicBuildInfo prefers APP_ENV over RAILWAY_ENVIRONMENT_NAME", async () => {
  await withEnv(
    { APP_ENV: "staging", RAILWAY_ENVIRONMENT_NAME: "production" },
    async () => {
      assert.equal((await getPublicBuildInfo()).environment, "staging");
    }
  );
});

test("getPublicBuildInfo falls back to RAILWAY_ENVIRONMENT_NAME when APP_ENV is unset", async () => {
  await withEnv(
    { APP_ENV: undefined, RAILWAY_ENVIRONMENT_NAME: "staging" },
    async () => {
      assert.equal((await getPublicBuildInfo()).environment, "staging");
    }
  );
});

test("getPublicBuildInfo falls back to development when nothing identifies the environment", async () => {
  await withEnv(
    { APP_ENV: undefined, RAILWAY_ENVIRONMENT_NAME: undefined, NODE_ENV: undefined },
    async () => {
      assert.equal((await getPublicBuildInfo()).environment, "development");
    }
  );
});

test("getPublicBuildInfo prefers the live RAILWAY_GIT_COMMIT_SHA over any build-time fallback", async () => {
  await withEnv({ RAILWAY_GIT_COMMIT_SHA: "c12e844" }, async () => {
    const info = await getPublicBuildInfo();
    assert.equal(info.commitSha, "c12e844");
    assert.equal(info.shortCommitSha, "c12e844");
  });
});

test("getPublicBuildInfo ignores a malformed RAILWAY_GIT_COMMIT_SHA rather than returning garbage", async () => {
  await withEnv({ RAILWAY_GIT_COMMIT_SHA: "not-a-real-sha!!" }, async () => {
    const info = await getPublicBuildInfo();
    assert.notEqual(info.commitSha, "not-a-real-sha!!");
  });
});

test("getPublicBuildInfo reads deploymentId from RAILWAY_DEPLOYMENT_ID", async () => {
  await withEnv(
    { RAILWAY_DEPLOYMENT_ID: "staging-20260725-042436", RAILWAY_API_TOKEN: undefined },
    async () => {
      assert.equal((await getPublicBuildInfo()).deploymentId, "staging-20260725-042436");
    }
  );
});

test("getPublicBuildInfo returns null deploymentId when unset", async () => {
  await withEnv({ RAILWAY_DEPLOYMENT_ID: undefined }, async () => {
    assert.equal((await getPublicBuildInfo()).deploymentId, null);
  });
});

test("getPublicBuildInfo never fabricates deployedAt when no Railway token is configured", async () => {
  resetDeploymentTimelineCacheForTests();
  await withEnv(
    { RAILWAY_DEPLOYMENT_ID: "dep-1", RAILWAY_API_TOKEN: undefined },
    async () => {
      const info = await getPublicBuildInfo();
      assert.equal(info.deployedAt, null);
      assert.equal(info.deploymentStartedAt, null);
      assert.equal(info.deploymentStatus, "unknown");
    }
  );
});

test("getPublicBuildInfo returns exactly the public shape, nothing else", async () => {
  const info = await getPublicBuildInfo();
  assert.deepEqual(Object.keys(info).sort(), [
    "builtAt",
    "commitSha",
    "deployedAt",
    "deploymentId",
    "deploymentStartedAt",
    "deploymentStatus",
    "environment",
    "shortCommitSha",
  ]);
});

test("lib/buildInfo.ts never spreads or dumps raw process.env into the response", () => {
  const source = readFileSync(
    new URL("../lib/buildInfo.ts", import.meta.url),
    "utf8"
  );
  for (const forbidden of ["...process.env", "Object.entries(process.env)", "Object.keys(process.env)"]) {
    assert.ok(
      !source.includes(forbidden),
      `lib/buildInfo.ts must never reference ${forbidden}`
    );
  }
});

test("getPublicBuildInfo returns a valid ISO UTC deployedAt when Railway reports a matching terminal SUCCESS", async () => {
  resetDeploymentTimelineCacheForTests();
  await withEnv(
    {
      RAILWAY_DEPLOYMENT_ID: "dep-success-1",
      RAILWAY_API_TOKEN: "test-token",
      RAILWAY_GIT_COMMIT_SHA: "c12e84489559ed1320293e1cf8099dd17a7e80a6",
    },
    async () => {
      const fetchImpl = async () =>
        deploymentGraphqlResponse({
          id: "dep-success-1",
          status: "SUCCESS",
          createdAt: "2026-07-26T13:33:25.691Z",
          statusUpdatedAt: "2026-07-26T13:36:04.051Z",
          commitHash: "c12e84489559ed1320293e1cf8099dd17a7e80a6",
        });
      const info = await getPublicBuildInfo(fetchImpl);
      assert.equal(info.deployedAt, "2026-07-26T13:36:04.051Z");
      assert.equal(info.deploymentStartedAt, "2026-07-26T13:33:25.691Z");
      assert.equal(info.deploymentStatus, "success");
    }
  );
});

test("getPublicBuildInfo returns only deploymentStartedAt when the deployment has not reached SUCCESS yet", async () => {
  resetDeploymentTimelineCacheForTests();
  await withEnv(
    {
      RAILWAY_DEPLOYMENT_ID: "dep-building-1",
      RAILWAY_API_TOKEN: "test-token",
      RAILWAY_GIT_COMMIT_SHA: undefined,
    },
    async () => {
      const fetchImpl = async () =>
        deploymentGraphqlResponse({
          id: "dep-building-1",
          status: "BUILDING",
          createdAt: "2026-07-26T13:33:25.691Z",
          statusUpdatedAt: "2026-07-26T13:34:00.000Z",
        });
      const info = await getPublicBuildInfo(fetchImpl);
      assert.equal(info.deploymentStartedAt, "2026-07-26T13:33:25.691Z");
      assert.equal(info.deployedAt, null);
      assert.equal(info.deploymentStatus, "in_progress");
    }
  );
});

test("getPublicBuildInfo never copies builtAt onto deployedAt or deploymentStartedAt", async () => {
  resetDeploymentTimelineCacheForTests();
  await withEnv(
    { RAILWAY_DEPLOYMENT_ID: "dep-no-token", RAILWAY_API_TOKEN: undefined },
    async () => {
      const info = await getPublicBuildInfo();
      if (info.builtAt) {
        assert.notEqual(info.deployedAt, info.builtAt);
        assert.notEqual(info.deploymentStartedAt, info.builtAt);
      }
      assert.equal(info.deployedAt, null);
      assert.equal(info.deploymentStartedAt, null);
    }
  );
});

test("getPublicBuildInfo never uses the process start/request time as deployedAt", async () => {
  resetDeploymentTimelineCacheForTests();
  const before = new Date().toISOString();
  await withEnv(
    { RAILWAY_DEPLOYMENT_ID: "dep-no-token-2", RAILWAY_API_TOKEN: undefined },
    async () => {
      const info = await getPublicBuildInfo();
      assert.notEqual(info.deployedAt, before);
      assert.equal(info.deployedAt, null);
    }
  );
});

test("getPublicBuildInfo rejects a deployment lookup whose returned id does not match RAILWAY_DEPLOYMENT_ID", async () => {
  resetDeploymentTimelineCacheForTests();
  await withEnv(
    { RAILWAY_DEPLOYMENT_ID: "dep-expected", RAILWAY_API_TOKEN: "test-token" },
    async () => {
      const fetchImpl = async () =>
        deploymentGraphqlResponse({
          id: "dep-different",
          status: "SUCCESS",
          createdAt: "2026-07-26T13:33:25.691Z",
          statusUpdatedAt: "2026-07-26T13:36:04.051Z",
        });
      const info = await getPublicBuildInfo(fetchImpl);
      assert.equal(info.deployedAt, null);
      assert.equal(info.deploymentStartedAt, null);
      assert.equal(info.deploymentStatus, "unknown");
    }
  );
});

test("getPublicBuildInfo rejects Railway metadata whose commit SHA conflicts with the running commit", async () => {
  resetDeploymentTimelineCacheForTests();
  await withEnv(
    {
      RAILWAY_DEPLOYMENT_ID: "dep-conflict",
      RAILWAY_API_TOKEN: "test-token",
      RAILWAY_GIT_COMMIT_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    async () => {
      const fetchImpl = async () =>
        deploymentGraphqlResponse({
          id: "dep-conflict",
          status: "SUCCESS",
          createdAt: "2026-07-26T13:33:25.691Z",
          statusUpdatedAt: "2026-07-26T13:36:04.051Z",
          commitHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        });
      const info = await getPublicBuildInfo(fetchImpl);
      assert.equal(info.deployedAt, null);
      assert.equal(info.deploymentStartedAt, null);
      assert.equal(info.deploymentStatus, "unknown");
    }
  );
});

test("getPublicBuildInfo does not 500 or throw when the Railway lookup fails", async () => {
  resetDeploymentTimelineCacheForTests();
  await withEnv(
    { RAILWAY_DEPLOYMENT_ID: "dep-error", RAILWAY_API_TOKEN: "test-token" },
    async () => {
      const fetchImpl = async () => {
        throw new Error("network down");
      };
      const info = await getPublicBuildInfo(fetchImpl);
      assert.equal(info.deployedAt, null);
      assert.equal(info.deploymentStartedAt, null);
      assert.equal(info.deploymentStatus, "unknown");
    }
  );
});

test("getPublicBuildInfo does not 500 or throw on a non-OK Railway response", async () => {
  resetDeploymentTimelineCacheForTests();
  await withEnv(
    { RAILWAY_DEPLOYMENT_ID: "dep-500", RAILWAY_API_TOKEN: "test-token" },
    async () => {
      const fetchImpl = async () => jsonResponse({ errors: [{ message: "boom" }] }, false, 500);
      const info = await getPublicBuildInfo(fetchImpl);
      assert.equal(info.deployedAt, null);
      assert.equal(info.deploymentStatus, "unknown");
    }
  );
});

test("getPublicBuildInfo only trusts terminal SUCCESS for deployedAt, never other statuses", async () => {
  resetDeploymentTimelineCacheForTests();
  for (const status of ["FAILED", "CRASHED", "REMOVED", "QUEUED", "INITIALIZING"]) {
    resetDeploymentTimelineCacheForTests();
    await withEnv(
      { RAILWAY_DEPLOYMENT_ID: `dep-${status}`, RAILWAY_API_TOKEN: "test-token" },
      async () => {
        const fetchImpl = async () =>
          deploymentGraphqlResponse({
            id: `dep-${status}`,
            status,
            createdAt: "2026-07-26T13:33:25.691Z",
            statusUpdatedAt: "2026-07-26T13:34:00.000Z",
          });
        const info = await getPublicBuildInfo(fetchImpl);
        assert.equal(info.deployedAt, null, `status ${status} must never yield a deployedAt`);
      }
    );
  }
});

test("getPublicBuildInfo's Railway lookup is idempotent/cached per deployment ID (fetch called once)", async () => {
  resetDeploymentTimelineCacheForTests();
  let callCount = 0;
  await withEnv(
    { RAILWAY_DEPLOYMENT_ID: "dep-cached", RAILWAY_API_TOKEN: "test-token" },
    async () => {
      const fetchImpl = async () => {
        callCount += 1;
        return deploymentGraphqlResponse({
          id: "dep-cached",
          status: "SUCCESS",
          createdAt: "2026-07-26T13:33:25.691Z",
          statusUpdatedAt: "2026-07-26T13:36:04.051Z",
        });
      };
      const first = await getPublicBuildInfo(fetchImpl);
      const second = await getPublicBuildInfo(fetchImpl);
      assert.equal(first.deployedAt, second.deployedAt);
      assert.equal(callCount, 1, "the Railway API must only be queried once per deployment ID");
    }
  );
});

test("getPublicBuildInfo re-queries when the deployment ID changes (staging/production never share a cached timeline)", async () => {
  resetDeploymentTimelineCacheForTests();
  const seenIds = [];
  const fetchImpl = async (_url, options) => {
    const parsed = JSON.parse(options.body);
    seenIds.push(parsed.variables.id);
    return deploymentGraphqlResponse({
      id: parsed.variables.id,
      status: "SUCCESS",
      createdAt: "2026-07-26T13:33:25.691Z",
      statusUpdatedAt: "2026-07-26T13:36:04.051Z",
    });
  };
  await withEnv(
    { RAILWAY_DEPLOYMENT_ID: "dep-staging-1", RAILWAY_API_TOKEN: "test-token" },
    async () => {
      await getPublicBuildInfo(fetchImpl);
    }
  );
  await withEnv(
    { RAILWAY_DEPLOYMENT_ID: "dep-production-1", RAILWAY_API_TOKEN: "test-token" },
    async () => {
      await getPublicBuildInfo(fetchImpl);
    }
  );
  assert.deepEqual(seenIds, ["dep-staging-1", "dep-production-1"]);
});
