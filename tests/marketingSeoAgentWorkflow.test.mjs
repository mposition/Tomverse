import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parse } from "yaml";

/**
 * Structure of the execution environment of the marketing SEO code agent
 * (policy docs/policy/marketing-automation.md 9.2, operator decision 2026-11-03).
 *
 * The runner's own rules are held by tests/marketingSeoAgentCore.test.mjs. What
 * this file holds is what only the workflow decides: that the two phases are on
 * two runners, that each secret is where policy 9.2 puts it and nowhere else,
 * that nothing can start it but a person, and that off means off.
 */

const PATH = ".github/workflows/marketing-seo-agent.yml";
const source = readFileSync(PATH, "utf8");
const workflow = parse(source);
const jobs = workflow.jobs;

const stepsOf = (job) => jobs[job].steps;
const secretsIn = (value) => [...JSON.stringify(value).matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]);
const varsIn = (value) => [...JSON.stringify(value).matchAll(/vars\.([A-Z0-9_]+)/g)].map((match) => match[1]);
const stepNamed = (job, fragment) => stepsOf(job).find((step) => String(step.name).includes(fragment));

test("only a person can start it: workflow_dispatch and nothing else", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.topic.required, true);
});

test("it is off unless the agent variable says true, and the kill switch variable stops it", () => {
  for (const job of ["validate", "publish"]) {
    const condition = String(jobs[job].if).replace(/\s+/g, " ");
    assert.match(condition, /vars\.MARKETING_SEO_AGENT_ENABLED == 'true'/, job);
    assert.match(condition, /vars\.MARKETING_AUTOMATION_KILL_SWITCH == ''/, job);
  }
  assert.match(String(jobs.validate.if), /github\.repository == 'mposition\/Tomverse'/);
  assert.match(String(jobs.publish.if), /needs\.validate\.outputs\.validated == 'true'/);
});

test("a failed run never fails the commit it ran on, and nothing reads a job result", () => {
  for (const job of Object.values(jobs)) assert.equal(job["continue-on-error"], true);
  assert.doesNotMatch(source, /needs\.[a-z-]+\.result/);
});

test("the token is read-only, the cache token has no write scope, and no job widens either", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow["cache-mode"], "read");
  for (const [name, job] of Object.entries(jobs)) {
    assert.equal(job.permissions, undefined, `${name} must not widen the workflow token`);
    assert.equal(job.environment, undefined, name);
  }
});

test("every action is pinned to a commit, and no step caches", () => {
  const uses = stepsOf("validate").concat(stepsOf("publish")).map((step) => step.uses).filter(Boolean);
  assert.ok(uses.length >= 7);
  for (const reference of uses) assert.match(reference, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, reference);
  assert.doesNotMatch(source, /actions\/cache|cache:\s*npm/);
  for (const job of ["validate", "publish"]) {
    assert.equal(stepsOf(job).find((step) => String(step.uses).includes("setup-node")).with["package-manager-cache"], false, job);
  }
});

test("the two phases are two jobs on two runners, and publish needs validate", () => {
  assert.deepEqual(Object.keys(jobs), ["validate", "publish"]);
  assert.equal(jobs.publish.needs, "validate");
  assert.match(stepNamed("validate", "Validate").run, /--phase validate/);
  assert.doesNotMatch(stepNamed("validate", "Validate").run, /--phase (publish|arm)/);
  assert.match(stepNamed("publish", "Publish").run, /--phase publish/);
  assert.doesNotMatch(stepNamed("publish", "Publish").run, /--phase validate/);
});

test("secrets and variables are bound to steps, never to a job or the workflow", () => {
  assert.equal(workflow.env, undefined);
  for (const [name, job] of Object.entries(jobs)) {
    assert.equal(job.env, undefined, `${name} must not hold a job-level environment`);
  }
  for (const job of ["validate", "publish"]) {
    for (const step of stepsOf(job)) {
      const carriesSecret = secretsIn(step.env ?? {}).length + secretsIn(step.with ?? {}).length > 0;
      if (carriesSecret) assert.ok(step.env || step.with, `${job}: ${step.name}`);
      assert.doesNotMatch(String(step.run ?? ""), /secrets\./, `${job}: ${step.name} inlines a secret in a script`);
    }
  }
});

