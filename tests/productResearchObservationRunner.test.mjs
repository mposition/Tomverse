// The runner script, run as a process.
//
// The core's tests cover the decisions; these cover the wiring around them,
// which is the part a unit test cannot see: whether the process actually exits,
// with which code, and whether anything it prints carries a credential.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  buildObservationPayload,
  summariseObservation,
} from "../lib/productResearchObservationCore.mjs";
import {
  REPORT_MAX_BUFFER_BYTES,
  readReport,
  reportArgv,
} from "../lib/productResearchObservationStepCore.mjs";

const RUNNER = join(process.cwd(), "scripts", "agents", "product-research-observation.mjs");

const SECRET = "s".repeat(32);
const TOKEN = "github_pat_secret_value";

/** A deliberately bare environment: the point is that nothing leaks in. */
const run = (env = {}, argv = []) =>
  spawnSync(process.execPath, [RUNNER, ...argv], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      // Windows needs these for node to start at all.
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      ...env,
    },
  });

test("an unset switch exits 0 without doing anything", () => {
  const result = run();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /switch unset; nothing to do/);
  // Dark means dark: no slot is claimed and no plan is announced.
  assert.equal(/planned for slot/.test(result.stdout), false);
});

test("a switch with nothing behind it exits 1 and names only variables", () => {
  const result = run({ PRODUCT_RESEARCH_AGENT_ENABLED: "true" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /config: PRODUCT_RESEARCH_INGEST_URL is not set/);
  assert.match(result.stdout, /config: PRODUCT_RESEARCH_INGEST_SECRET is not set/);
});

test("nothing the run prints carries a secret's value", () => {
  // Every path: a complete environment, a broken one, and the probe. A problem
  // report is printed to the deploy log and read by whoever opens it.
  const complete = {
    PRODUCT_RESEARCH_AGENT_ENABLED: "true",
    PRODUCT_RESEARCH_INGEST_URL: "https://tomverse.app/api/internal/product-research/observations",
    PRODUCT_RESEARCH_INGEST_SECRET: SECRET,
    PRODUCT_RESEARCH_GITHUB_READ_TOKEN: TOKEN,
    RAILPACK_DEPLOY_APT_PACKAGES: "git",
  };
  for (const [label, env, argv] of [
    ["complete", complete, []],
    ["short secret", { ...complete, PRODUCT_RESEARCH_INGEST_SECRET: "short" }, []],
    ["undeclared", { ...complete, DATABASE_URL: `postgresql://u:${SECRET}@h/db` }, []],
    ["probe", { PRODUCT_RESEARCH_GITHUB_READ_TOKEN: TOKEN }, ["--probe"]],
  ]) {
    const result = run(env, argv);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(output.includes(SECRET), false, `${label}: the secret was printed`);
    assert.equal(output.includes(TOKEN), false, `${label}: the token was printed`);
  }
});

test("an undeclared variable stops the run before it plans a slot", () => {
  const result = run({
    PRODUCT_RESEARCH_AGENT_ENABLED: "true",
    PRODUCT_RESEARCH_INGEST_URL: "https://tomverse.app/api/internal/product-research/observations",
    PRODUCT_RESEARCH_INGEST_SECRET: SECRET,
    PRODUCT_RESEARCH_GITHUB_READ_TOKEN: TOKEN,
    RAILPACK_DEPLOY_APT_PACKAGES: "git",
    DATABASE_URL: "postgresql://user:pw@host:5432/db",
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /DATABASE_URL is not a variable this service declares/);
  assert.equal(/planned for slot/.test(result.stdout), false);
});

test("the probe reports what the image can do and submits nothing", () => {
  const result = run({ PRODUCT_RESEARCH_GITHUB_READ_TOKEN: TOKEN }, ["--probe"]);
  assert.match(result.stdout, /git available: (true|false)/);
  assert.match(result.stdout, /node version: v/);
  assert.match(result.stdout, /slot this run would answer for: \d{4}-\d{2}-\d{2}T21:30:00\.000Z/);
  // It never reaches the planning path, so it cannot announce a planned slot
  // and cannot submit; the probe service has no submission variables anyway.
  assert.equal(/planned for slot/.test(result.stdout), false);
  // The switch is irrelevant to the probe: an operator measuring a dark staging
  // service is the normal case.
  assert.equal(/switch unset/.test(result.stdout), false);
});

const SERVICE_ENV = {
  PRODUCT_RESEARCH_AGENT_ENABLED: "true",
  PRODUCT_RESEARCH_INGEST_URL:
    "https://tomverse.app/api/internal/product-research/observations",
  PRODUCT_RESEARCH_INGEST_SECRET: SECRET,
  PRODUCT_RESEARCH_GITHUB_READ_TOKEN: TOKEN,
  RAILPACK_DEPLOY_APT_PACKAGES: "git",
};

const runThroughNpm = (env) =>
  spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "--silent", "agent:product-research-observation"],
    {
      encoding: "utf8",
      timeout: 120_000,
      shell: process.platform === "win32",
      env,
    },
  );

