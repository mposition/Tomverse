import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  findRestoreDrillProblems,
  REQUIRED_SIDE_EFFECT_DISABLES,
  summariseRestoreDrillProblems,
} from "../lib/railwayRestorePreflightCore.mjs";

// Every check refuses on absence. The fixtures below start from a fully
// configured, fully isolated drill and remove one thing at a time, because
// the failure mode this guards against is not a wrong value -- it is a value
// nobody set, falling back to the deployment's own production configuration.

const disabledEnv = () =>
  Object.fromEntries(
    REQUIRED_SIDE_EFFECT_DISABLES.map((guard) => [guard.name, "1"])
  );

const PRODUCTION = {
  projectId: "prj_production",
  environmentId: "env_production",
  serviceId: "svc_production",
  databaseUrl: "postgresql://u:p@monorail.proxy.rlwy.net:5432/railway",
  directDatabaseUrl: "postgresql://u:p@postgres-prod.railway.internal:5432/railway",
  privateNetworkHostSuffixes: [".railway.internal"],
};

const healthy = (overrides = {}) => ({
  approvalTicket: "https://github.com/mposition/tomverse/issues/500",
  drillOwner: "@mposition",
  backupId: "backup_01J8XYZ",
  backupTakenAt: "2026-08-02T00:00:00.000Z",
  cleanupTargets: ["prj_drill", "svc_drill_db"],
  ...overrides,
  target: {
    projectId: "prj_drill",
    environmentId: "env_drill",
    serviceId: "svc_drill",
    databaseUrl:
      "postgresql://u:p@drill-db.example.net:5432/tomverse-restore-drill-2026-08-02",
    directDatabaseUrl: null,
    ...(overrides.target || {}),
  },
  production: { ...PRODUCTION, ...(overrides.production || {}) },
  // Replaced, not merged: several tests work by *removing* a disable, and a
  // merge would silently put it back.
  env: overrides.env ?? disabledEnv(),
});

const codes = (input) =>
  summariseRestoreDrillProblems(findRestoreDrillProblems(input)).map(
    (problem) => problem.code
  );

test("a fully configured, fully isolated drill passes", () => {
  assert.deepEqual(codes(healthy()), []);
});

test("an empty configuration fails rather than defaulting to anything", () => {
  const problems = findRestoreDrillProblems({ target: {}, production: {}, env: {} });
  assert.ok(problems.length > 10);
  // Not a single check may pass on absence.
  assert.equal(
    problems.some((problem) => problem.code === "missing_approval_ticket"),
    true
  );
  assert.equal(
    problems.some((problem) => problem.code === "side_effect_not_disabled"),
    true
  );
});

test("approval, owner, backup and cleanup are each required on their own", () => {
  assert.deepEqual(codes(healthy({ approvalTicket: null })), [
    "missing_approval_ticket",
  ]);
  assert.deepEqual(codes(healthy({ drillOwner: null })), ["missing_drill_owner"]);
  assert.deepEqual(codes(healthy({ backupId: null })), ["missing_backup_id"]);
  assert.deepEqual(codes(healthy({ backupTakenAt: null })), [
    "missing_backup_timestamp",
  ]);
  assert.deepEqual(codes(healthy({ cleanupTargets: [] })), [
    "missing_cleanup_targets",
  ]);
});

test("project, environment and service ids must be passed, never inherited", () => {
  // `railway link` and the current directory are ambient state that survives
  // between sessions. A drill that relies on them is one `cd` from production.
  assert.deepEqual(codes(healthy({ target: { projectId: null } })), [
    "missing_target_project_id",
  ]);
  assert.deepEqual(codes(healthy({ target: { environmentId: null } })), [
    "missing_target_environment_id",
  ]);
  assert.deepEqual(codes(healthy({ target: { serviceId: null } })), [
    "missing_target_service_id",
  ]);
});

test("a target that is a production identifier is refused", () => {
  assert.deepEqual(
    codes(healthy({ target: { projectId: PRODUCTION.projectId } })),
    ["target_is_production_project"]
  );
  assert.deepEqual(
    codes(healthy({ target: { environmentId: PRODUCTION.environmentId } })),
    ["target_is_production_environment"]
  );
  assert.deepEqual(
    codes(healthy({ target: { serviceId: PRODUCTION.serviceId } })),
    ["target_is_production_service"]
  );
});

test("a production connection string as the target is refused outright", () => {
  const problems = codes(
    healthy({ target: { databaseUrl: PRODUCTION.databaseUrl } })
  );
  assert.ok(problems.includes("target_url_is_production_url"));
});

test("a different database on the production host is not isolation", () => {
  const problems = codes(
    healthy({
      target: {
        databaseUrl:
          "postgresql://u:p@monorail.proxy.rlwy.net:5432/tomverse-restore-drill-2026-08-02",
      },
    })
  );
  assert.ok(problems.includes("target_host_is_production_host"));
});