test("validate holds the LLM path and the attestation key, and no GitHub write credential", () => {
  assert.deepEqual(
    [...new Set(secretsIn(jobs.validate))].sort(),
    ["MARKETING_GENERATOR_SUBMIT_SECRET", "MARKETING_LLM_API_KEY", "MARKETING_SEO_ATTESTATION_KEY"],
  );
  const validateText = JSON.stringify(jobs.validate);
  assert.doesNotMatch(validateText, /APP_PRIVATE_KEY|GH_AUTOMATION_PAT|GITHUB_TOKEN|GH_TOKEN|create-github-app-token|secrets\.GITHUB/);
  assert.doesNotMatch(validateText, /MARKETING_SEO_GITHUB_|MARKETING_SEO_AUTO_/);
  // Only one step holds the three secrets, and it is the one that runs the phase.
  const holders = stepsOf("validate").filter((step) => secretsIn(step).length > 0);
  assert.deepEqual(holders.map((step) => step.name), [stepNamed("validate", "Validate").name]);
  // The checkout carries no credential into the checks.
  const checkout = stepsOf("validate").find((step) => String(step.uses).includes("actions/checkout"));
  assert.equal(checkout.with["persist-credentials"], false);
});

test("validate runs the checks as another user and passes secrets by environment, not by argument", () => {
  const setup = stepNamed("validate", "check user").run;
  assert.match(setup, /useradd --system/);
  const run = stepNamed("validate", "Validate").run;
  assert.match(run, /sudo --preserve-env="\$preserve"/);
  assert.match(run, /MARKETING_SEO_CHECK_UID=\$\(id -u seo-check\)/);
  assert.match(run, /MARKETING_SEO_CHECK_GID=\$\(id -g seo-check\)/);
  // The topic and the base commit come from the step environment, quoted, never from an expression in the script.
  assert.match(run, /--topic "\$TOPIC"/);
  assert.match(run, /--base "\$BASE"/);
  assert.doesNotMatch(run, /\$\{\{/);
  // The preserved list is exactly the secrets and variables the phase takes (plus CI), and no GitHub credential.
  const preserved = /preserve="([^"]+)"/.exec(run)[1].split(",").sort();
  assert.deepEqual(preserved, [
    "CI",
    "MARKETING_APP_URL",
    "MARKETING_AUTOMATION_KILL_SWITCH",
    "MARKETING_GENERATOR_SUBMIT_SECRET",
    "MARKETING_LLM_API_KEY",
    "MARKETING_SEO_AGENT_ENABLED",
    "MARKETING_SEO_ATTESTATION_KEY",
  ]);
  for (const name of preserved) assert.doesNotMatch(name, /GITHUB|GH_/);
});

test("publish holds the App key and the attestation key, and no LLM variable at all", () => {
  assert.deepEqual(
    [...new Set(secretsIn(jobs.publish))].sort(),
    ["MARKETING_SEO_APP_PRIVATE_KEY", "MARKETING_SEO_ATTESTATION_KEY"],
  );
  const publishText = JSON.stringify(jobs.publish);
  assert.doesNotMatch(publishText, /MARKETING_LLM_API_KEY|MARKETING_GENERATOR_SUBMIT_SECRET|MARKETING_APP_URL|GH_AUTOMATION_PAT/);
  assert.deepEqual(
    [...new Set(varsIn(jobs.publish))].sort(),
    [
      "MARKETING_AUTOMATION_KILL_SWITCH",
      "MARKETING_SEO_AGENT_ENABLED",
      "MARKETING_SEO_APP_CLIENT_ID",
      "MARKETING_SEO_AUTO_MERGE",
      "MARKETING_SEO_AUTO_PR",
    ],
  );
  const checkout = stepsOf("publish").find((step) => String(step.uses).includes("actions/checkout"));
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(checkout.with["fetch-depth"], 0);
  assert.equal(checkout.with.ref, "${{ needs.validate.outputs.base }}");
});