/** The names a run reported as undeclared, from its own output. */
const reportedNames = (output) => [
  ...String(output ?? "").matchAll(
    /^config: (\S+) is not a variable this service declares$/gm,
  ),
].map((match) => match[1]);

/**
 * The runner as a process this one can wait for without blocking.
 *
 * `spawnSync` cannot be used for a test with a server in it: it blocks this
 * process's event loop, so the server never accepts the connection and the
 * run's submission times out against a listener that is simply not listening.
 * That cost forty seconds a test before it was understood.
 */
const runAsync = (env = {}, argv = []) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, ...argv], {
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });

/**
 * A PATH with no `git` on it, for the runs that spawn node by absolute path.
 *
 * The run's first IO is a clone, so a test that let it find git would clone
 * this repository from GitHub -- a unit test with a network dependency and a
 * minute of wall clock. Removing git instead exercises the failure path for
 * real: `spawnSync` reports `ENOENT`, and what the run does with that is the
 * thing worth holding.
 *
 * Only node's own directory, and only safe because `runAsync` names the node
 * binary absolutely. Two things this is not allowed to become: a PATH for the
 * npm lane below, which needs an `npm` that is not always beside `node`, and a
 * filtered copy of the real PATH, which on Ubuntu drops `/usr/bin` and the
 * `/bin` symlinked to it and so takes `sh` away from npm as well. Both were
 * tried; both started nothing and asserted against an empty string.
 */
const PATH_WITHOUT_GIT = dirname(process.execPath);

test("the runs below cannot find git", () => {
  // The guard for the mistake above: every assertion that follows reads a
  // failed clone as the thing it is testing, so a PATH that still had git on
  // it would make them pass for another reason entirely.
  const git = spawnSync("git", ["--version"], {
    encoding: "utf8",
    env: { ...process.env, PATH: PATH_WITHOUT_GIT },
  });
  assert.equal(git.status, null, `git was still reachable: ${git.stdout}`);
});

/** A stand-in for the ingest route that records what reached it. */
const ingestServer = async (reply = { status: 200 }) => {
  const received = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push({
        method: request.method,
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        body,
      });
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          reply.status === 200
            ? { recorded: true, observationId: "obs-2026-10-07-abcdef12" }
            : { refused: "unauthorized" },
        ),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    received,
    url: `http://127.0.0.1:${port}/api/internal/product-research/observations`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

