import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CRON_TRIGGERS,
  SCHEDULED_JOB_DEFINITIONS,
  SILENCE_SLACK_MINUTES,
  cronTriggerFor,
  cronTriggerIntervalMs,
  describeCronTrigger,
  evaluateScheduledJobTiming,
  nextScheduledAt,
  parseCronSchedule,
  silenceBudgetMsFor,
} from "../lib/scheduledJobsCore.ts";
import {
  RAILWAY_CRON_SERVICES,
  RAILWAY_ENVIRONMENT_BRANCHES,
  buildScheduledJobResources,
} from "../.railway/scheduled-jobs.ts";

// SCHED-DRIFT-001. railway.credit-reconciliation.json moved from */5 to */15
// and lib/scheduledJobs.ts was not moved with it, so the credit-reconciliation
// job carried a 12-minute silence budget against a 15-minute cadence and was
// reported "delayed" for the last ~3 minutes of every cycle.
//
// SCHED-DRIFT-002. That fix covered the two every-N-minutes crons. The three
// daily ones kept writing their time out in the prose, in the next-run estimate
// and in the cron file separately, and the assertion below read neither of the
// last two -- so the same drift was still available to them. It is the whole
// table now, in both directions: every declared trigger against the service that
// deploys it, and every deployed cron service against the table.
//
// Two kinds of test below. The first reads the Railway cron declarations
// themselves -- .railway/scheduled-jobs.ts, which .railway/railway.ts deploys --
// so the TypeScript catalogue cannot drift from the deployed schedule again
// without going red. The second pins the timing decisions on a fixed clock,
// including the exact boundaries the old values got wrong.

const MINUTE_MS = 60 * 1_000;

const jobByKey = (key) => {
  const definition = SCHEDULED_JOB_DEFINITIONS.find((job) => job.key === key);
  assert.ok(definition, `no scheduled job definition for ${key}`);
  return definition;
};

const railwayCronService = (serviceName) => {
  const matches = RAILWAY_CRON_SERVICES.filter((job) => job.service === serviceName);
  assert.equal(
    matches.length,
    1,
    `.railway/scheduled-jobs.ts declares "${serviceName}" ${matches.length} times`
  );
  return matches[0];
};

test("every declared trigger matches the Railway cron that actually drives it", () => {
  for (const [name, { railwayService, trigger }] of Object.entries(CRON_TRIGGERS)) {
    const { cronSchedule: cron } = railwayCronService(railwayService);
    const deployed = parseCronSchedule(cron);
    assert.ok(
      deployed,
      `${railwayService} uses "${cron}", which parseCronSchedule cannot read. If the ` +
        `schedule is no longer one of the two shapes this repository deploys, ` +
        `teach the parser the new shape rather than deleting the check.`
    );
    assert.deepEqual(
      deployed,
      { ...trigger },
      `${name} declares ${describeCronTrigger(trigger)}, but Railway service ` +
        `${railwayService} deploys "${cron}"`
    );
  }
});

test("every deployed cron service is claimed by exactly one trigger", () => {
  // The other direction. Without it a new cron service could be deployed with
  // no catalogue entry, and the dashboard would simply never mention the job it
  // runs -- which reads identically to a job that is healthy.
  const deployed = RAILWAY_CRON_SERVICES.map((job) => job.service);
  const claimed = Object.values(CRON_TRIGGERS).map((entry) => entry.railwayService);
  assert.deepEqual([...claimed].sort(), [...deployed].sort());
  assert.equal(new Set(claimed).size, claimed.length, "two triggers share a service");
  assert.deepEqual(
    RAILWAY_CRON_SERVICES.map((job) => job.key).sort(),
    Object.keys(CRON_TRIGGERS).sort(),
    "the IaC table and the catalogue key the same jobs differently"
  );
});

