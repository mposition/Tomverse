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

test("every consumer of the environment reads the same module", async () => {
  // The regression this pins was visible from outside the process: staging's
  // /api/build-info reported "staging" while its own Sentry events arrived
  // tagged environment=production, because five call sites each had their own
  // chain and only one of them read APP_ENV. The cost was not cosmetic --
  // error-report evidence was stamped production on staging, which the
  // feedback policy forbids, and the admin console told an operator standing
  // in staging that they were in production.
  const { readFileSync } = await import("node:fs");
  const consumers = [
    "sentry.server.config.ts",
    "sentry.edge.config.ts",
    "lib/traceErrorEvidence.ts",
    "lib/errorReportToken.ts",
    "lib/buildInfo.ts",
    "lib/securityEnvironment.ts",
    "app/(site)/(application)/admin/layout.tsx",
  ];
  for (const path of consumers) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.ok(
      source.includes("resolveDeploymentEnvironment"),
      `${path} must resolve the environment through the shared module`
    );
    assert.ok(
      !source.includes("process.env.RAILWAY_ENVIRONMENT_NAME"),
      `${path} must not start a second resolution chain`
    );
  }
});

test("an explicit SENTRY_ENVIRONMENT still wins where it is offered", () => {
  // Kept because it is how an operator overrides the tag for one deployment
  // without changing what the deployment *is* -- the security rules keep
  // reading the resolver either way.
  assert.equal(
    resolveDeploymentEnvironment({
      SENTRY_ENVIRONMENT: "whatever",
      APP_ENV: "staging",
      NODE_ENV: "production",
    }),
    "staging"
  );
});