test("the graduation record and the auto-merge switch exist only in publish", () => {
  assert.doesNotMatch(JSON.stringify(jobs.validate), /MARKETING_SEO_AUTO_PR|MARKETING_SEO_AUTO_MERGE/);
  const env = stepNamed("publish", "Publish").env;
  assert.equal(env.MARKETING_SEO_AUTO_PR, "${{ vars.MARKETING_SEO_AUTO_PR }}");
  assert.equal(env.MARKETING_SEO_AUTO_MERGE, "${{ vars.MARKETING_SEO_AUTO_MERGE }}");
  assert.equal(env.MARKETING_SEO_GITHUB_REPOSITORY, "${{ github.repository }}");
  assert.equal(env.MARKETING_SEO_GITHUB_APP_TOKEN, "${{ steps.app.outputs.token }}");
});

test("the App token is for this repository only and asks for contents and pull requests, nothing more", () => {
  const app = stepNamed("publish", "repository-only App token");
  assert.match(app.uses, /^actions\/create-github-app-token@[0-9a-f]{40}$/);
  const permissions = Object.keys(app.with).filter((key) => key.startsWith("permission-")).sort();
  assert.deepEqual(permissions, ["permission-contents", "permission-pull-requests"]);
  assert.equal(app.with["permission-contents"], "write");
  assert.equal(app.with["permission-pull-requests"], "write");
  for (const key of ["owner", "repositories", "skip-token-revoke"]) assert.equal(app.with[key], undefined, key);
  // The token is minted after the dependencies are installed and used only by the publish step.
  const names = stepsOf("publish").map((step) => step.name);
  assert.ok(names.findIndex((name) => name.includes("Install dependencies")) < names.findIndex((name) => name.includes("App token")));
  const holders = stepsOf("publish").filter((step) => JSON.stringify(step.env ?? {}).includes("steps.app.outputs.token"));
  assert.deepEqual(holders.map((step) => step.name), [stepNamed("publish", "Publish").name]);
});

test("the artifact carries only the validate output directory, for a day, under a per-run name", () => {
  const upload = stepsOf("validate").find((step) => String(step.uses).includes("upload-artifact"));
  const download = stepsOf("publish").find((step) => String(step.uses).includes("download-artifact"));
  assert.equal(upload.with.name, download.with.name);
  assert.match(upload.with.name, /github\.run_id.*github\.run_attempt/);
  assert.equal(upload.with.path, "${{ runner.temp }}/seo-out/");
  assert.equal(upload.with["retention-days"], 1);
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(upload.if, "steps.out.outputs.validated == 'true'");
  // The exact three files the runner insists on.
  assert.match(stepNamed("validate", "what validation produced").run, /"attestation\.json change\.bundle record\.json "/);
});

test("the App token cannot outlast the arm window the runner computes", () => {
  const expiry = stepNamed("publish", "latest the App token").run;
  assert.match(expiry, /date -u -d '\+55 minutes'/);
  const names = stepsOf("publish").map((step) => step.name);
  assert.ok(names.findIndex((name) => name.includes("latest the App token")) < names.findIndex((name) => name.includes("App token") && !name.includes("latest")));
  assert.equal(stepNamed("publish", "Publish").env.MARKETING_SEO_GITHUB_APP_TOKEN_EXPIRES_AT, "${{ steps.expiry.outputs.at }}");
  assert.ok(jobs.publish["timeout-minutes"] >= 55 + 10, "45 minutes of watching plus set-up");
});

test("no script interpolates a context expression, so a topic cannot become shell", () => {
  for (const job of ["validate", "publish"]) {
    for (const step of stepsOf(job)) {
      if (typeof step.run === "string") assert.doesNotMatch(step.run, /\$\{\{/, `${job}: ${step.name}`);
    }
  }
});