test("a run that cannot clone records a failed slot carrying no content", async () => {
  const ingest = await ingestServer();
  try {
    const result = await runAsync({
      ...SERVICE_ENV,
      PRODUCT_RESEARCH_INGEST_URL: ingest.url,
      PATH: PATH_WITHOUT_GIT,
    });

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /answering for slot \d{4}-\d{2}-\d{2}T21:30:00\.000Z/);
    assert.match(result.stdout, /clone_failed: the clone did not complete/);
    // Non-zero, and the row exists: the deploy log is red so an operator sees
    // it, and the slot is answered so the silence check does not also fire.
    assert.match(result.stdout, /recorded obs-2026-10-07-abcdef12: failed at clone_failed/);

    assert.equal(ingest.received.length, 1, "the slot got one answer, not none and not two");
    const [sent] = ingest.received;
    assert.equal(sent.method, "POST");
    assert.equal(sent.authorization, `Bearer ${SECRET}`);
    assert.equal(sent.contentType, "application/json");
    // Exactly the four keys a failed slot has. The route refuses a failure
    // carrying content and the table refuses it again, but the run never
    // builds one: a half-observation stored as a success is the defect.
    assert.deepEqual(Object.keys(JSON.parse(sent.body)).sort(), [
      "failureStage",
      "outcome",
      "schemaVersion",
      "slot",
    ]);
    assert.deepEqual(JSON.parse(sent.body).outcome, "failed");
    assert.deepEqual(JSON.parse(sent.body).failureStage, "clone_failed");
  } finally {
    await ingest.close();
  }
});

test("a refused submission is reported and never retried", async () => {
  const ingest = await ingestServer({ status: 401 });
  try {
    const result = await runAsync({
      ...SERVICE_ENV,
      PRODUCT_RESEARCH_INGEST_URL: ingest.url,
      PATH: PATH_WITHOUT_GIT,
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /submission: the route answered 401 unauthorized/);
    // One attempt. A second is how one slot gets two different answers, and
    // the restart policy is NEVER precisely so a failed run stays failed.
    assert.equal(ingest.received.length, 1);
    assert.equal(/recorded/.test(result.stdout), false);
  } finally {
    await ingest.close();
  }
});

test("nothing a failing run prints carries the secret or the token", async () => {
  const ingest = await ingestServer({ status: 401 });
  try {
    for (const [label, env] of [
      ["clone refused", { PATH: PATH_WITHOUT_GIT }],
      ["submission refused", { PATH: PATH_WITHOUT_GIT }],
    ]) {
      const result = await runAsync({
        ...SERVICE_ENV,
        PRODUCT_RESEARCH_INGEST_URL: ingest.url,
        ...env,
      });
      const output = `${result.stdout}${result.stderr}`;
      assert.equal(output.includes(SECRET), false, `${label}: the secret was printed`);
      assert.equal(output.includes(TOKEN), false, `${label}: the token was printed`);
    }
  } finally {
    await ingest.close();
  }
});

test("npm's own variables are not what stops a run", () => {
  // The IaC starts this service with `npm run`, and npm puts twenty-odd of its
  // own variables into the child. Spawning node directly -- as every test above
  // does -- cannot see that: a run that refused them would refuse every
  // correctly configured production run before it planned anything, at 21:30,
  // with `config: npm_lifecycle_event is not a variable this service declares`
  // in a log nobody is reading.
  //
  // This runs with the whole developer environment, which is itself full of
  // undeclared names, so the claim is narrow and exact: whatever else a run
  // reports, none of it is npm's.
  const result = runThroughNpm({ ...process.env, ...SERVICE_ENV });
  const names = reportedNames(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  // A pattern that matches nothing would pass this test while proving nothing,
  // so the developer environment's own undeclared names are the proof that the
  // run reported anything at all.
  assert.ok(names.length > 0, "the run reported no undeclared names to filter");
  const npmNames = names.filter(
    (name) =>
      name.startsWith("npm_") ||
      ["INIT_CWD", "NODE", "COLOR", "EDITOR", "_"].includes(name),
  );
  assert.deepEqual(npmNames, [], npmNames.join(" | "));
});

/**
 * The deployed start command, run to its own end.
 *
 * It keeps the real PATH, because npm needs an `npm` and a `sh` and neither is
 * reliably beside `node`. Nothing is killed and nothing is cut short: the run
 * reaches its own clone, fails it against the shim the caller put on PATH,
 * records the failed slot against the caller's server and exits. The deadline
 * below is a safety net for a run that hangs, not the normal path -- a test
 * that resolved on a pattern in stdout would resolve after the clone had
 * already started, and a killed run never reaches the `finally` that removes
 * its temporary clone.
 */
const runThroughNpmToEnd = (env) =>
  new Promise((resolve) => {
    const child = spawn(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", "--silent", "agent:product-research-observation"],
      // Its own process group, so the deadline's kill reaches the node process
      // npm started rather than only npm.
      { shell: process.platform === "win32", detached: true, env },
    );
    let output = "";
    const read = (chunk) => {
      output += chunk;
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    const deadline = setTimeout(() => {
      try {
        process.kill(-child.pid);
      } catch {
        child.kill();
      }
    }, 120_000);
    child.on("close", (status) => {
      clearTimeout(deadline);
      resolve({ status, output });
    });
  });

/**
 * A `git` on PATH that fails, in a directory of its own.
 *
 * The alternative is letting the run clone this repository from GitHub, which
 * puts a network fetch and a minute of wall clock inside a unit test. A shim
 * rather than a PATH with no git on it: npm needs the directories that hold
 * git -- on Ubuntu `/bin` is a symlink to `/usr/bin` -- so taking them away
 * takes `sh` with them.
 */
const gitShimDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), "product-research-git-shim-"));
  const shim = join(directory, "git");
  writeFileSync(shim, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return directory;
};

