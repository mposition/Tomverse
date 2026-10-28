// The variable-name comparison O3 of §12 (3) in
// `docs/policy/trust-safety-compliance-agent.md` assigns to this command, so an
// operator runs it and signs instead of reading a dashboard.
//
// See scripts/trust-safety-railway-variables-core.mjs for the boundary §4 of
// that policy draws and the two things names cannot answer. This file reads the
// declaration site and asks the Railway CLI for variable **names**; it writes
// nothing, to Railway or to the repository.
//
// Where to run it: the operator's local PowerShell, inside a clone, with the
// Railway CLI 5.42.1 or newer logged in (`railway login`) -- the same
// prerequisite as `npm run railway:agents:plan`. **No production database
// credentials.** Reading is all it does.
//
// Usage:
//   npm run report:trust-safety-railway-variables
//   npm run report:trust-safety-railway-variables -- --json
//
// Exit 0 only on `match`. A verdict is evidence the operator signs; nothing
// consumes it and it gates nothing.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildVariableManifest,
} from "./trust-safety-railway-variables-core.mjs";

/** §4 fixes one declaration site, and this is the key within it. */
const RUNNER_KEY = "trust_safety_observer";
const ENVIRONMENTS = ["production", "staging"];
const RUNNER_SERVICE = "Trust Safety Observer";
const APP_SERVICE = "Tomverse";
/**
 * The runner and the app are in **different Railway projects** -- §4 puts agent
 * runners in "Tomverse Agents" and the app lives in "Tomverse". A review found
 * every lookup here using whichever project happened to be linked, which no
 * single link can satisfy: one of the two would always be wrong. Each lookup
 * now names its project, and the manifest records which.
 */
const APP_PROJECT = "Tomverse";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const asJson = args.includes("--json");

/**
 * The Railway CLI's executable, not the shim beside it.
 *
 * On Windows an npm global install puts `railway.cmd` on PATH and the binary
 * next to it, and `spawnSync` without a shell cannot run a `.cmd`. A review
 * found this version reporting a correctly installed, logged-in CLI as
 * unreadable for exactly that reason -- the same shape as an earlier attempt in
 * this repository to make `gh` fail, where the stub was ignored because node
 * resolves `gh.cmd` through PATHEXT.
 *
 * `.railway/run.mjs` already solves this for the IaC commands, including the
 * `RAILWAY_CLI_BIN` override, and this follows it rather than inventing a
 * second rule.
 */
const railwayCli = () => {
  if (process.env.RAILWAY_CLI_BIN) return process.env.RAILWAY_CLI_BIN;
  const windows = process.platform === "win32";
  const binary = windows ? "railway.exe" : "railway";
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const native = join(directory, binary);
    if (existsSync(native)) return native;
    // An npm global install leaves the shim on PATH with the binary in the
    // package beside it.
    const packaged = join(directory, "node_modules", "@railway", "cli", "bin", binary);
    if (windows && existsSync(join(directory, "railway.cmd")) && existsSync(packaged)) {
      return packaged;
    }
  }
  return undefined;
};

const CLI = railwayCli();

