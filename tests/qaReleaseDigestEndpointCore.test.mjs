import assert from "node:assert/strict";
import test from "node:test";

import {
  QA_RELEASE_DIGEST_ENDPOINTS,
  assertQaReleaseDigestEndpoint,
  qaReleaseDigestEndpoint,
  qaReleaseDigestEnvironment,
} from "../lib/qaReleaseDigestEndpointCore.ts";

// Written out independently of the module: changing a destination must change
// this test too, in the same reviewed diff.
const EXPECTED = {
  staging: "https://staging.tomverse.app/api/internal/agents/qa-release/digest",
  production: "https://tomverse.app/api/internal/agents/qa-release/digest",
};

test("the fixed destinations are exactly the expected ones", () => {
  assert.deepEqual(QA_RELEASE_DIGEST_ENDPOINTS, {
    staging: "https://staging.tomverse.app",
    production: "https://tomverse.app",
  });
  assert.ok(Object.isFrozen(QA_RELEASE_DIGEST_ENDPOINTS));
  assert.equal(qaReleaseDigestEndpoint({ RAILWAY_ENVIRONMENT_NAME: "staging" }), EXPECTED.staging);
  assert.equal(qaReleaseDigestEndpoint({ RAILWAY_ENVIRONMENT_NAME: "production" }), EXPECTED.production);
});

test("the environment comes from Railway's name only", () => {
  assert.equal(qaReleaseDigestEnvironment({ RAILWAY_ENVIRONMENT_NAME: " Staging " }), "staging");
  for (const env of [
    {},
    { RAILWAY_ENVIRONMENT_NAME: "" },
    { RAILWAY_ENVIRONMENT_NAME: "development" },
    { RAILWAY_ENVIRONMENT_NAME: "pr-1949" },
    { APP_ENV: "production" },
    { NODE_ENV: "production" },
  ]) {
    assert.throws(() => qaReleaseDigestEndpoint(env), /qa_release_digest_environment_unknown/, JSON.stringify(env));
  }
  // When the other signals disagree with Railway's name, Railway's name wins.
  for (const [name, other] of [["staging", "production"], ["production", "staging"]]) {
    assert.equal(
      qaReleaseDigestEndpoint({ RAILWAY_ENVIRONMENT_NAME: name, APP_ENV: other, NODE_ENV: other }),
      EXPECTED[name],
    );
  }
});

test("only the exact fixed URLs pass the final check", () => {
  for (const url of Object.values(EXPECTED)) assert.doesNotThrow(() => assertQaReleaseDigestEndpoint(url));
  for (const url of [
    "http://tomverse.app/api/internal/agents/qa-release/digest",
    "https://tomverse.app:8443/api/internal/agents/qa-release/digest",
    "https://user:pass@tomverse.app/api/internal/agents/qa-release/digest",
    "https://tomverse.app/api/internal/agents/qa-release/digest?x=1",
    "https://tomverse.app/api/internal/agents/qa-release/digest#x",
    "https://tomverse.app/api/internal/agents/qa-release/digest/",
    "https://tomverse.app/api/internal/agents/qa-release/other",
    "https://evil.example/api/internal/agents/qa-release/digest",
    "https://tomverse.app.evil.example/api/internal/agents/qa-release/digest",
    "https://www.tomverse.app/api/internal/agents/qa-release/digest",
    "https://tomverse.app/api/internal/agents/qa-release/digest/../digest",
  ]) {
    assert.throws(() => assertQaReleaseDigestEndpoint(url), /qa_release_digest_endpoint_not_allowed/, url);
  }
  assert.throws(() => assertQaReleaseDigestEndpoint("not a url"), /qa_release_digest_endpoint_invalid/);
});
