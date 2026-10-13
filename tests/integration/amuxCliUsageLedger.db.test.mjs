import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

const url = process.env.TEST_DATABASE_URL;
const allowed = (() => {
  if (!url) return false;
  const parsed = new URL(url);
  return ["127.0.0.1", "localhost"].includes(parsed.hostname) &&
    /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(parsed.pathname);
})();

test("CLI usage is append-only, scoped and retained for 13 months", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL statement_timeout = '10s'");
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    const taskId = `amux-usage-task-${randomUUID()}`;
    const attemptId = randomUUID();
    await db.query(`INSERT INTO "AmuxWorkItem" ("id", "title", "status",
      "kind", "priority", "updatedAt") VALUES ($1, 'usage fixture',
      'doing', 'code', 'p3', CURRENT_TIMESTAMP)`, [taskId]);
    await db.query(`INSERT INTO "AmuxExecutionAttempt" ("id", "taskId",
      "worker", "workerInstanceId", "workerGeneration", "taskRevision",
      "heartbeatAt", "startedAt", "leaseExpiresAt", "updatedAt") VALUES ($1, $2,
      'worker-a', 'fixture', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP + interval '1 hour', CURRENT_TIMESTAMP)`, [attemptId, taskId]);
    const insert = `INSERT INTO "AmuxCliUsageEvent" (
      "id", "invocationId", "receiptDigest", "bindingKind", "attemptId",
      "taskId", "worker", "cli", "provider", "selectedModelId",
      "actualModelId", "authentication", "startedAt", "endedAt", "status",
      "completeness", "source", "inputTokens", "outputTokens",
      "cacheReadInputTokens", "inputTokensIncludeCacheRead",
      "inputTokensIncludeCacheWrite", "completedTurns",
      "createdAt", "retentionUntil") VALUES ($1, $2, $3, 'task_attempt',
      $4, $5, 'worker-a', 'claude', 'anthropic', 'claude-opus-5',
      'claude-opus-5', 'subscription', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
      'failed', 'reported_partial', 'claude_result', 100, 25, 10, false, false, 1,
      CURRENT_TIMESTAMP::timestamp(3),
      CURRENT_TIMESTAMP::timestamp(3) + interval '13 months')`;
    const eventId = randomUUID();
    await db.query(insert, [eventId, randomUUID(), "a".repeat(64), attemptId, taskId]);
    const row = await db.query(`SELECT "inputTokens", "outputTokens",
      "retentionUntil" - "createdAt" AS retention
      FROM "AmuxCliUsageEvent" WHERE "id" = $1`, [eventId]);
    assert.equal(Number(row.rows[0].inputTokens), 100);
    assert.equal(Number(row.rows[0].outputTokens), 25);
    assert.ok(row.rows[0].retention !== null);
    async function rejects(sql, params, pattern) {
      await db.query("SAVEPOINT usage_refusal");
      let error;
      try { await db.query(sql, params); }
      catch (caught) { error = caught; }
      await db.query("ROLLBACK TO SAVEPOINT usage_refusal");
      await db.query("RELEASE SAVEPOINT usage_refusal");
      assert.ok(error, "invalid usage mutation succeeded");
      assert.match(String(error), pattern);
    }
    await rejects(`UPDATE "AmuxCliUsageEvent" SET "inputTokens" = 0
      WHERE "id" = $1`, [eventId], /immutable/);
    await rejects(`DELETE FROM "AmuxCliUsageEvent" WHERE "id" = $1`,
      [eventId], /retention/);
    await rejects(`TRUNCATE "AmuxCliUsageEvent"`, [], /cannot be truncated/);
    await rejects(insert, [randomUUID(), randomUUID(), "a".repeat(64),
      attemptId, "wrong-task"], /foreign key|violates|binding/);
    const expired = await db.query(`INSERT INTO "AmuxCliUsageEvent" (
      "id", "invocationId", "receiptDigest", "bindingKind", "attemptId",
      "taskId", "worker", "cli", "provider", "selectedModelId",
      "authentication", "startedAt", "endedAt", "status",
      "completeness", "source", "inputTokensIncludeCacheRead",
      "reasoningOutputIncludedInOutput", "completedTurns",
      "createdAt", "retentionUntil") VALUES ($1, $2, $3, 'task_attempt',
      $4, $5, 'worker-a', 'codex', 'openai', 'gpt-6-astra',
      'subscription', CURRENT_TIMESTAMP - interval '14 months',
      CURRENT_TIMESTAMP - interval '14 months', 'outcome_unknown',
      'unknown', 'unreported', true, true, 0,
      (CURRENT_TIMESTAMP - interval '14 months')::timestamp(3),
      (CURRENT_TIMESTAMP - interval '14 months')::timestamp(3) + interval '13 months')
      RETURNING "id"`, [randomUUID(), randomUUID(), "b".repeat(64),
      attemptId, taskId]);
    assert.equal((await db.query(`DELETE FROM "AmuxCliUsageEvent"
      WHERE "id" = $1 RETURNING "id"`, [expired.rows[0].id])).rowCount, 1);
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await db.end();
  }
});