const run = (commandArgs) => {
  if (CLI === undefined) return undefined;
  const result = spawnSync(CLI, commandArgs, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout;
};

/**
 * The names `.railway/agent-runners.ts` declares for this runner.
 *
 * The file is TypeScript, so it is read through the same loader the rest of the
 * repository's report scripts use rather than parsed by hand: a hand parser of
 * a declaration site is a second reading of it, and §4 says there is one.
 */
const declaredNames = async () => {
  try {
    const declarations = await import("../.railway/agent-runners.ts");
    const runner = declarations.AGENT_RUNNER_SERVICES?.find((entry) => entry.key === RUNNER_KEY);
    if (runner === undefined) return { absent: true };
    return {
      absent: false,
      byEnvironment: Object.fromEntries(
        ENVIRONMENTS.map((environment) => [
          environment,
          runner.environments?.[environment] ? [...runner.environments[environment]] : [],
        ]),
      ),
    };
  } catch {
    return undefined;
  }
};

/**
 * The variable **names** Railway holds. The values come back in the same reply
 * and are dropped here, before anything else sees them: O3 says to discard
 * them, and §4 forbids the ping URL's value in a manifest or a log.
 */
const effectiveNames = (project, service, environment) => {
  if (project === undefined) return undefined;
  const stdout = run([
    "variables",
    "--project",
    project,
    "--service",
    service,
    "--environment",
    environment,
    "--json",
  ]);
  if (stdout === undefined) return undefined;
  try {
    const parsed = JSON.parse(stdout);
    if (parsed === null || typeof parsed !== "object") return undefined;
    return Object.keys(parsed).sort();
  } catch {
    return undefined;
  }
};

/**
 * A project's id from its name. `--project` takes an id, and the names are what
 * §4 and `.railway/agent-runners.ts` state, so the two are joined here rather
 * than by pinning ids in source -- an id pinned in a file is a fact nobody
 * rechecks.
 */
const projectIds = () => {
  const stdout = run(["list", "--json"]);
  if (stdout === undefined) return undefined;
  try {
    const parsed = JSON.parse(stdout);
    const rows = Array.isArray(parsed) ? parsed : (parsed?.projects ?? []);
    const byName = new Map();
    for (const row of rows) {
      if (typeof row?.name === "string" && typeof row?.id === "string") byName.set(row.name, row.id);
    }
    return byName;
  } catch {
    return undefined;
  }
};

const declared = await declaredNames();
const projects = projectIds();
const agentProjectName = (await import("../.railway/agent-runners.ts").catch(() => ({})))
  .AGENT_RAILWAY_PROJECT;
const agentProjectId = projects?.get(agentProjectName);
const appProjectId = projects?.get(APP_PROJECT);

const manifest = buildVariableManifest({
  environments: ENVIRONMENTS.map((environment) => ({
    environment,
    declared:
      declared === undefined
        ? undefined
        : declared.absent
          ? []
          : declared.byEnvironment[environment],
    effective: effectiveNames(agentProjectId, RUNNER_SERVICE, environment),
  })),
  appVariableNames: effectiveNames(appProjectId, APP_SERVICE, "production"),
});

const report = {
  ...manifest,
  declarationSite: ".railway/agent-runners.ts",
  runnerKey: RUNNER_KEY,
  // Which project each lookup asked, so a verdict cannot be read as being
  // about the wrong one.
  projects: {
    runner: { name: agentProjectName ?? null, id: agentProjectId ?? null, service: RUNNER_SERVICE },
    app: { name: APP_PROJECT, id: appProjectId ?? null, service: APP_SERVICE },
  },
  railwayCli: CLI ?? null,
  runnerDeclared: declared === undefined ? "unreadable" : !declared.absent,
};

const exitCode = report.verdict === "match" ? 0 : 1;

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(exitCode);
}

const mark = (ok) => (ok === true ? "pass" : ok === false ? "FAIL" : "????");

console.log("§12 (3) O3: variable names for the trust-safety observer");
console.log(`declaration site: ${report.declarationSite} (key ${RUNNER_KEY})`);
console.log(
  `runner project: ${report.projects.runner.name ?? "(unreadable)"} ` +
    `(${report.projects.runner.id ?? "id unreadable"}), service ${RUNNER_SERVICE}`,
);
console.log(
  `app project: ${report.projects.app.name} (${report.projects.app.id ?? "id unreadable"}), ` +
    `service ${APP_SERVICE}`,
);
if (CLI === undefined) {
  console.log(
    "the Railway CLI executable was not found. Install it, or set RAILWAY_CLI_BIN to the executable (not a .cmd shim).",
  );
}
if (report.runnerDeclared === false) {
  console.log("the runner is not declared there yet, so there is nothing to compare against\n");
} else if (report.runnerDeclared === "unreadable") {
  console.log("the declaration site could not be read\n");
} else {
  console.log("");
}

for (const comparison of report.comparisons) {
  console.log(`${comparison.environment}: ${comparison.verdict}`);
  for (const finding of comparison.findings) {
    console.log(`  [${mark(finding.ok)}] ${finding.title}`);
    console.log(`         ${finding.because}`);
  }
  console.log("");
}

console.log(`[${mark(report.app.ok)}] ${report.app.title}`);
console.log(`       ${report.app.because}\n`);

console.log(`verdict: ${report.verdict}`);

console.log("\noperational confirmation required -- names cannot answer these");
for (const item of report.unjudged) console.log(`  - ${item}`);
console.log("\nnotes");
for (const note of report.notes) console.log(`  - ${note}`);

process.exit(exitCode);