test("the IaC cron table names a real script and a variable list for each environment", () => {
  const scripts = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).scripts;
  for (const job of RAILWAY_CRON_SERVICES) {
    const script = /^npm run ([\w:-]+)$/.exec(job.startCommand)?.[1];
    assert.ok(script, `${job.service}: start command "${job.startCommand}" is not an npm script`);
    assert.ok(scripts[script], `${job.service}: package.json has no "${script}" script`);
    for (const environment of Object.keys(RAILWAY_ENVIRONMENT_BRANCHES)) {
      const variables = job.variables[environment];
      // An empty list is not "no variables": applying it deletes every variable
      // the service has in that environment.
      assert.ok(
        Array.isArray(variables) && variables.length > 0,
        `${job.service} declares no variables for ${environment}`
      );
      assert.equal(new Set(variables).size, variables.length, `${job.service}: duplicate variable`);
    }
  }
});

test("the IaC resource list is exactly the table, per environment, and refuses the unknown", () => {
  // railway.ts is a pass-through to buildScheduledJobResources(), so this is
  // the graph an apply would act on. A service missing here is a service the
  // named partial deletes; a variable missing here is a variable it deletes.
  const PRESERVED = Symbol("preserve");
  const dsl = {
    github: (repo, options) => ({ repo, ...options }),
    preserve: () => PRESERVED,
    service: (name, config) => ({ name, ...config }),
  };
  for (const [environment, branch] of Object.entries(RAILWAY_ENVIRONMENT_BRANCHES)) {
    const resources = buildScheduledJobResources(environment, dsl);
    assert.deepEqual(
      resources.map((resource) => resource.name),
      RAILWAY_CRON_SERVICES.map((job) => job.service),
      `${environment}: the resource list drops or adds a service`
    );
    for (const job of RAILWAY_CRON_SERVICES) {
      const resource = resources.find((entry) => entry.name === job.service);
      assert.deepEqual(resource.source, { repo: "mposition/Tomverse", branch });
      assert.equal(resource.start, job.startCommand);
      assert.deepEqual(resource.deploy, {
        cronSchedule: job.cronSchedule,
        restartPolicyType: "NEVER",
      });
      assert.deepEqual(Object.keys(resource.env).sort(), [...job.variables[environment]].sort());
      assert.ok(
        Object.values(resource.env).every((value) => value === PRESERVED),
        `${environment}/${job.service}: a variable value is written instead of preserved`
      );
    }
  }
  for (const environment of ["pr-1234", "Production", "", undefined]) {
    assert.throws(() => buildScheduledJobResources(environment, dsl), /No scheduled-job configuration/);
  }
  assert.equal(
    new Set(RAILWAY_CRON_SERVICES.map((job) => job.startCommand)).size,
    RAILWAY_CRON_SERVICES.length,
    "two cron services run the same command"
  );
});

