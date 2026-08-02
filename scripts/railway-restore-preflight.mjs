// Fail-closed preflight for an isolated Railway restore drill.
//
//   npm run drill:railway-restore-preflight
//   npm run drill:railway-restore-preflight -- --json
//
// Run this BEFORE creating any Railway resource and again before starting the
// restored service. It creates nothing, connects to nothing and writes
// nothing: it reads the variables the drill was configured with and refuses
// when any of them would let the drill touch production or let the restored
// copy reach the outside world.
//
// It refuses on absence. An unset variable is a failure, not a default --
// "we cannot tell whether this is production" gets the same answer as "this
// is production".
//
// Configure with (all required):
//
//   DRILL_APPROVAL_TICKET      the ticket approving the drill
//   DRILL_OWNER                who is accountable for destroying the copy
//   DRILL_BACKUP_ID            which backup is being restored
//   DRILL_BACKUP_TAKEN_AT      when it was taken (RPO is measured from it)
//   DRILL_CLEANUP_TARGETS      comma-separated ids to destroy afterwards
//   DRILL_TARGET_PROJECT_ID    explicit, never inherited from `railway link`
//   DRILL_TARGET_ENVIRONMENT_ID
//   DRILL_TARGET_SERVICE_ID
//   DRILL_TARGET_DATABASE_URL  name must contain "restore-drill" and the date
//   DRILL_TARGET_DIRECT_DATABASE_URL   (optional)
//   PRODUCTION_PROJECT_ID / PRODUCTION_ENVIRONMENT_ID / PRODUCTION_SERVICE_ID
//   PRODUCTION_DATABASE_URL / PRODUCTION_DIRECT_DATABASE_URL
//   PRODUCTION_PRIVATE_NETWORK_SUFFIXES  (default: .railway.internal)
//
//   plus every disable in REQUIRED_SIDE_EFFECT_DISABLES.
//
// No connection string is ever printed: identifiers are reported as host and
// database name only.

import {
  findRestoreDrillProblems,
  REQUIRED_SIDE_EFFECT_DISABLES,
  summariseRestoreDrillProblems,
} from "../lib/railwayRestorePreflightCore.mjs";

const json = process.argv.includes("--json");
const env = process.env;

const list = (value) =>
  (value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const input = {
  approvalTicket: env.DRILL_APPROVAL_TICKET?.trim() || null,
  drillOwner: env.DRILL_OWNER?.trim() || null,
  backupId: env.DRILL_BACKUP_ID?.trim() || null,
  backupTakenAt: env.DRILL_BACKUP_TAKEN_AT?.trim() || null,
  cleanupTargets: list(env.DRILL_CLEANUP_TARGETS),
  target: {
    projectId: env.DRILL_TARGET_PROJECT_ID?.trim() || null,
    environmentId: env.DRILL_TARGET_ENVIRONMENT_ID?.trim() || null,
    serviceId: env.DRILL_TARGET_SERVICE_ID?.trim() || null,
    databaseUrl: env.DRILL_TARGET_DATABASE_URL?.trim() || null,
    directDatabaseUrl: env.DRILL_TARGET_DIRECT_DATABASE_URL?.trim() || null,
  },
  production: {
    projectId: env.PRODUCTION_PROJECT_ID?.trim() || null,
    environmentId: env.PRODUCTION_ENVIRONMENT_ID?.trim() || null,
    serviceId: env.PRODUCTION_SERVICE_ID?.trim() || null,
    databaseUrl: env.PRODUCTION_DATABASE_URL?.trim() || null,
    directDatabaseUrl: env.PRODUCTION_DIRECT_DATABASE_URL?.trim() || null,
    privateNetworkHostSuffixes: list(
      env.PRODUCTION_PRIVATE_NETWORK_SUFFIXES || ".railway.internal"
    ),
  },
  env,
};

const problems = summariseRestoreDrillProblems(findRestoreDrillProblems(input));

// Reported so the evidence file records what the drill was pointed at,
// without carrying a credential. Host and database name only -- never the URL.
const describeTarget = (url) => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parsed.port || null,
      database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    };
  } catch {
    return { host: "unparseable", port: null, database: "unparseable" };
  }
};

const evidence = {
  checkedAt: new Date().toISOString(),
  approvalTicket: input.approvalTicket,
  drillOwner: input.drillOwner,
  backupId: input.backupId,
  backupTakenAt: input.backupTakenAt,
  cleanupTargets: input.cleanupTargets,
  targetProjectId: input.target.projectId,
  targetEnvironmentId: input.target.environmentId,
  targetServiceId: input.target.serviceId,
  targetDatabase: describeTarget(input.target.databaseUrl),
  targetDirectDatabase: describeTarget(input.target.directDatabaseUrl),
  sideEffectDisables: Object.fromEntries(
    REQUIRED_SIDE_EFFECT_DISABLES.map((guard) => [
      guard.name,
      env[guard.name]?.trim() ?? null,
    ])
  ),
  ok: problems.length === 0,
  problems,
};

if (json) {
  console.log(JSON.stringify(evidence, null, 2));
} else {
  console.log("Railway restore drill preflight\n");
  console.log(`  ticket:   ${evidence.approvalTicket ?? "MISSING"}`);
  console.log(`  owner:    ${evidence.drillOwner ?? "MISSING"}`);
  console.log(
    `  backup:   ${evidence.backupId ?? "MISSING"} taken ${evidence.backupTakenAt ?? "MISSING"}`
  );
  console.log(
    `  target:   project=${evidence.targetProjectId ?? "MISSING"} ` +
      `environment=${evidence.targetEnvironmentId ?? "MISSING"} ` +
      `service=${evidence.targetServiceId ?? "MISSING"}`
  );
  console.log(
    `  database: ${evidence.targetDatabase ? `${evidence.targetDatabase.host}/${evidence.targetDatabase.database}` : "MISSING"}`
  );
  console.log(
    `  cleanup:  ${evidence.cleanupTargets.length > 0 ? evidence.cleanupTargets.join(", ") : "MISSING"}`
  );
  console.log("\n  outbound effects:");
  for (const guard of REQUIRED_SIDE_EFFECT_DISABLES) {
    const value = env[guard.name]?.trim();
    console.log(
      `    ${value ? "ok  " : "MISS"} ${guard.name.padEnd(34)} ${guard.effect}`
    );
  }
}

if (problems.length > 0) {
  console.error(
    `\nPREFLIGHT FAILED -- ${problems.length} problem(s). Create nothing and restore nothing.\n`
  );
  for (const problem of problems) {
    console.error(`  - [${problem.code}] ${problem.message}`);
  }
  console.error("\nSee docs/ops/railway-restore-drill.md.");
  process.exit(1);
}

console.log(
  "\nPreflight passed. The target is separate from production and every outbound effect is disabled.\n" +
    "Re-run this immediately before starting the restored service: a variable can be changed in between."
);
