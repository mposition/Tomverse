// The Agent project's IaC table, and what an apply from it would do.
//
// The failures these hold shut are the ones an apply makes permanent: a
// variable the table forgets is a variable the apply deletes, a service the
// table forgets is a service it deletes, and a project file that owns less than
// the whole project leaves room for the database service the agents must not be
// able to reach.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  AGENT_ENVIRONMENT_BRANCHES,
  AGENT_RAILWAY_PROJECT,
  AGENT_RUNNER_SERVICES,
  buildAgentRunnerResources,
} from "../.railway/agent-runners.ts";
import {
  DECLARED_SERVICE_VARIABLES,
  PROBE_SERVICE_VARIABLES,
} from "../lib/productResearchObservationRunnerCore.mjs";

const railwayDirectory = join(process.cwd(), ".railway");

const recordingDsl = () => {
  const PRESERVED = Symbol("preserve");
  return {
    PRESERVED,
    dsl: {
      github: (repo, options) => ({ repo, ...options }),
      preserve: () => PRESERVED,
      service: (name, config) => ({ name, ...config }),
    },
  };
};

test("every runner's start command is a real npm script", () => {
  const scripts = JSON.parse(
    readFileSync(join(process.cwd(), "package.json"), "utf8")
  ).scripts;
  for (const runner of AGENT_RUNNER_SERVICES) {
    // `npm run <name>` and `npm run <name> -- <flag>` both have to resolve: a
    // start command Railway cannot run is a cron that fails every night, and
    // the deploy log is the only place it would say so.
    const match = /^npm run ([a-z0-9:-]+)(?: -- .+)?$/.exec(runner.startCommand);
    assert.ok(match, `${runner.service}: start command is not an npm run invocation`);
    assert.ok(scripts[match[1]], `${runner.service}: package.json has no "${match[1]}" script`);
  }
  assert.equal(
    new Set(AGENT_RUNNER_SERVICES.map((runner) => runner.service)).size,
    AGENT_RUNNER_SERVICES.length,
    "two runner services share a name"
  );
  assert.equal(
    new Set(AGENT_RUNNER_SERVICES.map((runner) => runner.key)).size,
    AGENT_RUNNER_SERVICES.length,
    "two runner services share a key"
  );
});

test("a declared variable list is never empty and never repeats a name", () => {
  for (const runner of AGENT_RUNNER_SERVICES) {
    const environments = Object.entries(runner.environments);
    assert.ok(environments.length > 0, `${runner.service} exists in no environment`);
    for (const [environment, variables] of environments) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(AGENT_ENVIRONMENT_BRANCHES, environment),
        `${runner.service}: unknown environment ${environment}`
      );
      // An empty list is not "no variables": applying it deletes every variable
      // the service has there.
      assert.ok(
        Array.isArray(variables) && variables.length > 0,
        `${runner.service} declares an empty variable list for ${environment}`
      );
      assert.equal(
        new Set(variables).size,
        variables.length,
        `${runner.service}: duplicate variable in ${environment}`
      );
    }
  }
});

test("the observation runner's declared variables are the ones the run checks for", () => {
  // Two readers of one list. The runner stops when the process has a name
  // outside it, which is the check that says a product database credential
  // cannot be here; a name added to the IaC and not to the runner would make
  // the run refuse to start, and a name added to the runner and not to the IaC
  // would be deleted by the next apply.
  const observation = AGENT_RUNNER_SERVICES.find(
    (runner) => runner.key === "product_research_observation"
  );
  for (const environment of Object.keys(AGENT_ENVIRONMENT_BRANCHES)) {
    assert.deepEqual(
      [...observation.environments[environment]].sort(),
      [...DECLARED_SERVICE_VARIABLES].sort(),
      environment
    );
  }
});

test("the probe holds no means of submitting, and exists only in staging", () => {
  const probe = AGENT_RUNNER_SERVICES.find((runner) => runner.key === "product_research_probe");
  assert.deepEqual(Object.keys(probe.environments), ["staging"]);
  // S0 measures what the image can do. Nothing about that needs the ability to
  // write a row, so the variables that would allow one are absent -- a probe
  // that could submit is a second writer for the same slot.
  const variables = probe.environments.staging;
  assert.equal(variables.includes("PRODUCT_RESEARCH_INGEST_URL"), false);
  assert.equal(variables.includes("PRODUCT_RESEARCH_INGEST_SECRET"), false);
  // And it runs when an operator runs it, not on a schedule.
  assert.equal(probe.cronSchedule, null);

  // The probe checks its environment against its own shorter list, so the two
  // have to be the same list: a name declared here and not there stops the
  // probe, and a name there and not here is deleted by the next apply.
  assert.deepEqual([...variables].sort(), [...PROBE_SERVICE_VARIABLES].sort());
});

