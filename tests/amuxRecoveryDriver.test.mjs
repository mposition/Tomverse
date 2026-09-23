import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schedulerPath = new URL(
  "../apps/tomverse-orchestrator/src/scheduler.rs",
  import.meta.url,
);
const apiPath = new URL(
  "../apps/tomverse-orchestrator/src/tomverse_api.rs",
  import.meta.url,
);
const recoverRoutePath = new URL(
  "../app/api/internal/amux/execution/recover/route.ts",
  import.meta.url,
);
const telemetryPath = new URL("../lib/amux/telemetry.ts", import.meta.url);
const boundaryPath = new URL("../lib/amux/dbBoundary.ts", import.meta.url);
const executionPath = new URL("../lib/amux/execution.ts", import.meta.url);

test("orchestrator drives the canonical AMUX recovery endpoint on a bounded cadence", async () => {
  const [scheduler, api, recoverRoute, telemetry, boundary, execution] =
    await Promise.all([
      readFile(schedulerPath, "utf8"),
      readFile(apiPath, "utf8"),
      readFile(recoverRoutePath, "utf8"),
      readFile(telemetryPath, "utf8"),
      readFile(boundaryPath, "utf8"),
      readFile(executionPath, "utf8"),
    ]);

  assert.match(
    scheduler,
    /const RECOVERY_INTERVAL: Duration = Duration::from_secs\(30\);/,
  );
  assert.match(scheduler, /self\.api\.execution_recover\(\)\.await/);
  assert.match(
    scheduler,
    /next_recovery = Instant::now\(\) \+ RECOVERY_INTERVAL/,
  );
  assert.match(api, /pub async fn execution_recover/);
  assert.match(api, /\/api\/internal\/amux\/execution\/recover/);
  assert.match(api, /\.timeout\(TOMVERSE_INTERNAL_RECOVERY_TIMEOUT\)/);
  assert.match(
    api,
    /TOMVERSE_INTERNAL_RECOVERY_TIMEOUT: Duration = Duration::from_secs\(15\)/,
  );
  assert.match(api, /pub more: Option<bool>/);
  assert.match(scheduler, /more = outcome\.more\.unwrap_or\(false\)/);
  assert.match(boundary, /AMUX_LIFECYCLE_ROUTE_BUDGET_MS = 12_000/);
  assert.match(recoverRoute, /withAmuxRouteBudget/);
  assert.match(recoverRoute, /AMUX_LIFECYCLE_ROUTE_BUDGET_MS/);
  assert.match(recoverRoute, /await sweepExpiredAmuxQuotaObservations\(\)/);
  assert.match(recoverRoute, /if \(!isAmuxExecutionApiEnabled\(\)\)/);
  assert.ok(
    recoverRoute.indexOf("await sweepExpiredAmuxQuotaObservations()") <
      recoverRoute.indexOf("if (!isAmuxExecutionApiEnabled())"),
  );
  assert.match(telemetry, /AMUX_QUOTA_SWEEP_BATCH_SIZE = 200/);
  assert.match(telemetry, /LIMIT \$\{AMUX_QUOTA_SWEEP_BATCH_SIZE\}/);
  assert.match(telemetry, /FOR UPDATE SKIP LOCKED/);
  assert.match(telemetry, /AMUX_DB_BOUNDARIES\.quotaObservationSweep/);
  assert.match(execution, /AMUX_DB_BOUNDARIES\.executionStart/);
  assert.match(execution, /AMUX_DB_BOUNDARIES\.executionHeartbeat/);
  assert.match(execution, /AMUX_DB_BOUNDARIES\.executionSettle/);
  assert.match(execution, /reason: recoveryReason/);
});
