import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AMUX_V19_NON_WEB_VALUES, AMUX_V19_WEB_OPERATOR_VALUES,
  AMUX_V19_WEB_SWITCHES } from "../lib/amux/v19SessionSwitches.mjs";
import { parseAmuxV19SwitchArgs, planAmuxV19Switches } from
  "../scripts/amux-v19-switches.mjs";

const root = process.cwd();
function sources(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(?:ts|tsx|mjs)$/.test(entry.name) ? [path] : [];
  });
}
const code = ["app", "lib", "scripts"].flatMap(sources)
  .filter((path) => !path.replaceAll("\\", "/").endsWith("lib/amux/v19SessionSwitches.mjs") &&
    !path.replaceAll("\\", "/").endsWith("scripts/amux-v19-switches.mjs"))
  .map((path) => readFileSync(join(root, path), "utf8")).join("\n");

test("every listed switch is a name the code reads", () => {
  for (const name of [...AMUX_V19_WEB_SWITCHES, ...AMUX_V19_WEB_OPERATOR_VALUES,
    ...AMUX_V19_NON_WEB_VALUES]) {
    assert.ok(code.includes(`"${name}"`) || code.includes(`.${name}`), name);
  }
  assert.equal(new Set(AMUX_V19_WEB_SWITCHES).size, AMUX_V19_WEB_SWITCHES.length);
});

test("every v19 and session-intake name in the code is accounted for", () => {
  const read = new Set([...code.matchAll(
    /[".](TOMVERSE_AMUX_(?:V19_[A-Z0-9_]+|SESSION_INTAKE[A-Z0-9_]*))\b/g)]
    .map((match) => match[1]));
  const known = new Set([...AMUX_V19_WEB_SWITCHES, ...AMUX_V19_WEB_OPERATOR_VALUES,
    ...AMUX_V19_NON_WEB_VALUES]);
  // A new v19 switch must join the list (or be named as an operator or
  // non-web value) so one command still switches the flow on.
  assert.deepEqual([...read].filter((name) => !known.has(name)).sort(), []);
});

test("the plan never copies an operator value and leaves other values alone", () => {
  const variables = Object.fromEntries(AMUX_V19_WEB_SWITCHES.map((name) =>
    [name, "enabled"]));
  delete variables[AMUX_V19_WEB_SWITCHES[0]];
  variables[AMUX_V19_WEB_SWITCHES[1]] = "disabled";
  variables.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET = "super-secret-value";
  const plan = planAmuxV19Switches(variables);
  assert.deepEqual(plan.missing, [AMUX_V19_WEB_SWITCHES[0]]);
  assert.deepEqual(plan.other, [{ name: AMUX_V19_WEB_SWITCHES[1], value: "disabled" }]);
  assert.equal(plan.operator.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET, "set");
  assert.equal(plan.operator.TOMVERSE_AMUX_V19_GITHUB_READ_TOKEN, "missing");
  assert.ok(!JSON.stringify(plan).includes("super-secret-value"));
});

test("production needs an explicit confirmation to write", () => {
  assert.ok(parseAmuxV19SwitchArgs([]).error);
  assert.ok(parseAmuxV19SwitchArgs(["--environment", "prod"]).error);
  assert.deepEqual(parseAmuxV19SwitchArgs(["--environment", "staging", "--apply"]),
    { environment: "staging", apply: true, confirmProduction: false });
  assert.ok(parseAmuxV19SwitchArgs(["--environment=production", "--apply"]).error);
  assert.equal(parseAmuxV19SwitchArgs(["--environment=production", "--apply",
    "--confirm-production"]).apply, true);
  assert.equal(parseAmuxV19SwitchArgs(["--environment=production"]).apply, false);
});
