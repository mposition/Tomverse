import assert from "node:assert/strict";
import test from "node:test";
import { routingApplicationIdentity } from "../lib/routingApplicationIdentity.ts";

const env = {
  RAILWAY_GIT_COMMIT_SHA: "a".repeat(40),
  RAILWAY_DEPLOYMENT_ID: "7ac2d5a6-f003-489c-8c00-5b50c18e6574",
  APP_ENV: "staging",
};

test("records only the complete deployment identity, excluding credentials", () => {
  assert.deepEqual(routingApplicationIdentity({ ...env, API_KEY: "secret" }), {
    applicationCommitSha: env.RAILWAY_GIT_COMMIT_SHA,
    applicationDeploymentId: env.RAILWAY_DEPLOYMENT_ID,
    applicationEnvironment: "staging",
  });
});

test("partial or malformed provenance remains unknown rather than guessed", () => {
  for (const change of [
    { RAILWAY_GIT_COMMIT_SHA: "abcdef0" },
    { RAILWAY_DEPLOYMENT_ID: undefined },
    { RAILWAY_DEPLOYMENT_ID: "deployment" },
    { APP_ENV: undefined },
    { APP_ENV: "unlabelled", NODE_ENV: "production" },
  ]) {
    assert.deepEqual(routingApplicationIdentity({ ...env, ...change }), {
      applicationCommitSha: null, applicationDeploymentId: null,
      applicationEnvironment: null,
    });
  }
});
