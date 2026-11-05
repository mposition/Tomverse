import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AGENT_RUNNER_SERVICES } from "../.railway/agent-runners.ts";
import {
  CHILD_TIMEOUT_MS,
  DECLARED_PERIOD_MS,
  ROUTE_BUDGET_MS,
  SUPERVISOR_KILL_MS,
} from "../lib/trustSafetyBoundsCore.ts";
import {
  CHILD_TIMEOUT_MS as SERVICE_CHILD_TIMEOUT_MS,
  DECLARED_PERIOD_CRON,
  SUPERVISOR_DEADLINE_MS,
} from "../scripts/trust-safety/timing-core.mjs";
import {
  SERVICE_VARIABLES,
  buildEnvironmentViolations,
  childEnvironment,
  isCredentialShaped,
  judgeEnvironmentNames,
} from "../scripts/trust-safety/runtime-variables-core.mjs";
import { EXIT, planStart, supervise } from "../scripts/trust-safety/supervise.mjs";
import { EXIT as CHILD_EXIT, observeOnce } from "../scripts/trust-safety/observe.mjs";

/**
 * The Railway cron service (docs/policy/trust-safety-compliance-agent.md §4,
 * §12 (1) tables A and C).
 *
 * The service image holds no TypeScript, so its two timeouts are written in a
 * `.mjs` core as well as in the policy table the app reads. These hold the two
 * equal, which is the only thing that keeps a figure duplicated across two
 * runtimes honest.
 */

const DOCKERFILE = "docker/trust-safety-observer.Dockerfile";

const runner = () =>
  AGENT_RUNNER_SERVICES.find((candidate) => candidate.key === "trust_safety_observer");

test("the service is declared, in production only, and never restarted", () => {
  const service = runner();
  assert.ok(service, "the runner is declared");
  assert.equal(service.service, "Trust Safety Observer");
  assert.deepEqual(Object.keys(service.environments), ["production"]);
  // An absent `restart` is never-restart, which is what §5.5 wants: a run that
  // failed is not retried, and the next period starts fresh.
  assert.equal(service.restart, undefined);
});

test("the schedule is §12 table A's declared period, in both places", () => {
  const service = runner();
  assert.equal(service.cronSchedule, "*/30 * * * *");
  assert.equal(service.cronSchedule, DECLARED_PERIOD_CRON);
  // Thirty minutes is what the dead-man window is four times (§12 table A).
  assert.equal(DECLARED_PERIOD_MS, 30 * 60_000);
});

test("the two timeouts are the policy's, in the service and in the app", () => {
  assert.equal(SERVICE_CHILD_TIMEOUT_MS, CHILD_TIMEOUT_MS);
  assert.equal(SUPERVISOR_DEADLINE_MS, SUPERVISOR_KILL_MS);
  assert.equal(CHILD_TIMEOUT_MS, 69_000);
  assert.equal(SUPERVISOR_DEADLINE_MS, 99_000);
  // The outer ordering §12 fixes: the route's budget, then the child, then the
  // supervisor, with ten and thirty seconds between them.
  assert.equal(CHILD_TIMEOUT_MS - ROUTE_BUDGET_MS, 10_000);
  assert.equal(SUPERVISOR_DEADLINE_MS - CHILD_TIMEOUT_MS, 30_000);
  assert.ok(SUPERVISOR_DEADLINE_MS < DECLARED_PERIOD_MS, "a run ends before the next period");
});

test("the IaC variable list is exactly the service's own two", () => {
  // §4: two names and that is all. The IaC list and the list the supervisor
  // enforces have to be the same list, or an apply creates a name the service
  // refuses to start on -- or withholds one it needs.
  const service = runner();
  assert.deepEqual([...service.environments.production], [...SERVICE_VARIABLES]);
  assert.deepEqual(
    [...SERVICE_VARIABLES],
    ["TRUST_SAFETY_OBSERVER_SECRET", "TRUST_SAFETY_OBSERVER_URL"],
  );
  // Not the ping URL, not a database credential, and no enable switch: the
  // switch is the activation row (§6).
  for (const name of SERVICE_VARIABLES) {
    assert.doesNotMatch(name, /PING_URL|DATABASE|ENABLED/);
  }
});

test("the build setting is the Dockerfile field, not a third variable", () => {
  // Using `RAILWAY_DOCKERFILE_PATH` the way the ops services do would put a
  // third name in a list §4 closes at two.
  const service = runner();
  assert.equal(service.dockerfile.path, DOCKERFILE);
  assert.ok(service.dockerfile.watchPatterns.includes("scripts/trust-safety/**"));
  assert.ok(!service.environments.production.includes("RAILWAY_DOCKERFILE_PATH"));
});