test(
  "the deployed start command records a failed slot",
  { skip: process.platform === "win32" },
  async () => {
    // The container has a short environment and npm adds to it, which is the
    // whole combination production runs. Skipped on Windows, where the shell
    // needs APPDATA, SystemRoot and a dozen more that Linux genuinely does not
    // have -- declaring those to make this pass here would widen the check for
    // the platform that actually runs it. The Linux CI runner is where it holds.
    const shim = gitShimDirectory();
    const ingest = await ingestServer();
    try {
      const { status, output } = await runThroughNpmToEnd({
        PATH: `${shim}${delimiter}${process.env.PATH}`,
        HOME: process.env.HOME,
        ...SERVICE_ENV,
        PRODUCT_RESEARCH_INGEST_URL: ingest.url,
      });

      // Nothing npm added stopped it: that is what this lane is for, and the
      // lines below are the proof it got past planning at all.
      assert.deepEqual(reportedNames(output), [], output);
      assert.match(output, /answering for slot/, output);
      assert.match(output, /clone_failed/, output);
      assert.match(output, /recorded obs-2026-10-07-abcdef12: failed at clone_failed/, output);
      assert.equal(status, 1, output);

      assert.equal(ingest.received.length, 1, "the slot got one answer");
      const sent = JSON.parse(ingest.received[0].body);
      assert.equal(sent.outcome, "failed");
      assert.equal(sent.failureStage, "clone_failed");
    } finally {
      await ingest.close();
      rmSync(shim, { recursive: true, force: true });
    }
  },
);
test("the report's own output is what the payload builder accepts", () => {
  // The link no unit test can reach by reading either side: the report prints
  // its own shape and `buildObservationPayload` refuses anything it does not
  // recognise, down to a signal field it has not been told about. A new signal
  // kind on one side and a `schema_invalid` row on the other is the failure
  // this holds shut, and it would otherwise appear for the first time at 21:30.
  //
  // This repository is the clone, and HEAD stands in for both release branch
  // tips: the report only needs them to be commits it can read, and pinning
  // them to HEAD keeps the test independent of which branches a checkout has.
  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  assert.equal(head.status, 0, "this test needs a git checkout");
  const sha = head.stdout.trim();

  const directory = mkdtempSync(join(tmpdir(), "product-research-report-"));
  try {
    const issuesFile = join(directory, "open-issues.json");
    const issues = [
      { number: 1, title: "an issue the tracker may be behind on", body: "", labels: [] },
      { number: 999999, title: "an issue nothing references", body: "", labels: [] },
    ];
    writeFileSync(issuesFile, JSON.stringify(issues), "utf8");

    const child = spawnSync(
      process.execPath,
      reportArgv({
        cli: join(process.cwd(), "scripts", "report-issue-backlog.mjs"),
        repository: process.cwd(),
        issuesFile,
        develop: sha,
        main: sha,
      }),
      { cwd: process.cwd(), encoding: "utf8", timeout: 300_000, maxBuffer: REPORT_MAX_BUFFER_BYTES },
    );

    const read = readReport(child);
    assert.equal(read.stage, undefined, `${child.status}: ${child.stderr}`);

    const built = buildObservationPayload(read.report);
    assert.equal(built.failure, undefined, JSON.stringify(built.failure));
    // Every issue given becomes exactly one row, whatever the verdict was.
    assert.deepEqual(
      built.payload.issues.map((row) => row.id),
      ["1", "999999"],
    );
    // And the counts are rederivable from the rows, which is the property the
    // route re-checks before it stores them.
    assert.deepEqual(summariseObservation(built.payload.issues), {
      counts: built.payload.counts,
      blindSpots: built.payload.blindSpots,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "a child that ignores SIGTERM is killed, and its slot is answered as a timeout",
  { skip: process.platform === "win32" },
  async () => {
    // The defect both reviewers of the main release found. Under `spawnSync`
    // the process cannot run a timer while a child runs, so the fifteen-minute
    // deadline -- the one that exists precisely for a child that hangs -- could
    // not fire; and `spawnSync`'s own timeout sends SIGTERM and then waits, so
    // a child that ignores SIGTERM is waited for forever. Railway skips the
    // next scheduled run while one is still going, so that is not one lost slot
    // but every slot after it.
    //
    // The shim is both halves at once: it blocks, and it refuses to leave when
    // asked. It fakes the clone so the hang lands on a call with a 30-second
    // deadline rather than the clone's five minutes -- what is being measured
    // is the kill, not the length of a constant.
    const shim = mkdtempSync(join(tmpdir(), "product-research-git-hang-"));
    const marker = join(shim, "hung");
    writeFileSync(
      join(shim, "git"),
      [
        "#!/bin/sh",
        "case \"$1\" in",
        "  clone) mkdir -p \"$6\" && exit 0 ;;",
        "esac",
        "trap '' TERM",
        `touch ${JSON.stringify(marker)}`,
        "sleep 600",
      ].join("\n") + "\n",
      { mode: 0o755 },
    );
    const ingest = await ingestServer();
    try {
      const started = Date.now();
      const { status, output } = await runThroughNpmToEnd({
        PATH: `${shim}${delimiter}${process.env.PATH}`,
        HOME: process.env.HOME,
        ...SERVICE_ENV,
        PRODUCT_RESEARCH_INGEST_URL: ingest.url,
      });
      const elapsed = Date.now() - started;

      assert.ok(existsSync(marker), "the shim never hung, so nothing was exercised");
      // It ended on its own, nowhere near the ten minutes the shim wanted and
      // inside the harness deadline that would otherwise have killed it.
      assert.ok(elapsed < 110_000, `the run took ${elapsed}ms`);
      assert.equal(status, 1, output);
      assert.match(output, /timeout/, output);

      // And the slot is answered. A hung run that wrote nothing would be
      // indistinguishable from a night nobody ran.
      assert.equal(ingest.received.length, 1, "the slot got one answer");
      const sent = JSON.parse(ingest.received[0].body);
      assert.equal(sent.outcome, "failed");
      assert.equal(sent.failureStage, "timeout");
      assert.equal("payload" in sent, false);
    } finally {
      await ingest.close();
      rmSync(shim, { recursive: true, force: true });
    }
  },
);