test("the IaC entry point stays a pass-through owning only the scheduled-jobs partial", () => {
  const source = readFileSync(join(process.cwd(), ".railway", "railway.ts"), "utf8");
  assert.match(source, /export const partial = "scheduled-jobs";/);
  assert.match(source, /resources: buildScheduledJobResources\(ctx\.environment, \{/);
  // Anything that reshapes the list here escapes the test above.
  for (const reshaping of [".filter(", ".slice(", ".concat(", "...", ".map("]) {
    assert.ok(!source.includes(reshaping), `.railway/railway.ts reshapes resources with ${reshaping}`);
  }
});

test("no Railway Config as Code file comes back", () => {
  // The five railway.*.json cron files were removed on 2026-09-17, after both
  // environments were applied from .railway/railway.ts and detached from them
  // (docs/ops/railway-iac-scheduled-jobs.md). Railway stops reading Config as
  // Code on 2026-12-01, and until then a file named here would be silently
  // honoured by any service whose Config File Path still points at it -- a
  // second source of truth for a schedule the IaC table already owns.
  const configAsCode = readdirSync(process.cwd()).filter((entry) =>
    /^railway(\..+)?\.(json|toml)$/.test(entry)
  );
  assert.deepEqual(configAsCode, [], "declare cron services in .railway/scheduled-jobs.ts instead");
});

test("every job's silence budget outlasts one cycle of its own trigger", () => {
  // The defect in one assertion: a budget at or under the interval reports a
  // healthy run as late on every single cycle. Derived from each job's trigger
  // rather than a hand-written list, so a new job is covered by existing.
  for (const definition of SCHEDULED_JOB_DEFINITIONS) {
    const intervalMs = cronTriggerIntervalMs(cronTriggerFor(definition.key));
    assert.ok(
      definition.maximumSilenceMs > intervalMs,
      `${definition.key}: budget ${definition.maximumSilenceMs / MINUTE_MS}min must ` +
        `exceed its ${intervalMs / MINUTE_MS}min interval`
    );
  }
});

test("the schedule a job displays states the schedule it actually runs at", () => {
  // The string is what an operator reads on the admin Jobs screen, so it is
  // held to the same standard as the numbers beside it. Pinned here as well as
  // derived in the catalogue, because a derivation that changed everything at
  // once would move this copy without anyone reading it.
  assert.equal(jobByKey("credit_reservation_reconciliation").schedule, "Every 15 minutes");
  assert.equal(
    jobByKey("notification_delivery_retry").schedule,
    "Every 15 minutes via credit reconciliation cron"
  );
  assert.equal(
    jobByKey("infrastructure_threshold_monitor").schedule,
    "Every 15 minutes via credit reconciliation cron"
  );
  assert.equal(jobByKey("provider_probe").schedule, "Every 10 minutes");
  assert.equal(jobByKey("retention_cleanup").schedule, "Daily at 03:00 UTC");
  assert.equal(
    jobByKey("provider_model_catalog_monitor").schedule,
    "Daily at 00:00 UTC (10:00 Australia/Brisbane)"
  );
  assert.equal(jobByKey("provider_usage_sync").schedule, "Daily at 00:30 UTC");
});

test("a cron shape this repository does not deploy is refused, not guessed", () => {
  assert.deepEqual(parseCronSchedule("*/15 * * * *"), {
    kind: "everyMinutes",
    minutes: 15,
  });
  assert.deepEqual(parseCronSchedule(" 30 0 * * * "), {
    kind: "dailyUtc",
    hour: 0,
    minute: 30,
  });
  // Weekly, hourly-with-offset and multi-value fields all mean something this
  // catalogue cannot express, so reading them would produce a wrong estimate
  // rather than a missing one.
  for (const expression of ["0 3 * * 1", "0 */4 * * *", "0 0,12 * * *", "@daily", ""]) {
    assert.equal(parseCronSchedule(expression), null, expression);
  }
});

test("the credit reconciliation budget is one cadence plus the shared slack", () => {
  assert.equal(SILENCE_SLACK_MINUTES, 20);
  assert.equal(silenceBudgetMsFor(15), 35 * MINUTE_MS);
  assert.equal(
    jobByKey("credit_reservation_reconciliation").maximumSilenceMs,
    35 * MINUTE_MS
  );
});

test("the probe keeps its tighter budget, under the 30-minute freshness window", () => {
  // Deliberately not silenceBudgetMsFor(10) === 30min, which would collide with
  // PROVIDER_PUBLIC_STATUS_FRESHNESS_MINUTES and make two different failures
  // indistinguishable on the public status page.
  assert.equal(jobByKey("provider_probe").maximumSilenceMs, 25 * MINUTE_MS);
});

test("a healthy 15-minute cadence is never reported delayed", () => {
  const budget = jobByKey("credit_reservation_reconciliation").maximumSilenceMs;
  const lastRunStartedAt = new Date("2026-08-01T07:46:00.000Z");

  // The window the old 12-minute budget got wrong: minutes 12 to 15 of a cycle
  // in which the job is running exactly on time.
  for (const minutesSince of [11, 12, 13, 14, 15]) {
    const { delayed } = evaluateScheduledJobTiming({
      now: new Date(lastRunStartedAt.getTime() + minutesSince * MINUTE_MS),
      maximumSilenceMs: budget,
      lastRunStartedAt,
      lastRunStatus: "succeeded",
    });
    assert.equal(delayed, false, `${minutesSince} minutes after an on-time run`);
  }
});

test("a skipped run is still reported delayed", () => {
  const budget = jobByKey("credit_reservation_reconciliation").maximumSilenceMs;
  const lastRunStartedAt = new Date("2026-08-01T07:46:00.000Z");

  const atBudget = evaluateScheduledJobTiming({
    now: new Date(lastRunStartedAt.getTime() + 35 * MINUTE_MS),
    maximumSilenceMs: budget,
    lastRunStartedAt,
    lastRunStatus: "succeeded",
  });
  assert.equal(atBudget.delayed, false, "exactly at the budget is not yet late");

  const pastBudget = evaluateScheduledJobTiming({
    now: new Date(lastRunStartedAt.getTime() + 36 * MINUTE_MS),
    maximumSilenceMs: budget,
    lastRunStartedAt,
    lastRunStatus: "succeeded",
  });
  assert.equal(pastBudget.delayed, true, "two missed cycles is late");
});

test("a job that has never run counts as delayed, not as on time", () => {
  const { delayed, stuck } = evaluateScheduledJobTiming({
    now: new Date("2026-08-01T08:00:00.000Z"),
    maximumSilenceMs: 35 * MINUTE_MS,
    lastRunStartedAt: null,
    lastRunStatus: null,
  });
  assert.equal(delayed, true);
  assert.equal(stuck, false);
});

test("a run still marked running past its budget is stuck", () => {
  const lastRunStartedAt = new Date("2026-08-01T07:00:00.000Z");
  const within = evaluateScheduledJobTiming({
    now: new Date(lastRunStartedAt.getTime() + 10 * MINUTE_MS),
    maximumSilenceMs: 35 * MINUTE_MS,
    lastRunStartedAt,
    lastRunStatus: "running",
  });
  assert.equal(within.stuck, false, "a long run inside its budget is not stuck");

  const beyond = evaluateScheduledJobTiming({
    now: new Date(lastRunStartedAt.getTime() + 40 * MINUTE_MS),
    maximumSilenceMs: 35 * MINUTE_MS,
    lastRunStartedAt,
    lastRunStatus: "running",
  });
  assert.equal(beyond.stuck, true);
  assert.equal(beyond.delayed, true);
});

test("the next run is estimated on the cadence the job actually runs at", () => {
  // 07:47 sits inside the 07:45-08:00 window: the next 15-minute boundary is
  // 08:00. The old five-minute boundary answered 07:50, which was wrong for
  // two of every three minutes.
  const now = new Date("2026-08-01T07:47:30.000Z");
  assert.equal(
    nextScheduledAt("credit_reservation_reconciliation", now).toISOString(),
    "2026-08-01T08:00:00.000Z"
  );
  assert.equal(
    nextScheduledAt("notification_delivery_retry", now).toISOString(),
    "2026-08-01T08:00:00.000Z"
  );
  assert.equal(
    nextScheduledAt("infrastructure_threshold_monitor", now).toISOString(),
    "2026-08-01T08:00:00.000Z"
  );
  assert.equal(
    nextScheduledAt("provider_probe", now).toISOString(),
    "2026-08-01T07:50:00.000Z"
  );
});

test("the next run never resolves to the moment it is asked about", () => {
  // Exactly on a boundary the answer is the *next* one, not now: an estimate
  // equal to `now` would render as "due now" forever.
  const onBoundary = new Date("2026-08-01T07:45:00.000Z");
  assert.equal(
    nextScheduledAt("credit_reservation_reconciliation", onBoundary).toISOString(),
    "2026-08-01T08:00:00.000Z"
  );
});

test("daily jobs keep their own schedule", () => {
  const now = new Date("2026-08-01T07:47:30.000Z");
  assert.equal(
    nextScheduledAt("retention_cleanup", now).toISOString(),
    "2026-08-02T03:00:00.000Z"
  );
  assert.equal(
    nextScheduledAt("provider_model_catalog_monitor", now).toISOString(),
    "2026-08-02T00:00:00.000Z"
  );
  assert.equal(
    nextScheduledAt("provider_usage_sync", now).toISOString(),
    "2026-08-02T00:30:00.000Z"
  );
});
