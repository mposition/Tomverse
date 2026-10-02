// What the runner decides before it touches anything.
//
// Three failures these hold shut: a product database credential reaching the
// service (by name or by the shape of a value), two answers being submitted for
// one slot after an unknown outcome, and a run that hangs taking every later
// run with it because its deadlines do not relate to the route's own limit.

import assert from "node:assert/strict";
import test from "node:test";

import {
  DECLARED_SERVICE_VARIABLES,
  DEFAULT_RUN_TIMINGS,
  SLOT_WINDOW_MS,
  createRunState,
  environmentProblems,
  gitSupportsPartialClone,
  isSecretVariableName,
  parseGitVersion,
  planRun,
  runTimingProblems,
  slotForInstant,
  systemNamesForPlatform,
  withinSlotWindow,
} from "../lib/productResearchObservationRunnerCore.mjs";

const SECRET = "s".repeat(32);

const serviceEnv = (overrides = {}) => ({
  PRODUCT_RESEARCH_AGENT_ENABLED: "true",
  PRODUCT_RESEARCH_INGEST_URL: "https://tomverse.app/api/internal/product-research/observations",
  PRODUCT_RESEARCH_INGEST_SECRET: SECRET,
  PRODUCT_RESEARCH_GITHUB_READ_TOKEN: "github_pat_example",
  RAILPACK_DEPLOY_APT_PACKAGES: "git",
  PATH: "/usr/bin",
  HOME: "/root",
  RAILWAY_GIT_COMMIT_SHA: "a".repeat(40),
  ...overrides,
});

test("a declared environment has nothing to report", () => {
  assert.deepEqual(environmentProblems(serviceEnv()), []);
});

test("a variable this service does not declare stops the run, by name only", () => {
  const problems = environmentProblems(
    serviceEnv({ DATABASE_URL: "postgresql://user:pw@host:5432/db" })
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /DATABASE_URL is not a variable this service declares/);
  // The value is the one thing a problem report may not carry.
  assert.equal(problems.join("\n").includes("pw@host"), false);
});

test("a declared variable holding a connection string also stops the run", () => {
  // The Agent project has no database service for a reference variable to
  // resolve to; this is the hand-pasted value, which the boundary cannot catch.
  for (const value of [
    "postgresql://user:pw@host:5432/db",
    "postgres://user:pw@host/db",
    "prisma+postgres://accelerate.example/?api_key=x",
    "mysql://root@host/db",
    "redis://host:6379",
    "mongodb+srv://user:pw@cluster/db",
    "  jdbc:postgresql://host/db  ",
    "libsql://db.example",
  ]) {
    const problems = environmentProblems(
      serviceEnv({ PRODUCT_RESEARCH_INGEST_URL: value })
    );
    assert.deepEqual(
      problems,
      ["PRODUCT_RESEARCH_INGEST_URL holds what looks like a database connection string"],
      value
    );
    assert.equal(problems.join("").includes("pw@"), false);
  }
});

test("the platform's own variables are allowed by prefix, not one by one", () => {
  assert.deepEqual(
    environmentProblems(
      serviceEnv({ RAILWAY_DEPLOYMENT_ID: "x", RAILWAY_ENVIRONMENT_NAME: "staging" })
    ),
    []
  );
});

test("an unset switch runs nothing at all", () => {
  const plan = planRun(serviceEnv({ PRODUCT_RESEARCH_AGENT_ENABLED: "" }));
  assert.deepEqual(plan, { mode: "dark" });
  // Dark is decided before the rest of the environment is even judged: a
  // service that is meant to do nothing should not fail because of a typo in a
  // variable it will not read.
  const darkWithProblems = planRun(
    serviceEnv({ PRODUCT_RESEARCH_AGENT_ENABLED: "", DATABASE_URL: "postgres://x/y" })
  );
  assert.deepEqual(darkWithProblems, { mode: "dark" });
});

