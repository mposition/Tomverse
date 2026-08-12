import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEPLOYMENT_ENVIRONMENTS,
  resolveDeploymentEnvironment,
  validateEnvironment,
} from "../lib/deploymentEnvironment.ts";

test("an unlabelled production build is treated as production", () => {
  // The fail-closed step. A deployment gets a weaker environment's rules by
  // saying which environment it is, never by omitting the label -- otherwise
  // a dropped variable quietly relaxes production.
  assert.equal(resolveDeploymentEnvironment({ NODE_ENV: "production" }), "production");
  assert.equal(resolveDeploymentEnvironment({}), "development");
  assert.equal(resolveDeploymentEnvironment({ NODE_ENV: "test" }), "development");
});

test("APP_ENV outranks the platform's own environment name", () => {
  assert.equal(
    resolveDeploymentEnvironment({
      APP_ENV: "production",
      RAILWAY_ENVIRONMENT_NAME: "staging",
      NODE_ENV: "production",
    }),
    "production"
  );
  assert.equal(
    resolveDeploymentEnvironment({
      RAILWAY_ENVIRONMENT_NAME: "staging",
      NODE_ENV: "production",
    }),
    "staging"
  );
});

test("an unrecognised label falls through rather than being believed", () => {
  // "prod" and "stg" are not in the list, and guessing what they meant is how
  // a typo turns into a relaxed security rule.
  assert.equal(
    resolveDeploymentEnvironment({ APP_ENV: "prod", NODE_ENV: "production" }),
    "production"
  );
  assert.equal(
    resolveDeploymentEnvironment({ APP_ENV: "stg", NODE_ENV: "production" }),
    "production"
  );
  assert.equal(
    resolveDeploymentEnvironment({
      APP_ENV: "stg",
      RAILWAY_ENVIRONMENT_NAME: "staging",
      NODE_ENV: "production",
    }),
    "staging"
  );
});

test("labels are matched case- and whitespace-insensitively, and nothing else is", () => {
  for (const environment of DEPLOYMENT_ENVIRONMENTS) {
    assert.equal(validateEnvironment(environment), environment);
    assert.equal(validateEnvironment(environment.toUpperCase()), environment);
    assert.equal(validateEnvironment(`  ${environment}  `), environment);
  }
  for (const rejected of ["prod", "stg", "", null, undefined, 7, {}]) {
    assert.equal(validateEnvironment(rejected), null, String(rejected));
  }
});
