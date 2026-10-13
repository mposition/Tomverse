import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const migration = async (name, file = "migration.sql") =>
  readFile(resolve(root, "prisma", "migrations", name, file), "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const v270 = "20261013270000_amux_native_api_usage_provenance";
const v280 = "20261013280000_amux_native_api_first_task_scope";

function shapeCheck(sql) {
  const marker = 'ADD CONSTRAINT "AmuxCliUsageEvent_shape_check" CHECK (';
  const start = sql.lastIndexOf(marker);
  assert.notEqual(start, -1);
  const bodyStart = start + marker.length;
  const end = sql.indexOf("\n\nCOMMIT;", bodyStart);
  assert.notEqual(end, -1);
  assert.equal(sql.slice(end - 2, end), ");");
  return sql.slice(bodyStart, end - 2);
}

test("v270 preserves the CLI branches and adds honest native API provenance", async () => {
  const [sql, rawBaseline] = await Promise.all([
    migration(v270), migration(v270, "baseline-check.json"),
  ]);
  const baseline = JSON.parse(rawBaseline);
  assert.equal(sha256(sql),
    "7a41bb9c1d794dfb2aeb90f354dd078c2378d2d7d5c53818138cf075b4d190e5");
  assert.equal(baseline.migrationSqlSha256, sha256(sql));
  assert.match(sql, /\("cli" = 'codex' AND "provider" = 'openai'\)/);
  assert.match(sql, /\("cli" = 'claude' AND "provider" = 'anthropic'\)/);
  assert.match(sql, /\("cli" = 'anthropic_api' AND "provider" = 'anthropic'\)/);
  assert.match(sql, /"cli" = 'codex'[\s\S]*"source" = 'codex_jsonl'/);
  assert.match(sql, /"cli" = 'claude'[\s\S]*"source" = 'claude_result'/);
  assert.match(sql,
    /"cli" = 'anthropic_api'[\s\S]*"authentication" = 'api_key'[\s\S]*"source" = 'anthropic_messages_api'/);
});

test("v280 changes only the API scope after the v270 shape", async () => {
  const [sql270, sql280, rawBaseline] = await Promise.all([
    migration(v270), migration(v280), migration(v280, "baseline-check.json"),
  ]);
  const baseline = JSON.parse(rawBaseline);
  const originalShape = shapeCheck(sql270);
  const narrowedShape = shapeCheck(sql280);
  const guardMarker = '\n    ("cli" <> \'anthropic_api\' OR (';
  const guardStart = narrowedShape.lastIndexOf(guardMarker);
  assert.notEqual(guardStart, -1);
  assert.equal(narrowedShape.slice(0, guardStart - 4), originalShape);
  assert.equal(sha256(sql280),
    "6bb3fa473f3048e30a2131a817de85b43d99817c4cba429a918b9696ec712709");
  assert.equal(baseline.migrationSqlSha256, sha256(sql280));
  assert.deepEqual(baseline.replacedChecks, [{
    table: "AmuxCliUsageEvent",
    constraint: "AmuxCliUsageEvent_shape_check",
    previousDefinitionSha256:
      "377a8f1fdf3f2522dddcc1e3441eae81da5bea739fef45fc1095c36f8394e886",
  }]);
  assert.match(sql280, /"bindingKind" = 'task_attempt'/);
  assert.match(sql280,
    /"taskId" = 'c48886b9-86f8-4631-8db8-c0b288a707af'/);
  assert.match(sql280, /"status" IN \('succeeded','failed'\)/);
  assert.match(sql280, /"actualModelId" = "selectedModelId"/);
  assert.match(sql280, /"completedTurns" BETWEEN 1 AND 8/);
  assert.match(sql280,
    /"projectedApiCostMicrousd" BETWEEN 0 AND 3400000/);
  assert.match(sql280, /"pricingVersion" IS NOT NULL/);
  assert.match(sql280, /"actualApiCostMicrousd" IS NULL/);
});