test("the supervisor refuses a name that is not allowed, by name", () => {
  const plan = planStart({
    TRUST_SAFETY_OBSERVER_SECRET: "s".repeat(32),
    TRUST_SAFETY_OBSERVER_URL: "https://tomverse.app",
    DATABASE_URL: "postgres://nobody@nowhere/db",
  });
  assert.equal(plan.action, "config_error");
  assert.equal(plan.reason, "env_not_allowed");
  assert.deepEqual(plan.names, ["DATABASE_URL"]);
  // Names, never values: a refusal is printed where a deploy log can be read.
  assert.ok(!JSON.stringify(plan).includes("postgres://"));
});

test("the ping URL is refused by shape, which is why §4 keeps it in the app", () => {
  assert.equal(isCredentialShaped("TRUST_SAFETY_OBSERVER_PING_URL"), true);
  const plan = planStart({
    TRUST_SAFETY_OBSERVER_SECRET: "s".repeat(32),
    TRUST_SAFETY_OBSERVER_URL: "https://tomverse.app",
    TRUST_SAFETY_OBSERVER_PING_URL: "https://monitor.example/abc",
  });
  assert.equal(plan.action, "config_error");
  assert.ok(plan.names.includes("TRUST_SAFETY_OBSERVER_PING_URL"));
});

test("a missing variable stops the service before a child exists", () => {
  const plan = planStart({ TRUST_SAFETY_OBSERVER_URL: "https://tomverse.app" });
  assert.equal(plan.action, "config_error");
  assert.equal(plan.reason, "env_missing");
  assert.deepEqual(plan.names, ["TRUST_SAFETY_OBSERVER_SECRET"]);
});

test("Railway's own names and the base image's do not stop it", () => {
  const plan = planStart({
    TRUST_SAFETY_OBSERVER_SECRET: "s".repeat(32),
    TRUST_SAFETY_OBSERVER_URL: "https://tomverse.app",
    PATH: "/usr/bin",
    NODE_ENV: "production",
    RAILWAY_SERVICE_NAME: "Trust Safety Observer",
    RAILWAY_BETA_ENABLE_RUNTIME_V2: "true",
  });
  assert.equal(plan.action, "start");
  // The child gets the two it needs and nothing else.
  assert.deepEqual(Object.keys(plan.childEnv).sort(), [...SERVICE_VARIABLES].sort());
});

test("the child's environment carries only what is present", () => {
  assert.deepEqual(childEnvironment({ TRUST_SAFETY_OBSERVER_URL: "x" }), {
    TRUST_SAFETY_OBSERVER_URL: "x",
  });
});

test("the build gate refuses the secret and anything credential-shaped", () => {
  assert.deepEqual(buildEnvironmentViolations(["TRUST_SAFETY_OBSERVER_URL", "NODE_ENV"]), []);
  assert.deepEqual(
    buildEnvironmentViolations(["TRUST_SAFETY_OBSERVER_SECRET", "GH_TOKEN", "NODE_ENV"]),
    ["GH_TOKEN", "TRUST_SAFETY_OBSERVER_SECRET"],
  );
});

test("an environment with a bad name is judged without reading values", () => {
  const verdict = judgeEnvironmentNames(["TRUST_SAFETY_OBSERVER_SECRET", "SOME_API_KEY"]);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.notAllowed, ["SOME_API_KEY"]);
  assert.deepEqual(verdict.credentialShaped, ["SOME_API_KEY"]);
});

test("the supervisor hands back the child's exit code", async () => {
  const child = fakeChild();
  const result = supervise({
    env: startableEnv(),
    spawnChild: () => child,
    log: () => {},
  });
  child.emit("exit", 0, null);
  assert.equal(await result, 0);
});

test("a child that overruns the deadline is SIGKILLed and the run fails", async () => {
  const child = fakeChild();
  const result = supervise({
    env: startableEnv(),
    spawnChild: () => child,
    deadlineMs: 5,
    log: () => {},
  });
  assert.equal(await result, EXIT.childKilled);
  assert.deepEqual(child.signals, ["SIGKILL"], "SIGKILL, not a signal the child can ignore");
});

