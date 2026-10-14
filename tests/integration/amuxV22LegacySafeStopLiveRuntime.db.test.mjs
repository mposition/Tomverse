import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { seedAmuxV4PortfolioRecoveryPrerequisites } from
  "./helpers/amuxV4PortfolioSeedFixture.mjs";
import { exerciseAmuxV22LegacySafeStopFenceFixture,
  exerciseAmuxV22TaskRecoveryFixture } from
  "./helpers/amuxV22TaskRecoveryFixture.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl) return false;
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return ["127.0.0.1", "localhost"].includes(url.hostname) &&
    /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(name);
})();

// Policy v46: the physical worker re-registered after the prior attempt. The
// database refuses a safe stop bound to the attempt-time runtime and accepts
// one bound to the live runtime; the rest of the recovery chain is unchanged.
test("a legacy safe stop binds the worker's live runtime after re-registration", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const seed = await seedAmuxV4PortfolioRecoveryPrerequisites(client, {
      recoveryExecutorKind: "read_only_api_retry_v1",
    });
    const liveRuntime = { instanceId: "0f5a2c9e-6d1b-4e3a-9c7f-2b8d4e6a1c03", generation: 9 };
    const recovery = await exerciseAmuxV22TaskRecoveryFixture(client, { ...seed, liveRuntime });
    const stop = await client.query(`SELECT "workerInstanceId", "workerGeneration"
      FROM public."AmuxV22TaskRecoveryInspectionRequest" WHERE "id"=$1`,
    [recovery.safeStopFenceInput.safeStopRequestId]);
    assert.deepEqual(stop.rows[0], { workerInstanceId: liveRuntime.instanceId,
      workerGeneration: liveRuntime.generation });
    await exerciseAmuxV22LegacySafeStopFenceFixture(client, recovery.safeStopFenceInput);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
});