test("the resource list is exactly the table for that environment, and refuses the unknown", () => {
  const { PRESERVED, dsl } = recordingDsl();

  for (const [environment, branch] of Object.entries(AGENT_ENVIRONMENT_BRANCHES)) {
    const expected = AGENT_RUNNER_SERVICES.filter((runner) => runner.environments[environment]);
    const resources = buildAgentRunnerResources(environment, dsl);
    assert.deepEqual(
      resources.map((resource) => resource.name),
      expected.map((runner) => runner.service),
      `${environment}: the resource list drops or adds a service`
    );

    for (const runner of expected) {
      const resource = resources.find((entry) => entry.name === runner.service);
      assert.deepEqual(resource.source, { repo: "mposition/Tomverse", branch });
      assert.equal(resource.start, runner.startCommand);
      assert.deepEqual(
        resource.deploy,
        runner.cronSchedule === null
          ? { restartPolicyType: "NEVER" }
          : { cronSchedule: runner.cronSchedule, restartPolicyType: "NEVER" }
      );
      assert.deepEqual(
        Object.keys(resource.env).sort(),
        [...runner.environments[environment]].sort()
      );
      assert.ok(
        Object.values(resource.env).every((value) => value === PRESERVED),
        `${environment}/${runner.service}: a variable value is written instead of preserved`
      );
    }
  }

  // A service with no schedule must not pick one up by accident: Railway reads
  // the absence of the key, not a null.
  const staging = buildAgentRunnerResources("staging", dsl);
  const probe = staging.find((resource) => resource.name === "Product Research Probe");
  assert.equal(Object.prototype.hasOwnProperty.call(probe.deploy, "cronSchedule"), false);

  // Production has no probe at all, rather than a probe with nothing in it.
  const production = buildAgentRunnerResources("production", dsl);
  assert.equal(
    production.some((resource) => resource.name === "Product Research Probe"),
    false
  );

  for (const environment of ["pr-1234", "Production", "", undefined, null]) {
    assert.throws(
      () => buildAgentRunnerResources(environment, dsl),
      /No agent runner configuration/,
      String(environment)
    );
  }
});

test("the Agent project file owns the whole project and stays a pass-through", () => {
  const source = readFileSync(join(railwayDirectory, "agents-railway.ts"), "utf8");
  // No partial. The agents' project is theirs alone, so an apply has to delete
  // a database service somebody adds by hand -- that service is the one thing
  // a reference variable could resolve to.
  assert.equal(/^export const partial/m.test(source), false);
  assert.match(source, /project\(AGENT_RAILWAY_PROJECT, \{/);
  assert.match(source, /resources: buildAgentRunnerResources\(ctx\.environment, \{/);
  for (const reshaping of [".filter(", ".slice(", ".concat(", ".map("]) {
    assert.ok(
      !source.includes(reshaping),
      `.railway/agents-railway.ts reshapes resources with ${reshaping}`
    );
  }
  // The shared project's file keeps its partial: this change must not have
  // turned it into a whole-project file that owns the web service.
  const shared = readFileSync(join(railwayDirectory, "railway.ts"), "utf8");
  assert.match(shared, /export const partial = "scheduled-jobs";/);
  assert.equal(shared.includes(AGENT_RAILWAY_PROJECT), false);
});

test("the agents' scripts plan the agents' file, and the default scripts do not", () => {
  const iac = JSON.parse(readFileSync(join(railwayDirectory, "package.json"), "utf8"));
  const root = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));

  for (const [script, expected] of [
    ["agents:plan", "config plan --file agents-railway.ts"],
    ["agents:apply", "config apply --file agents-railway.ts"],
  ]) {
    assert.ok(iac.scripts[script], `.railway/package.json has no "${script}"`);
    assert.ok(
      iac.scripts[script].includes(expected),
      `.railway/package.json "${script}" does not pass --file agents-railway.ts`
    );
  }
  // The plain scripts still act on the shared project's partial. A --file added
  // to them would point the shared project's apply at the agents' file, which
  // owns a different project entirely.
  for (const script of ["plan", "apply"]) {
    assert.equal(iac.scripts[script].includes("--file"), false, `.railway/package.json "${script}"`);
  }
  for (const [script, project] of [
    ["agents:use:staging", AGENT_RAILWAY_PROJECT],
    ["agents:use:production", AGENT_RAILWAY_PROJECT],
    ["use:staging", "Tomverse"],
    ["use:production", "Tomverse"],
  ]) {
    assert.match(iac.scripts[script], new RegExp(`--project "?${project}"?`), script);
  }

  // The root scripts are the ones an operator runs; a missing one sends them to
  // the dashboard, where the schedules are not the source of truth.
  for (const script of [
    "railway:agents:use-staging",
    "railway:agents:use-production",
    "railway:agents:plan",
    "railway:agents:apply",
  ]) {
    assert.ok(root.scripts[script], `package.json has no "${script}" script`);
    assert.match(root.scripts[script], /npm run --prefix \.railway agents:/, script);
  }
});
