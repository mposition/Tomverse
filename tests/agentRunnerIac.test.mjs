// The Agent project's IaC table, and what an apply from it would do.
//
// The failures these hold shut are the ones an apply makes permanent: a
// variable the table forgets is a variable the apply deletes, a service the
// table forgets is a service it deletes, and a project file that owns less than
// the whole project leaves room for the database service the agents must not be
// able to reach.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  AGENT_ENVIRONMENT_BRANCHES,
  AGENT_RAILWAY_PROJECT,
  AGENT_RAILWAY_REGION,
  AGENT_RAILWAY_REPOSITORY,
  AGENT_RUNNER_SERVICES,
  buildAgentRunnerResources,
} from "../.railway/agent-runners.ts";
import {
  DECLARED_SERVICE_VARIABLES,
  PROBE_SERVICE_VARIABLES,
} from "../lib/productResearchObservationRunnerCore.mjs";
import { OBSERVED_REPOSITORY } from "../lib/productResearchObservationStepCore.mjs";

const railwayDirectory = join(process.cwd(), ".railway");

const recordingDsl = () => {
  const PRESERVED = Symbol("preserve");
  return {
    PRESERVED,
    dsl: {
      github: (repo, options) => ({ repo, ...options }),
      image: (reference, options) => ({ reference, ...options }),
      preserve: () => PRESERVED,
      service: (name, config) => ({ name, ...config }),
    },
  };
};

