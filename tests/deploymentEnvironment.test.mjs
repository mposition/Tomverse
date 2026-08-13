import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEPLOYMENT_ENVIRONMENTS,
  resolveDeploymentEnvironment,
  resolveSentryEnvironmentTag,
  resetSentryEnvironmentWarningForTests,
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
  // chain and only one of them read APP_ENV.
  const { readFileSync } = await import("node:fs");
  // Comments are stripped first. These files explain *why* they do not read
  // the Sentry alias, naming it to do so, and a check a comment can trip is a
  // check people delete.
  const read = (path) =>
    readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");

  // Sentry's own configs resolve the *tag*, which may carry a non-canonical
  // label; everything else resolves the deployment itself.
  for (const path of ["sentry.server.config.ts", "sentry.edge.config.ts"]) {
    assert.ok(
      read(path).includes("resolveSentryEnvironmentTag"),
      `${path} must resolve its tag through the shared module`
    );
  }

  const deploymentFacts = [
    "lib/traceErrorEvidence.ts",
    "lib/errorReportToken.ts",
    "lib/buildInfo.ts",
    "lib/securityEnvironment.ts",
    "app/(site)/(application)/admin/layout.tsx",
  ];
  for (const path of deploymentFacts) {
    const source = read(path);
    assert.ok(
      source.includes("resolveDeploymentEnvironment"),
      `${path} must resolve the environment through the shared module`
    );
    // A Sentry display alias must not be able to say which deployment
    // produced a record, or decide a security rule.
    assert.ok(
      !source.includes("SENTRY_ENVIRONMENT"),
      `${path} must not read the Sentry display alias`
    );
  }

  for (const path of [...deploymentFacts, "sentry.server.config.ts", "sentry.edge.config.ts"]) {
    assert.ok(
      !read(path).includes("process.env.RAILWAY_ENVIRONMENT_NAME"),
      `${path} must not start a second resolution chain`
    );
  }
});

test("a Sentry label may not contradict the deployment it labels", () => {
  // The observed failure: staging carried SENTRY_ENVIRONMENT=production -- the
  // value the README's own example showed -- so every staging error arrived
  // filed under production while the same process answered "staging". A tag
  // that can lie about which deployment produced an event is worse than no tag.
  resetSentryEnvironmentWarningForTests();
  const warnings = [];
  const warn = (message) => warnings.push(message);
  const staging = { APP_ENV: "staging", NODE_ENV: "production" };

  assert.equal(
    resolveSentryEnvironmentTag({ ...staging, SENTRY_ENVIRONMENT: "production" }, warn),
    "staging"
  );
  assert.equal(warnings.length, 1, "a silently ignored variable is its own confusion");
  assert.match(warnings[0], /sentry_environment_override_ignored/);
  assert.match(warnings[0], /"deployment":"staging"/);

  // Once per process: a warning on every event would be its own noise.
  resolveSentryEnvironmentTag({ ...staging, SENTRY_ENVIRONMENT: "production" }, warn);
  assert.equal(warnings.length, 1);
});

test("a label the resolver has no opinion about is still allowed", () => {
  // The feature is not removed, only prevented from contradicting. Grouping
  // one deployment's events under a name of its own stays possible.
  resetSentryEnvironmentWarningForTests();
  const warn = () => assert.fail("no warning for a non-canonical label");
  const staging = { APP_ENV: "staging", NODE_ENV: "production" };
  for (const label of ["production-eu", "canary", "staging-2"]) {
    assert.equal(
      resolveSentryEnvironmentTag({ ...staging, SENTRY_ENVIRONMENT: label }, warn),
      label
    );
  }
  // Naming the same environment is agreement, not contradiction.
  assert.equal(
    resolveSentryEnvironmentTag({ ...staging, SENTRY_ENVIRONMENT: "STAGING" }, warn),
    "STAGING"
  );
});

test("with no override the tag is simply the deployment", () => {
  const warn = () => assert.fail("no warning when nothing is overridden");
  assert.equal(
    resolveSentryEnvironmentTag({ APP_ENV: "staging", NODE_ENV: "production" }, warn),
    "staging"
  );
  assert.equal(
    resolveSentryEnvironmentTag({ SENTRY_ENVIRONMENT: "   ", NODE_ENV: "production" }, warn),
    "production"
  );
});

test("the deployment fact never reads the Sentry label", () => {
  // Error-report tokens and trace evidence record which deployment produced a
  // record. A display alias must not be able to answer that question, and the
  // resolver they call does not look at it.
  assert.equal(
    resolveDeploymentEnvironment({
      SENTRY_ENVIRONMENT: "production",
      APP_ENV: "staging",
      NODE_ENV: "production",
    }),
    "staging"
  );
});
