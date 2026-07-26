import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  BUILD_ENVIRONMENTS,
  formatShortCommitSha,
  getPublicBuildInfo,
  validateCommitSha,
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

test("getPublicBuildInfo prefers APP_ENV over RAILWAY_ENVIRONMENT_NAME", async () => {
  await withEnv(
    { APP_ENV: "staging", RAILWAY_ENVIRONMENT_NAME: "production" },
    () => {
      assert.equal(getPublicBuildInfo().environment, "staging");
    }
  );
});

test("getPublicBuildInfo falls back to RAILWAY_ENVIRONMENT_NAME when APP_ENV is unset", async () => {
  await withEnv(
    { APP_ENV: undefined, RAILWAY_ENVIRONMENT_NAME: "staging" },
    () => {
      assert.equal(getPublicBuildInfo().environment, "staging");
    }
  );
});

test("getPublicBuildInfo falls back to development when nothing identifies the environment", async () => {
  await withEnv(
    { APP_ENV: undefined, RAILWAY_ENVIRONMENT_NAME: undefined, NODE_ENV: undefined },
    () => {
      assert.equal(getPublicBuildInfo().environment, "development");
    }
  );
});

test("getPublicBuildInfo prefers the live RAILWAY_GIT_COMMIT_SHA over any build-time fallback", async () => {
  await withEnv({ RAILWAY_GIT_COMMIT_SHA: "c12e844" }, () => {
    const info = getPublicBuildInfo();
    assert.equal(info.commitSha, "c12e844");
    assert.equal(info.shortCommitSha, "c12e844");
  });
});

test("getPublicBuildInfo ignores a malformed RAILWAY_GIT_COMMIT_SHA rather than returning garbage", async () => {
  await withEnv({ RAILWAY_GIT_COMMIT_SHA: "not-a-real-sha!!" }, () => {
    const info = getPublicBuildInfo();
    assert.notEqual(info.commitSha, "not-a-real-sha!!");
  });
});

test("getPublicBuildInfo reads deploymentId from RAILWAY_DEPLOYMENT_ID", async () => {
  await withEnv({ RAILWAY_DEPLOYMENT_ID: "staging-20260725-042436" }, () => {
    assert.equal(getPublicBuildInfo().deploymentId, "staging-20260725-042436");
  });
});

test("getPublicBuildInfo returns null deploymentId when unset", async () => {
  await withEnv({ RAILWAY_DEPLOYMENT_ID: undefined }, () => {
    assert.equal(getPublicBuildInfo().deploymentId, null);
  });
});

test("getPublicBuildInfo never fabricates deployedAt", () => {
  assert.equal(getPublicBuildInfo().deployedAt, null);
});

test("getPublicBuildInfo returns exactly the public shape, nothing else", () => {
  const info = getPublicBuildInfo();
  assert.deepEqual(Object.keys(info).sort(), [
    "builtAt",
    "commitSha",
    "deployedAt",
    "deploymentId",
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
