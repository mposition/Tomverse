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

test("orchestrator drives the canonical AMUX recovery endpoint on a bounded cadence", async () => {
  const [scheduler, api, recoverRoute] = await Promise.all([
    readFile(schedulerPath, "utf8"),
    readFile(apiPath, "utf8"),
    readFile(recoverRoutePath, "utf8"),
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
  assert.match(recoverRoute, /await sweepExpiredAmuxQuotaObservations\(\)/);
  assert.match(recoverRoute, /if \(!isAmuxExecutionApiEnabled\(\)\)/);
  assert.ok(
    recoverRoute.indexOf("await sweepExpiredAmuxQuotaObservations()") <
      recoverRoute.indexOf("if (!isAmuxExecutionApiEnabled())"),
  );
});
