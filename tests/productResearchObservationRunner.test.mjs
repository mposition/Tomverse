// The runner script, run as a process.
//
// The core's tests cover the decisions; these cover the wiring around them,
// which is the part a unit test cannot see: whether the process actually exits,
// with which code, and whether anything it prints carries a credential.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

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

test("a planned run exits 1 while the observation step does not exist", () => {
  // The honest outcome for now. Exiting 0 here would make every slot look
  // answered, and the silence check would then never fire on a run that writes
  // nothing.
  const result = run({
    PRODUCT_RESEARCH_AGENT_ENABLED: "true",
    PRODUCT_RESEARCH_INGEST_URL: "https://tomverse.app/api/internal/product-research/observations",
    PRODUCT_RESEARCH_INGEST_SECRET: SECRET,
    PRODUCT_RESEARCH_GITHUB_READ_TOKEN: TOKEN,
    RAILPACK_DEPLOY_APT_PACKAGES: "git",
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /no observation step built yet/);
  // And it exits rather than sitting on its 15-minute timer: a process kept
  // alive by its own watchdog is the hang the watchdog exists to end.
  assert.equal(result.signal, null);
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

test("the deployed start command plans its slot", { skip: process.platform === "win32" }, () => {
  // The container has a short environment and npm adds to it, which is the
  // whole combination production runs. Skipped on Windows, where the shell
  // needs APPDATA, SystemRoot and a dozen more that Linux genuinely does not
  // have -- declaring those to make this pass here would widen the check for
  // the platform that actually runs it. The Linux CI runner is where it holds.
  const result = runThroughNpm({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...SERVICE_ENV,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.deepEqual(reportedNames(output), [], output);
  assert.match(output, /no observation step built yet/);
});
