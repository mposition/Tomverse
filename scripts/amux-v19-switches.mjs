/**
 * Operator command: compare the Railway web service `Tomverse` in one
 * environment with the AMUX v19 session-flow switch list, and with --apply set
 * the missing ones to `enabled` in one write (one redeploy).
 *
 *   npm run amux:v19-switches -- --environment staging
 *   npm run amux:v19-switches -- --environment staging --apply
 *   npm run amux:v19-switches -- --environment production --apply --confirm-production
 *
 * Read-only without --apply. It never sets, prints or reads back a secret
 * value: the three operator values are reported as set or missing by name.
 * Switches that are present with another value are reported and left alone.
 * Needs a logged-in Railway CLI (`railway login`) with access to the project.
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { AMUX_V19_WEB_OPERATOR_VALUES, AMUX_V19_WEB_SWITCHES } from
  "../lib/amux/v19SessionSwitches.mjs";

const ENVIRONMENTS = new Set(["dev", "staging", "production"]);
const SERVICE = "Tomverse";

export function parseAmuxV19SwitchArgs(argv) {
  const args = { environment: null, apply: false, confirmProduction: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") args.apply = true;
    else if (value === "--confirm-production") args.confirmProduction = true;
    else if (value === "--environment") args.environment = argv[++index] ?? null;
    else if (value.startsWith("--environment=")) {
      args.environment = value.slice("--environment=".length);
    } else return { error: `unknown argument: ${value}` };
  }
  if (!ENVIRONMENTS.has(args.environment)) {
    return { error: "--environment must be dev, staging or production" };
  }
  if (args.apply && args.environment === "production" && !args.confirmProduction) {
    return { error: "production needs --confirm-production as well as --apply" };
  }
  return args;
}

/** What to set, given the variables Railway reports. Values of the operator
 * entries are never copied into the plan, only whether they exist. */
export function planAmuxV19Switches(variables) {
  const present = variables && typeof variables === "object" ? variables : {};
  const plan = { enabled: [], missing: [], other: [], operator: {} };
  for (const name of AMUX_V19_WEB_SWITCHES) {
    if (!Object.hasOwn(present, name)) plan.missing.push(name);
    else if (present[name] === "enabled") plan.enabled.push(name);
    else plan.other.push({ name, value: String(present[name]) });
  }
  for (const name of AMUX_V19_WEB_OPERATOR_VALUES) {
    plan.operator[name] = Object.hasOwn(present, name) ? "set" : "missing";
  }
  return plan;
}

function railway(args) {
  return spawnSync("railway", args, { encoding: "utf8",
    shell: process.platform === "win32", maxBuffer: 16 * 1024 * 1024 });
}

async function main() {
  const args = parseAmuxV19SwitchArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`${args.error}\n`);
    process.exitCode = 2;
    return;
  }
  const scope = ["--environment", args.environment, "--service", SERVICE];
  const read = railway(["variables", ...scope, "--json"]);
  let variables;
  try { variables = JSON.parse(read.stdout); }
  catch {
    process.stderr.write("could not read the service variables " +
      "(is the Railway CLI logged in and linked to the Tomverse project?)\n");
    process.exitCode = 1;
    return;
  }
  const plan = planAmuxV19Switches(variables);
  variables = null;
  console.log(`${SERVICE} @ ${args.environment}: ${plan.enabled.length} enabled, ` +
    `${plan.missing.length} missing, ${plan.other.length} other ` +
    `(of ${AMUX_V19_WEB_SWITCHES.length})`);
  for (const name of plan.missing) console.log(`  missing  ${name}`);
  for (const { name, value } of plan.other) console.log(`  other    ${name}=${value} (left as is)`);
  for (const [name, state] of Object.entries(plan.operator)) {
    console.log(`  operator ${name}: ${state}`);
  }
  if (!args.apply) {
    if (plan.missing.length) console.log("read only; add --apply to set the missing switches.");
    return;
  }
  if (plan.missing.length === 0) {
    console.log("nothing to set.");
    return;
  }
  const write = railway(["variables", ...scope,
    ...plan.missing.flatMap((name) => ["--set", `${name}=enabled`])]);
  if (write.status !== 0) {
    process.stderr.write("setting the switches failed; read again before retrying.\n");
    process.exitCode = 1;
    return;
  }
  console.log(`set ${plan.missing.length} switch(es); Railway redeploys ${SERVICE} once.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
