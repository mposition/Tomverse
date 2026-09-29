import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import test from "node:test";

import {
  ENGINEERING_AGENT_IMAGE,
  RAILWAY_AGENT_SERVICES,
  RAILWAY_CRON_SERVICES,
  buildScheduledJobResources,
} from "../.railway/scheduled-jobs.ts";
import { PUBLISHER_HARD_DEADLINE_MS, PUBLISHER_VARIABLES } from "../scripts/engineering-agent-publisher.mjs";
import { RUNNER_HARD_DEADLINE_MS, RUNNER_VARIABLES } from "../scripts/engineering-agent-runner.mjs";

// The engineering agent's two services as deployed (docs/policy/engineering-
// agent.md §8, §12): one image built on main with nothing but the services'
// import closure, run by digest in production only, with exactly the
// variables each service reads, and a schedule no cycle can outlive.

const ENTRIES = ["scripts/engineering-agent-runner.mjs", "scripts/engineering-agent-publisher.mjs"];

const importClosure = () => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gms)) {
      if (match[1].startsWith("node:")) continue;
      visit(normalize(join(dirname(file), match[1])).replaceAll("\\", "/"));
    }
  };
  for (const entry of ENTRIES) visit(entry);
  return [...seen].sort();
};

const service = (key) => {
  const found = RAILWAY_AGENT_SERVICES.find((entry) => entry.key === key);
  assert.ok(found, key);
  return found;
};

test("the image holds the services' import closure and nothing else", () => {
  const dockerfile = readFileSync("docker/engineering-agent.Dockerfile", "utf8");
  const copied = [...dockerfile.matchAll(/^COPY (\S+) (\S+)$/gm)].map((match) => {
    assert.equal(match[1], match[2], "each file keeps its repository path");
    return match[1];
  });
  assert.deepEqual([...copied].sort(), importClosure());
  assert.doesNotMatch(dockerfile, /npm (install|ci)|node_modules|COPY \. /, "nothing is installed and the tree is not copied");
  assert.match(dockerfile, /^USER agent$/m);
});

test("the image is built on main only, without a repository secret or a cache", () => {
  const workflow = readFileSync(".github/workflows/engineering-agent-image.yml", "utf8");
  assert.match(workflow, /on:\n {2}push:\n {4}branches: \[main\]\n/);
  assert.doesNotMatch(workflow, /pull_request|workflow_dispatch|schedule:/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(workflow, /secrets\./, "no repository secret");
  assert.doesNotMatch(workflow, /actions\/cache|cache-from|cache-to/, "no cache");
  assert.match(workflow, /--no-cache/);
  assert.match(workflow, /permissions:\n {2}contents: read\n {2}packages: write\n/);
  for (const file of importClosure()) {
    assert.ok(workflow.includes(`      - ${file}\n`), `a change to ${file} rebuilds the image`);
  }
  assert.ok(workflow.includes(ENGINEERING_AGENT_IMAGE));
});

test("each service declares exactly the variables it reads, in production only", () => {
  const runner = service("engineeringAgentRunner");
  const publisher = service("engineeringAgentPublisher");
  assert.deepEqual([...runner.variables.production].sort(), [...RUNNER_VARIABLES].sort());
  assert.deepEqual([...publisher.variables.production].sort(), [...PUBLISHER_VARIABLES].sort());
  for (const entry of RAILWAY_AGENT_SERVICES) {
    assert.deepEqual(Object.keys(entry.variables), ["production"], `${entry.service} runs in production only`);
  }
  assert.ok(!RUNNER_VARIABLES.some((name) => /PUBLISHER|PRIVATE_KEY|DATABASE|AMUX/.test(name)));
  assert.ok(!PUBLISHER_VARIABLES.some((name) => /ANTHROPIC|RUNNER|DATABASE|AMUX/.test(name)));
});

test("no cycle outlives its schedule, and each service runs its own entry point", () => {
  const minutes = (cron) => Number(/^\*\/(\d+) \* \* \* \*$/.exec(cron)?.[1]);
  const runner = service("engineeringAgentRunner");
  const publisher = service("engineeringAgentPublisher");
  assert.ok(minutes(runner.cronSchedule) * 60_000 > RUNNER_HARD_DEADLINE_MS);
  assert.ok(minutes(publisher.cronSchedule) * 60_000 > PUBLISHER_HARD_DEADLINE_MS);
  assert.match(runner.startCommand, /scripts\/engineering-agent-runner\.mjs$/);
  assert.match(publisher.startCommand, /scripts\/engineering-agent-publisher\.mjs$/);
});

test("a service with no recorded digest is not declared; a recorded one runs by digest with updates off", () => {
  const PRESERVED = Symbol("preserve");
  const dsl = {
    github: (repo, options) => ({ kind: "github", repo, ...options }),
    image: (reference, options) => ({ kind: "image", reference, ...options }),
    preserve: () => PRESERVED,
    service: (name, config) => ({ name, ...config }),
  };
  for (const entry of RAILWAY_AGENT_SERVICES) {
    assert.ok(entry.digest === null || /^sha256:[0-9a-f]{64}$/.test(entry.digest), `${entry.service} digest`);
  }
  const names = (environment) => buildScheduledJobResources(environment, dsl).map((resource) => resource.name);
  assert.deepEqual(names("staging"), RAILWAY_CRON_SERVICES.map((job) => job.service), "staging never runs the agent");

  const digest = `sha256:${"a".repeat(64)}`;
  const original = RAILWAY_AGENT_SERVICES.map((entry) => entry.digest);
  try {
    for (const entry of RAILWAY_AGENT_SERVICES) entry.digest = digest;
    const resources = buildScheduledJobResources("production", dsl);
    for (const entry of RAILWAY_AGENT_SERVICES) {
      const resource = resources.find((candidate) => candidate.name === entry.service);
      assert.deepEqual(resource.source, {
        kind: "image",
        reference: `${ENGINEERING_AGENT_IMAGE}@${digest}`,
        autoUpdates: { type: "disabled" },
      });
      assert.deepEqual(resource.deploy, { cronSchedule: entry.cronSchedule, restartPolicyType: "NEVER" });
      assert.ok(Object.values(resource.env).every((value) => value === PRESERVED));
    }
    assert.deepEqual(names("staging"), RAILWAY_CRON_SERVICES.map((job) => job.service));
    RAILWAY_AGENT_SERVICES[0].digest = "latest";
    assert.throws(() => buildScheduledJobResources("production", dsl), /not a sha256 digest/);
  } finally {
    RAILWAY_AGENT_SERVICES.forEach((entry, index) => {
      entry.digest = original[index];
    });
  }
});