test("every runner's start command resolves: an npm script, or a node entry file that exists", () => {
  const scripts = JSON.parse(
    readFileSync(join(process.cwd(), "package.json"), "utf8")
  ).scripts;
  for (const runner of AGENT_RUNNER_SERVICES) {
    // `npm run <name>` and `npm run <name> -- <flag>` both have to resolve: a
    // start command Railway cannot run is a cron that fails every night, and
    // the deploy log is the only place it would say so.
    // A runner whose start check refuses unknown variable names starts node
    // directly: npm run adds npm_*, INIT_CWD and NODE to the environment.
    const direct = /^node --experimental-strip-types (scripts\/[a-z0-9/-]+\.mjs)$/.exec(runner.startCommand);
    if (direct) {
      assert.ok(existsSync(join(process.cwd(), direct[1])), `${runner.service}: ${direct[1]} does not exist`);
      continue;
    }
    // A Dockerfile-built runner: the start command replaces the image's
    // ENTRYPOINT in exec form, so it is node, an entry file and one argument.
    const image = /^node (scripts\/ops-observer\/supervise\.mjs) (page|digest)$/.exec(runner.startCommand);
    if (image) {
      assert.ok(existsSync(join(process.cwd(), image[1])), `${runner.service}: ${image[1]} does not exist`);
      continue;
    }
    // A service built from its own Dockerfile that runs a compiled binary: the
    // start command is the binary that Dockerfile installs.
    if (runner.dockerfile && runner.startCommand.startsWith("/usr/local/bin/")) {
      const dockerfile = readFileSync(join(process.cwd(), runner.dockerfile.path), "utf8");
      assert.ok(
        dockerfile.includes(` ${runner.startCommand}`),
        `${runner.service}: ${runner.dockerfile.path} does not install ${runner.startCommand}`
      );
      continue;
    }
    const match = /^npm run ([a-z0-9:-]+)(?: -- .+)?$/.exec(runner.startCommand);
    assert.ok(match, `${runner.service}: start command is neither npm run nor a node entry`);
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

test("the probe measures every environment's image and can submit in none", () => {
  const probe = AGENT_RUNNER_SERVICES.find((runner) => runner.key === "product_research_probe");
  // Every environment, because each builds its own image and the probe's whole
  // job is to say what an image can do. Production was the one left out, so its
  // image was the only one never measured -- and P2's first condition is a
  // production run (docs/policy/product-research-agent.md §9).
  assert.deepEqual(Object.keys(probe.environments).sort(), ["dev", "production", "staging"]);
  for (const environment of Object.keys(probe.environments)) {
    assert.deepEqual(
      [...probe.environments[environment]].sort(),
      [...probe.environments.staging].sort(),
      environment,
    );
  }
  // S0 measures what the image can do. Nothing about that needs the ability to
  // write a row, so the variables that would allow one are absent -- a probe
  // that could submit is a second writer for the same slot.
  for (const [environment, names] of Object.entries(probe.environments)) {
    assert.equal(names.includes("PRODUCT_RESEARCH_INGEST_URL"), false, environment);
    assert.equal(names.includes("PRODUCT_RESEARCH_INGEST_SECRET"), false, environment);
  }
  const variables = probe.environments.staging;
  // And it runs when an operator runs it, not on a schedule.
  assert.equal(probe.cronSchedule, null);

  // The probe checks its environment against its own shorter list, so the two
  // have to be the same list: a name declared here and not there stops the
  // probe, and a name there and not here is deleted by the next apply.
  assert.deepEqual([...variables].sort(), [...PROBE_SERVICE_VARIABLES].sort());
});

test("both projects deploy the same branch per environment", async () => {
  // The Agent project's staging observes the release candidate the app's
  // staging serves; a project left on develop would compare one build with
  // another.
  const { RAILWAY_ENVIRONMENT_BRANCHES } = await import("../.railway/scheduled-jobs.ts");
  assert.deepEqual(AGENT_ENVIRONMENT_BRANCHES, RAILWAY_ENVIRONMENT_BRANCHES);
  assert.equal(AGENT_ENVIRONMENT_BRANCHES.staging, "test");
});

test("the resource list is exactly the table for that environment, and refuses the unknown", () => {
  const { PRESERVED, dsl } = recordingDsl();

  for (const [environment, branch] of Object.entries(AGENT_ENVIRONMENT_BRANCHES)) {
    // A service that runs an image is declared only once its digest is recorded.
    const expected = AGENT_RUNNER_SERVICES.filter(
      (runner) => runner.environments[environment] && (!runner.image || runner.image.digest !== null)
    );
    const resources = buildAgentRunnerResources(environment, dsl);
    assert.deepEqual(
      resources.map((resource) => resource.name),
      expected.map((runner) => runner.service),
      `${environment}: the resource list drops or adds a service`
    );

    for (const runner of expected) {
      const resource = resources.find((entry) => entry.name === runner.service);
      assert.deepEqual(
        resource.source,
        runner.image
          ? { reference: `${runner.image.reference}@${runner.image.digest}`, autoUpdates: { type: "disabled" } }
          : { repo: "mposition/Tomverse", branch, ...(runner.checkSuites === false ? { checkSuites: false } : {}) }
      );
      assert.equal(resource.start, runner.startCommand);
      assert.deepEqual(resource.deploy, {
        ...(runner.cronSchedule === null ? {} : { cronSchedule: runner.cronSchedule }),
        ...(runner.restart
          ? { restartPolicyType: runner.restart.type, restartPolicyMaxRetries: runner.restart.maxRetries }
          : { restartPolicyType: "NEVER" }),
      });
      assert.deepEqual(
        resource.build,
        runner.dockerfile
          ? { builder: "DOCKERFILE", dockerfilePath: runner.dockerfile.path, watchPatterns: [...runner.dockerfile.watchPatterns] }
          : undefined
      );
      // One replica, in the region the approved APP 8 record names. Railway's
      // default for a new project is `sfo`, so an unnamed region is not a
      // default -- it is a deployment somewhere the record does not say, which
      // is what the first apply produced.
      assert.deepEqual(resource.replicas, { [AGENT_RAILWAY_REGION]: 1 });
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
  // the absence of the key, not a null. Checked in every environment the probe
  // is declared for, because production is the one where a schedule would mean
  // an unattended run against the image P2 is judged on.
  for (const environment of ["production", "staging", "dev"]) {
    const probe = buildAgentRunnerResources(environment, dsl).find(
      (resource) => resource.name === "Product Research Probe"
    );
    assert.ok(probe, `${environment}: the probe is missing`);
    assert.equal(
      Object.prototype.hasOwnProperty.call(probe.deploy, "cronSchedule"),
      false,
      environment
    );
    // And it still cannot write a row there: the names that would let it are
    // absent from the resource, not merely from the table.
    assert.equal("PRODUCT_RESEARCH_INGEST_URL" in probe.env, false, environment);
    assert.equal("PRODUCT_RESEARCH_INGEST_SECRET" in probe.env, false, environment);
  }

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
    ["agents:use:dev", AGENT_RAILWAY_PROJECT],
    ["use:staging", "Tomverse"],
    ["use:production", "Tomverse"],
    ["use:dev", "Tomverse"],
  ]) {
    assert.match(iac.scripts[script], new RegExp(`--project "?${project}"?`), script);
  }

  // The root scripts are the ones an operator runs; a missing one sends them to
  // the dashboard, where the schedules are not the source of truth.
  for (const script of [
    "railway:agents:use-staging",
    "railway:agents:use-production",
    "railway:agents:use-dev",
    "railway:agents:plan",
    "railway:agents:apply",
  ]) {
    assert.ok(root.scripts[script], `package.json has no "${script}" script`);
    assert.match(root.scripts[script], /npm run --prefix \.railway agents:/, script);
  }
});

test("services that can only reach staging or production are not declared in dev", () => {
  // The QA-release digest and monitor submit through an endpoint table naming
  // staging and production only, and billing-finance-ops through a run
  // endpoint table of the same two. In dev each would start and refuse every
  // run, so dev does not get them until their tables name dev.
  for (const key of [
    "qa_release_digest",
    "qa_release_monitor",
    "billing_finance_ops_deadline",
    "qa_release_merge_lane",
    "support_triage_retention",
    "support_triage_worker",
  ]) {
    const runner = AGENT_RUNNER_SERVICES.find((entry) => entry.key === key);
    assert.equal(runner.environments.dev, undefined, key);
  }
  const observation = AGENT_RUNNER_SERVICES.find((entry) => entry.key === "product_research_observation");
  assert.deepEqual([...observation.environments.dev].sort(), [...observation.environments.staging].sort());
});

test("the QA-release services declare exactly the variables their start check accepts", async () => {
  const { QA_RELEASE_SERVICE_VARIABLES } = await import("../lib/qaReleaseServiceEnvCore.ts");
  for (const [key, service] of [["qa_release_digest", "digest"], ["qa_release_monitor", "monitor"]]) {
    const runner = AGENT_RUNNER_SERVICES.find((entry) => entry.key === key);
    assert.ok(runner, key);
    for (const environment of ["production", "staging"]) {
      assert.deepEqual([...runner.environments[environment]].sort(), [...QA_RELEASE_SERVICE_VARIABLES[service]].sort(), `${key} ${environment}`);
    }
  }
  // The Monitor's 30-minute cron, approved by the operator on 2026-10-03.
  assert.equal(AGENT_RUNNER_SERVICES.find((entry) => entry.key === "qa_release_monitor").cronSchedule, "*/30 * * * *");
  assert.equal(AGENT_RUNNER_SERVICES.find((entry) => entry.key === "qa_release_digest").cronSchedule, "0 21 * * *");
});

test("the QA-release services start node directly, so npm adds nothing their start check would refuse", () => {
  for (const key of ["qa_release_digest", "qa_release_monitor"]) {
    const runner = AGENT_RUNNER_SERVICES.find((entry) => entry.key === key);
    assert.match(runner.startCommand, /^node --experimental-strip-types scripts\/qa-release-[a-z]+-service\.mjs$/, key);
  }
});

test("the region is named rather than left to Railway's default", () => {
  // The approved policy's APP 8 record states where this agent processes
  // data. A service placed by default would be in `sfo`, which that record
  // does not say -- and the first apply did exactly that.
  assert.equal(AGENT_RAILWAY_REGION, "asia-southeast1-eqsg3a");

  const { dsl } = recordingDsl();
  for (const environment of Object.keys(AGENT_ENVIRONMENT_BRANCHES)) {
    for (const resource of buildAgentRunnerResources(environment, dsl)) {
      assert.deepEqual(
        resource.replicas,
        { [AGENT_RAILWAY_REGION]: 1 },
        `${environment}/${resource.name}`,
      );
    }
  }
});

test("the billing-finance-ops trigger declares exactly the variables its start check accepts, and starts node directly", async () => {
  const { BILLING_FINANCE_OPS_SERVICE_VARIABLES } = await import("../lib/billingFinanceOpsServiceCore.ts");
  const runner = AGENT_RUNNER_SERVICES.find((entry) => entry.key === "billing_finance_ops_deadline");
  assert.ok(runner);
  for (const environment of ["production", "staging"]) {
    assert.deepEqual([...runner.environments[environment]].sort(), [...BILLING_FINANCE_OPS_SERVICE_VARIABLES].sort(), environment);
  }
  // docs/policy/billing-finance-ops.md §1.1: once a day at 01:00 UTC.
  assert.equal(runner.cronSchedule, "0 1 * * *");
  assert.equal(runner.startCommand, "node --experimental-strip-types scripts/billing-finance-ops-trigger-service.mjs");
});

test("the merge lane runs in production only, every 10 minutes, with exactly its start check's variables", async () => {
  const { QA_RELEASE_SERVICE_VARIABLES } = await import("../lib/qaReleaseServiceEnvCore.ts");
  const runner = AGENT_RUNNER_SERVICES.find((entry) => entry.key === "qa_release_merge_lane");
  assert.ok(runner);
  assert.deepEqual(Object.keys(runner.environments), ["production"]);
  assert.deepEqual([...runner.environments.production].sort(), [...QA_RELEASE_SERVICE_VARIABLES.mergeLane].sort());
  assert.equal(runner.cronSchedule, "*/10 * * * *");
  assert.equal(runner.startCommand, "node --experimental-strip-types scripts/qa-release-merge-lane-service.mjs");
});

test("the repository the run clones is the one the services deploy from", () => {
  // Two files name a repository: the IaC gives it to Railway as the services'
  // source, and the step core clones it. A run that cloned a different one
  // would answer for a backlog that is not this product's while looking
  // exactly like a correct run, and nothing downstream could tell.
  assert.equal(OBSERVED_REPOSITORY, AGENT_RAILWAY_REPOSITORY);
});

test("the Support Triage services declare exactly the variable their start check accepts, and start node directly", async () => {
  const { supportTriageServiceVariables } = await import("../lib/supportTriageServiceCore.ts");
  for (const [key, kind] of [["support_triage_worker", "worker"], ["support_triage_retention", "retention"]]) {
    const runner = AGENT_RUNNER_SERVICES.find((entry) => entry.key === key);
    assert.ok(runner, key);
    for (const environment of ["production", "staging"]) {
      assert.deepEqual([...runner.environments[environment]].sort(), [...supportTriageServiceVariables(kind)].sort(), `${key} ${environment}`);
    }
    // docs/policy/support-triage.md §3: both every 30 minutes.
    assert.equal(runner.cronSchedule, "*/30 * * * *", key);
    assert.equal(runner.startCommand, `node --experimental-strip-types scripts/support-triage-${kind}-service.mjs`, key);
  }
});

test("the sre-ops page service declares the supervisor's page list at S1b, production only", async () => {
  // docs/policy/sre-ops.md §7, §8: the supervisor refuses a name outside its
  // page list, and the page webhook exists from S2 only. Declaring it here
  // would put a send capability on a shadow service.
  const { SERVICE_VARIABLES } = await import("../scripts/ops-observer/runtime-variables-core.mjs");
  const { PRODUCTION_ORIGIN } = await import("../scripts/ops-observer/content-guard-core.mjs");
  const page = AGENT_RUNNER_SERVICES.find((runner) => runner.key === "ops_observer_page");
  assert.ok(page, "the page service is declared");
  assert.equal(page.service, "Ops Observer");
  assert.equal(page.startCommand, "node scripts/ops-observer/supervise.mjs page");
  assert.equal(page.cronSchedule, "*/10 * * * *");
  assert.deepEqual(Object.keys(page.environments), ["production"]);
  assert.equal(PRODUCTION_ORIGIN, "https://tomverse.app");
  assert.deepEqual(
    [...page.environments.production].sort(),
    SERVICE_VARIABLES.page.filter((name) => name !== "OPS_OBSERVER_PAGE_WEBHOOK_URL").sort(),
  );
  assert.equal(page.environments.production.includes("OPS_OBSERVER_PAGE_WEBHOOK_URL"), false);
});

test("the sre-ops digest service declares the supervisor's digest list, daily at 07:00 Brisbane, production only", async () => {
  const { SERVICE_VARIABLES } = await import("../scripts/ops-observer/runtime-variables-core.mjs");
  const { CHILD_SCRIPTS } = await import("../scripts/ops-observer/supervise.mjs");
  const digest = AGENT_RUNNER_SERVICES.find((runner) => runner.key === "ops_observer_digest");
  assert.ok(digest, "the digest service is declared");
  assert.equal(digest.service, "Ops Observer Digest");
  assert.equal(digest.startCommand, "node scripts/ops-observer/supervise.mjs digest");
  // 21:00 UTC is 07:00 in Brisbane (UTC+10, no daylight saving).
  assert.equal(digest.cronSchedule, "0 21 * * *");
  assert.deepEqual(Object.keys(digest.environments), ["production"]);
  assert.deepEqual([...digest.environments.production].sort(), [...SERVICE_VARIABLES.digest].sort());
  // The child the supervisor starts for it exists.
  assert.ok(existsSync(CHILD_SCRIPTS.digest), CHILD_SCRIPTS.digest);
});

test("the AMUX orchestrator is a long-running production service that cannot run commands", () => {
  // development-agent-orchestration.md, version 28.
  const runner = AGENT_RUNNER_SERVICES.find((entry) => entry.key === "amux_orchestrator");
  assert.ok(runner, "the orchestrator is not declared");
  assert.equal(runner.service, "AMUX Orchestrator");
  assert.equal(runner.cronSchedule, null, "a cron would stop the loop between runs");
  assert.deepEqual(runner.restart, { type: "ON_FAILURE", maxRetries: 10 });
  assert.equal(runner.checkSuites, false, "version 20 item 10: a merge deploys at once");
  assert.deepEqual(Object.keys(runner.environments), ["production"], "staging has no orchestrator");
  assert.deepEqual([...runner.environments.production].sort(), [
    "TOMVERSE_AMUX_CLAIM",
    "TOMVERSE_AMUX_ENABLED",
    "TOMVERSE_AMUX_SYNC_SECRET",
    "TOMVERSE_AMUX_WORKER_CATALOG_JSON",
    "TOMVERSE_INTERNAL_URL",
  ]);
  for (const name of runner.environments.production) {
    assert.doesNotMatch(name, /EXECUTE|EXECUTOR|WSL|DATABASE|API_KEY/, `${name} would let the service run commands or reach a store`);
  }
  // The build stays the one it had: its own Dockerfile, rebuilt only when the
  // orchestrator's sources change.
  assert.equal(runner.dockerfile.path, "apps/tomverse-orchestrator/Dockerfile");
  assert.ok(existsSync(join(process.cwd(), runner.dockerfile.path)));
  assert.deepEqual([...runner.dockerfile.watchPatterns], [
    "apps/tomverse-orchestrator/**",
    "crates/amux-core/**",
    "Cargo.toml",
    "Cargo.lock",
  ]);
  // Every other service still never restarts.
  for (const other of AGENT_RUNNER_SERVICES.filter((entry) => entry !== runner)) {
    assert.equal(other.restart, undefined, `${other.service} restarts`);
  }
});
