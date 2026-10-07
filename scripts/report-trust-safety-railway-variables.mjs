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
import { fileURLToPath } from "node:url";

import {
  buildVariableManifest,
} from "./trust-safety-railway-variables-core.mjs";

/** §4 fixes one declaration site, and this is the key within it. */
const RUNNER_KEY = "trust_safety_observer";
const ENVIRONMENTS = ["production", "staging"];
const APP_SERVICE = "Tomverse";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const asJson = args.includes("--json");

const run = (command, commandArgs) => {
  const result = spawnSync(command, commandArgs, {
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
const effectiveNames = (service, environment) => {
  const stdout = run("railway", [
    "variables",
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

const declared = await declaredNames();

const manifest = buildVariableManifest({
  environments: ENVIRONMENTS.map((environment) => ({
    environment,
    declared:
      declared === undefined
        ? undefined
        : declared.absent
          ? []
          : declared.byEnvironment[environment],
    effective: effectiveNames("Trust Safety Observer", environment),
  })),
  appVariableNames: effectiveNames(APP_SERVICE, "production"),
});

const report = {
  ...manifest,
  declarationSite: ".railway/agent-runners.ts",
  runnerKey: RUNNER_KEY,
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