test("a run plan names what is missing and never the secret", () => {
  const cases = [
    { overrides: { PRODUCT_RESEARCH_INGEST_URL: "" }, expected: /INGEST_URL is not set/ },
    {
      overrides: { PRODUCT_RESEARCH_INGEST_URL: "http://tomverse.app/x" },
      expected: /is not https/,
    },
    { overrides: { PRODUCT_RESEARCH_INGEST_URL: "not a url" }, expected: /is not a URL/ },
    { overrides: { PRODUCT_RESEARCH_INGEST_SECRET: "short" }, expected: /shorter than 32/ },
    { overrides: { PRODUCT_RESEARCH_INGEST_SECRET: "" }, expected: /SECRET is not set/ },
    { overrides: { PRODUCT_RESEARCH_GITHUB_READ_TOKEN: "" }, expected: /READ_TOKEN is not set/ },
  ];
  for (const { overrides, expected } of cases) {
    const plan = planRun(serviceEnv(overrides));
    assert.equal(plan.mode, "config", JSON.stringify(overrides));
    assert.match(plan.problems.join("\n"), expected);
    assert.equal(plan.problems.join("\n").includes(SECRET), false);
  }
});

test("a localhost submission URL may be plain http, and only localhost", () => {
  for (const host of ["localhost", "127.0.0.1"]) {
    const plan = planRun(
      serviceEnv({ PRODUCT_RESEARCH_INGEST_URL: `http://${host}:3000/api/internal/x` })
    );
    assert.equal(plan.mode, "run", host);
  }
  const remote = planRun(
    serviceEnv({ PRODUCT_RESEARCH_INGEST_URL: "http://staging.internal/api" })
  );
  assert.equal(remote.mode, "config");
});

test("the loopback exception is an exception to https, not to HTTP", () => {
  // A scheme the submission cannot be made over has to be refused here. Left
  // to the run it becomes a failed submission, which reads as the route being
  // down rather than as the variable being wrong.
  for (const url of [
    "ftp://localhost/x",
    "file://localhost/x",
    "ws://127.0.0.1:3000/x",
    "postgresql://localhost:5432/db",
  ]) {
    const plan = planRun(serviceEnv({ PRODUCT_RESEARCH_INGEST_URL: url }));
    assert.equal(plan.mode, "config", url);
    assert.match(plan.problems.join(" "), /is not https|connection string/);
  }
});

test("a complete environment produces the config the run needs and nothing more", () => {
  const plan = planRun(serviceEnv());
  assert.equal(plan.mode, "run");
  assert.deepEqual(Object.keys(plan.config).sort(), [
    "githubToken",
    "ingestSecret",
    "ingestUrl",
  ]);
});

test("the declared variable list is the one the IaC has to match", () => {
  // Two readers of this list exist: this check and the Agent project's IaC. The
  // test that compares them lives with the IaC; this one holds the shape.
  assert.deepEqual(DECLARED_SERVICE_VARIABLES, [
    "PRODUCT_RESEARCH_AGENT_ENABLED",
    "PRODUCT_RESEARCH_INGEST_URL",
    "PRODUCT_RESEARCH_INGEST_SECRET",
    "PRODUCT_RESEARCH_GITHUB_READ_TOKEN",
    "RAILPACK_DEPLOY_APT_PACKAGES",
  ]);
  assert.equal(isSecretVariableName("PRODUCT_RESEARCH_INGEST_SECRET"), true);
  assert.equal(isSecretVariableName("PRODUCT_RESEARCH_GITHUB_READ_TOKEN"), true);
  assert.equal(isSecretVariableName("PRODUCT_RESEARCH_INGEST_URL"), false);
});

test("only one of the run and its watchdog may submit", () => {
  const state = createRunState();
  assert.equal(state.state, "PREPARE");
  assert.equal(state.beginSubmit(), true);
  // The watchdog arriving now has nothing to do: the outcome of the submission
  // already under way is unknown, and a second one would answer the same slot
  // twice.
  assert.equal(state.beginSubmit(), false);
  assert.equal(state.watchdogAction("prepare"), "nothing");
  assert.equal(state.watchdogAction("hard"), "exit");
});

test("a watchdog that fires while preparing submits the timeout once", () => {
  const state = createRunState();
  assert.equal(state.watchdogAction("prepare"), "submit-timeout");
  assert.equal(state.beginSubmit(), true);
  assert.equal(state.watchdogAction("prepare"), "nothing");
});

test("a finished run leaves both watchdogs with nothing to do", () => {
  const state = createRunState();
  state.beginSubmit();
  assert.equal(state.finish(0), true);
  assert.equal(state.state, "DONE");
  assert.equal(state.exitCode, 0);
  assert.equal(state.watchdogAction("prepare"), "nothing");
  // The hard deadline must not turn a finished, successful run into exit 1 --
  // every normal run would be recorded as a failure.
  assert.equal(state.watchdogAction("hard"), "nothing");
  assert.equal(state.finish(1), false);
  assert.equal(state.exitCode, 0);
});