test("the Dockerfile asks for no build argument and runs the gate first", () => {
  // §4: Railway exposes a variable to a build only when the Dockerfile asks
  // for it with ARG, so asking for none keeps every runtime secret out.
  const dockerfile = readFileSync(DOCKERFILE, "utf8");
  assert.doesNotMatch(dockerfile, /^ARG /m);
  assert.doesNotMatch(dockerfile, /--mount=type=secret/);
  const gate = dockerfile.indexOf("RUN node scripts/trust-safety/build-env-gate.mjs");
  const rest = dockerfile.indexOf("COPY scripts/trust-safety/ ");
  assert.ok(gate > 0 && rest > gate, "the gate runs before the rest is copied");
  // Node and the service's own modules: no install, no application code.
  assert.doesNotMatch(dockerfile, /npm (ci|install)|pnpm|yarn add/);
  assert.doesNotMatch(dockerfile, /COPY (lib|app|prisma|components)/);
  assert.match(dockerfile, /ENTRYPOINT \["node", "scripts\/trust-safety\/supervise\.mjs"\]/);
  assert.match(dockerfile, /^USER observer$/m);
});

test("the child makes one POST with the bearer secret, and no body or query", async () => {
  // §4: the route reads neither the body nor the query, so the child sends
  // neither. The secret travels as a bearer header, which is the discipline
  // the marketing automation precedent set.
  const calls = [];
  const code = await observeOnce({
    env: startableEnv(),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ outcome: "disabled" }), { status: 200 });
    },
    log: () => {},
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1, "one request per run");
  assert.equal(calls[0].url, "https://tomverse.app/api/internal/trust-safety/observe");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${"s".repeat(32)}`);
  assert.ok(calls[0].init.signal instanceof AbortSignal, "the caller's timeout (§4)");
  assert.ok(!calls[0].url.includes("?"), "no query");
});

test("the child reports a refusal and a failure as different exit codes", async () => {
  const refused = await observeOnce({
    env: startableEnv(),
    fetchImpl: async () => new Response(JSON.stringify({ outcome: "failed" }), { status: 500 }),
    log: () => {},
  });
  assert.equal(refused, CHILD_EXIT.routeRefused);

  const threw = await observeOnce({
    env: startableEnv(),
    fetchImpl: async () => {
      throw new Error("aborted");
    },
    log: () => {},
  });
  assert.equal(threw, CHILD_EXIT.requestFailed);
});

test("the child logs only the enum §4 closes, never a string from the body", async () => {
  // A log line is the one place free text from a response could reach an
  // operator's screen, so the closed set is enforced rather than described.
  const lines = [];
  await observeOnce({
    env: startableEnv(),
    fetchImpl: async () =>
      new Response(JSON.stringify({ outcome: "unexpected free text" }), { status: 200 }),
    log: (line) => lines.push(line),
  });
  const logged = lines.join("\n");
  assert.match(logged, /"outcome":"unknown"/);
  assert.doesNotMatch(logged, /unexpected free text/);

  for (const outcome of ["ran", "disabled", "failed"]) {
    const kept = [];
    await observeOnce({
      env: startableEnv(),
      fetchImpl: async () => new Response(JSON.stringify({ outcome }), { status: 200 }),
      log: (line) => kept.push(line),
    });
    assert.match(kept.join("\n"), new RegExp(`"outcome":"${outcome}"`), outcome);
  }
});

test("the child refuses to run with a variable missing, naming it only", async () => {
  const lines = [];
  const code = await observeOnce({
    env: { TRUST_SAFETY_OBSERVER_URL: "https://tomverse.app" },
    fetchImpl: async () => {
      throw new Error("should not be called");
    },
    log: (line) => lines.push(line),
  });
  assert.equal(code, CHILD_EXIT.configError);
  assert.match(lines.join("\n"), /TRUST_SAFETY_OBSERVER_SECRET/);
  assert.doesNotMatch(lines.join("\n"), /Bearer|sssss/);
});

test("a trailing slash on the service's URL does not double the path", async () => {
  const calls = [];
  await observeOnce({
    env: { ...startableEnv(), TRUST_SAFETY_OBSERVER_URL: "https://tomverse.app/" },
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response("{}", { status: 200 });
    },
    log: () => {},
  });
  assert.equal(calls[0], "https://tomverse.app/api/internal/trust-safety/observe");
});

const startableEnv = () => ({
  TRUST_SAFETY_OBSERVER_SECRET: "s".repeat(32),
  TRUST_SAFETY_OBSERVER_URL: "https://tomverse.app",
});

/** A ChildProcess stand-in: the two events the supervisor listens for. */
const fakeChild = () => {
  const handlers = new Map();
  return {
    signals: [],
    on(event, handler) {
      handlers.set(event, handler);
      return this;
    },
    emit(event, ...args) {
      handlers.get(event)?.(...args);
    },
    kill(signal) {
      this.signals.push(signal);
    },
  };
};