test("production's private network is refused as a restore target", () => {
  const problems = codes(
    healthy({
      target: {
        databaseUrl:
          "postgresql://u:p@postgres-copy.railway.internal:5432/tomverse-restore-drill-2026-08-02",
      },
    })
  );
  assert.ok(problems.includes("target_uses_production_private_network"));
});

test("a target whose name looks like production is refused", () => {
  for (const url of [
    "postgresql://u:p@db-production.example.net:5432/tomverse-restore-drill-2026-08-02",
    "postgresql://u:p@drill-db.example.net:5432/tomverse-prod-restore-drill-2026-08-02",
    "postgresql://u:p@drill-db.example.net:5432/live-restore-drill-2026-08-02",
  ]) {
    assert.ok(
      codes(healthy({ target: { databaseUrl: url } })).includes(
        "target_name_looks_like_production"
      ),
      url
    );
  }
});

test("the target database name must carry restore-drill and the date", () => {
  assert.ok(
    codes(
      healthy({
        target: {
          databaseUrl: "postgresql://u:p@drill-db.example.net:5432/scratch-2026-08-02",
        },
      })
    ).includes("target_name_missing_drill_marker")
  );
  assert.ok(
    codes(
      healthy({
        target: {
          databaseUrl: "postgresql://u:p@drill-db.example.net:5432/tomverse-restore-drill",
        },
      })
    ).includes("target_name_missing_date")
  );
});

test("an unparseable target URL is a failure, not a pass", () => {
  assert.ok(
    codes(healthy({ target: { databaseUrl: "not a url" } })).includes(
      "unparseable_target_url"
    )
  );
});

test("every outbound side effect must be individually disabled", () => {
  for (const guard of REQUIRED_SIDE_EFFECT_DISABLES) {
    const missing = disabledEnv();
    delete missing[guard.name];
    const problems = findRestoreDrillProblems(healthy({ env: missing }));
    const hit = problems.find(
      (problem) =>
        problem.code === "side_effect_not_disabled" &&
        problem.message.includes(guard.name)
    );
    assert.ok(hit, `${guard.name} must be required`);
    // The message has to say what would happen, or nobody can weigh it.
    assert.ok(hit.message.includes(guard.effect), guard.name);
  }
});

test("a side-effect variable set to something other than a disabling value fails", () => {
  const enabled = disabledEnv();
  enabled.EMAIL_DELIVERY_DISABLED = "0";
  assert.ok(
    codes(healthy({ env: enabled })).includes("side_effect_not_disabled")
  );
  enabled.EMAIL_DELIVERY_DISABLED = "maybe";
  assert.ok(
    codes(healthy({ env: enabled })).includes("side_effect_not_disabled")
  );
});

test("the disable list covers every outbound effect the runbook names", () => {
  const names = REQUIRED_SIDE_EFFECT_DISABLES.map((guard) => guard.name);
  assert.deepEqual(new Set(names).size, names.length);
  for (const required of [
    "STRIPE_MUTATIONS_DISABLED",
    "EMAIL_DELIVERY_DISABLED",
    "ADMIN_NOTIFICATIONS_DISABLED",
    "OAUTH_PROVIDERS_DISABLED",
    "SCHEDULED_JOBS_DISABLED",
    "AI_PROVIDER_CALLS_DISABLED",
    "ANALYTICS_DELIVERY_DISABLED",
    "OBJECT_STORAGE_WRITES_DISABLED",
  ]) {
    assert.ok(names.includes(required), required);
  }
});

test("duplicate findings across the two target URLs are reported once", () => {
  const problems = summariseRestoreDrillProblems(
    findRestoreDrillProblems(
      healthy({
        target: {
          databaseUrl: PRODUCTION.databaseUrl,
          directDatabaseUrl: PRODUCTION.databaseUrl,
        },
      })
    )
  );
  const urlProblems = problems.filter(
    (problem) => problem.code === "target_url_is_production_url"
  );
  assert.equal(urlProblems.length, 2, "each field is named separately");
  assert.equal(
    new Set(problems.map((problem) => problem.message)).size,
    problems.length
  );
});

test("neither drill script creates or mutates a Railway resource", () => {
  for (const relative of [
    "scripts/railway-restore-preflight.mjs",
    "scripts/railway-restore-verify.mjs",
  ]) {
    const source = readFileSync(join(process.cwd(), relative), "utf8");
    for (const forbidden of [
      "create-project",
      "create-service",
      "create-deployment",
      "set-variables",
      "redeploy",
      "railway up",
      "railway run",
    ]) {
      assert.equal(source.includes(forbidden), false, `${relative}: ${forbidden}`);
    }
  }
  // And the verifier only ever reads.
  const verify = readFileSync(
    join(process.cwd(), "scripts/railway-restore-verify.mjs"),
    "utf8"
  );
  const queryBlock = verify.slice(
    verify.indexOf("const QUERIES"),
    verify.indexOf("const client =")
  );
  for (const forbidden of ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE"]) {
    assert.equal(queryBlock.toUpperCase().includes(forbidden), false, forbidden);
  }
});