test("the default timings satisfy the relations they exist for", () => {
  assert.deepEqual(runTimingProblems(), []);
  assert.ok(DEFAULT_RUN_TIMINGS.submitAbortMs > DEFAULT_RUN_TIMINGS.routeMaxDurationMs);

  assert.match(
    runTimingProblems({ ...DEFAULT_RUN_TIMINGS, submitAbortMs: 20 * 1000 }).join(),
    /give up before the route/
  );
  assert.match(
    runTimingProblems({ ...DEFAULT_RUN_TIMINGS, prepareMs: 15 * 60 * 1000 }).join(),
    /no time to be cut short/
  );
  assert.match(
    runTimingProblems({ ...DEFAULT_RUN_TIMINGS, prepareMs: 14.9 * 60 * 1000 }).join(),
    /could not be submitted before the hard deadline/
  );
});

test("a run belongs to the slot it was scheduled for, and may submit for an hour", () => {
  const slot = Date.parse("2026-10-02T21:30:00.000Z");

  assert.equal(slotForInstant(slot), "2026-10-02T21:30:00.000Z");
  assert.equal(slotForInstant(slot + 14 * 60 * 1000), "2026-10-02T21:30:00.000Z");
  // Just before the scheduled instant the run is still answering for yesterday.
  assert.equal(slotForInstant(slot - 1), "2026-10-01T21:30:00.000Z");
  // And across the UTC date boundary it is still the slot that just passed.
  assert.equal(
    slotForInstant(Date.parse("2026-10-03T00:05:00.000Z")),
    "2026-10-02T21:30:00.000Z"
  );

  const slotIso = "2026-10-02T21:30:00.000Z";
  assert.equal(withinSlotWindow(slot, slotIso), true);
  assert.equal(withinSlotWindow(slot + SLOT_WINDOW_MS - 1, slotIso), true);
  assert.equal(withinSlotWindow(slot + SLOT_WINDOW_MS, slotIso), false);
  assert.equal(withinSlotWindow(slot - 1, slotIso), false);
});

test("partial clone support is read from the version, not from an exit status", () => {
  // `git clone --filter=... --help` exits on whether a manual page opened, so
  // the image probe would report a capable git as incapable -- which is a hold
  // on the phase for a reason that is not true.
  assert.deepEqual(parseGitVersion("git version 2.55.0.windows.3"), [2, 55, 0]);
  assert.deepEqual(parseGitVersion("git version 2.19"), [2, 19, 0]);
  assert.equal(parseGitVersion(""), null);
  assert.equal(parseGitVersion(undefined), null);

  for (const capable of ["git version 2.19.0", "git version 2.19", "git version 2.20.1", "git version 3.0.0"]) {
    assert.equal(gitSupportsPartialClone(capable), true, capable);
  }
  // Unknown fails closed: an image whose git cannot be identified is one the
  // run must not assume can make the clone it depends on.
  for (const incapable of ["git version 2.18.9", "git version 1.9.5", "", "command not found"]) {
    assert.equal(gitSupportsPartialClone(incapable), false, incapable);
  }
});

test("the Windows names are allowed on Windows and nowhere else", () => {
  // The deployed service is Linux. These exist so the runner can be exercised
  // on a developer machine, where Node adds them to a child even when the
  // environment was built from nothing -- not to widen what the service may
  // hold.
  const linux = systemNamesForPlatform("linux");
  assert.equal(linux.includes("USERPROFILE"), false);
  assert.deepEqual(
    environmentProblems({ PATH: "/usr/bin", USERPROFILE: "C:/Users/x" }, { systemNames: linux }),
    ["USERPROFILE is not a variable this service declares"]
  );

  const windows = systemNamesForPlatform("win32");
  assert.ok(windows.includes("USERPROFILE"));
  assert.deepEqual(
    environmentProblems({ PATH: "C:/bin", USERPROFILE: "C:/Users/x" }, { systemNames: windows }),
    []
  );
  // A connection string is still a connection string, on either platform.
  assert.deepEqual(
    environmentProblems({ USERPROFILE: "postgres://u:p@h/db" }, { systemNames: windows }),
    ["USERPROFILE holds what looks like a database connection string"]
  );
});