test("native API usage is limited to the approved FIRST Task and budget", {
  skip: allowed ? undefined : "requires a dedicated loopback test database",
}, async () => {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  let rolledBack = false;
  try {
    const before = Number((await db.query(
      `SELECT count(*)::int AS count FROM "AmuxCliUsageEvent"`)).rows[0].count);
    await db.query("BEGIN");
    await db.query("SET LOCAL statement_timeout = '10s'");
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    const taskId = "c48886b9-86f8-4631-8db8-c0b288a707af";
    const wrongTaskId = `amux-api-wrong-${randomUUID()}`;
    const attemptId = randomUUID();
    await db.query(`INSERT INTO "AmuxWorkItem" ("id", "title", "status",
      "kind", "priority", "updatedAt") VALUES
      ($1, 'native API usage fixture', 'doing', 'code', 'p3', CURRENT_TIMESTAMP),
      ($2, 'wrong native API usage fixture', 'doing', 'code', 'p3', CURRENT_TIMESTAMP)`,
    [taskId, wrongTaskId]);
    await db.query(`INSERT INTO "AmuxExecutionAttempt" ("id", "taskId",
      "worker", "workerInstanceId", "workerGeneration", "taskRevision",
      "heartbeatAt", "startedAt", "leaseExpiresAt", "updatedAt") VALUES ($1, $2,
      'worker-api', 'fixture', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP + interval '1 hour', CURRENT_TIMESTAMP)`, [attemptId, taskId]);
    const insert = `INSERT INTO "AmuxCliUsageEvent" (
      "id", "invocationId", "receiptDigest", "bindingKind", "attemptId",
      "taskId", "worker", "cli", "provider", "selectedModelId",
      "actualModelId", "authentication", "startedAt", "endedAt", "status",
      "completeness", "source", "inputTokens", "outputTokens",
      "cacheReadInputTokens", "cacheCreationInputTokens",
      "inputTokensIncludeCacheRead", "inputTokensIncludeCacheWrite",
      "reasoningOutputIncludedInOutput", "completedTurns", "pricingVersion",
      "projectedApiCostMicrousd", "actualApiCostMicrousd", "createdAt",
      "retentionUntil") VALUES ($1, $2, $3, $4, $5, $6, 'worker-api',
      'anthropic_api', 'anthropic', 'claude-opus-5-5', $7, 'api_key',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $8, 'reported_complete',
      'anthropic_messages_api', 100, 25, 10, 3, false, false, NULL, $9,
      'price-v1', $10, NULL, CURRENT_TIMESTAMP::timestamp(3),
      CURRENT_TIMESTAMP::timestamp(3) + interval '13 months')`;
    const values = (overrides = {}) => ({
      id: randomUUID(), invocationId: randomUUID(), digest: "c".repeat(64),
      bindingKind: "task_attempt", attemptId, taskId,
      actualModelId: "claude-opus-5-5", status: "succeeded", turns: 2,
      projected: "100", ...overrides,
    });
    const params = (value) => [value.id, value.invocationId, value.digest,
      value.bindingKind, value.attemptId, value.taskId, value.actualModelId,
      value.status, value.turns, value.projected];
    const success = values();
    const failed = values({ status: "failed" });
    await db.query(insert, params(success));
    await db.query(insert, params(failed));
    const rows = await db.query(`SELECT "invocationId", "receiptDigest", "cli",
      "source", "status" FROM "AmuxCliUsageEvent"
      WHERE "invocationId" = ANY($1::text[]) ORDER BY "status"`,
    [[success.invocationId, failed.invocationId]]);
    assert.deepEqual(rows.rows.map((row) => ({
      receiptDigest: row.receiptDigest, cli: row.cli, source: row.source,
      status: row.status,
    })), [
      { receiptDigest: "c".repeat(64), cli: "anthropic_api",
        source: "anthropic_messages_api", status: "failed" },
      { receiptDigest: "c".repeat(64), cli: "anthropic_api",
        source: "anthropic_messages_api", status: "succeeded" },
    ]);
    async function rejects(value) {
      await db.query("SAVEPOINT native_api_refusal");
      let error;
      try { await db.query(insert, params(value)); }
      catch (caught) { error = caught; }
      await db.query("ROLLBACK TO SAVEPOINT native_api_refusal");
      await db.query("RELEASE SAVEPOINT native_api_refusal");
      assert.ok(error, "out-of-scope native API usage succeeded");
      assert.match(String(error),
        /AmuxCliUsageEvent_(?:binding|shape)_check|AMUX CLI usage (?:analysis|attempt) binding mismatch/);
    }
    await rejects(values({ bindingKind: "idea_analysis" }));
    await rejects(values({ taskId: wrongTaskId }));
    await rejects(values({ status: "outcome_unknown" }));
    await rejects(values({ actualModelId: "claude-sonnet-5-5" }));
    await rejects(values({ turns: 9 }));
    await rejects(values({ projected: null }));
    await rejects(values({ projected: "3400001" }));
    assert.equal(Number((await db.query(`SELECT count(*)::int AS count
      FROM "AmuxCliUsageEvent" WHERE "cli" = 'anthropic_api'`)).rows[0].count), 2);
    await db.query("ROLLBACK");
    rolledBack = true;
    assert.equal(Number((await db.query(
      `SELECT count(*)::int AS count FROM "AmuxCliUsageEvent"`)).rows[0].count), before);
  } finally {
    if (!rolledBack) await db.query("ROLLBACK").catch(() => undefined);
    await db.end();
  }
});
