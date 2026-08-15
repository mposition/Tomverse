import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  findUsageBucketRangeProblems,
  getInt4CreditBoundary,
  getPlanGuardrailStorage,
  POSTGRES_INT4_MAX,
  POSTGRES_INT8_MAX,
} from "../lib/usageBucketRange.ts";
import { usageBucketCount } from "../lib/chatUsageBucketCount.ts";

const prismaSchema = readFileSync("prisma/schema.prisma", "utf8");
const migrationSql = readdirSync("prisma/migrations", { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    try {
      return readFileSync(
        join("prisma/migrations", entry.name, "migration.sql"),
        "utf8"
      );
    } catch {
      return "";
    }
  })
  .join("\n");

test("the shipped schema and migrations satisfy the storage contract", () => {
  assert.deepEqual(
    findUsageBucketRangeProblems({ prismaSchema, migrationSql }),
    []
  );
});

test("ChatUsageBucket.count is declared BigInt", () => {
  const model = prismaSchema.match(/model\s+ChatUsageBucket\s*\{([\s\S]*?)\n\}/);
  assert.ok(model, "ChatUsageBucket is missing from the schema");
  assert.match(model[1], /^\s*count\s+BigInt\b/m);
});

test("narrowing the column back to an integer type is rejected", () => {
  // The check has to fail on the thing it exists to prevent, or it is theatre.
  const narrowedSchema = prismaSchema.replace(
    /(model\s+ChatUsageBucket\s*\{[\s\S]*?\n\s*count\s+)BigInt/,
    "$1Int"
  );
  assert.notEqual(narrowedSchema, prismaSchema, "fixture did not apply");
  const problems = findUsageBucketRangeProblems({
    prismaSchema: narrowedSchema,
    migrationSql,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /must stay `BigInt`/);
});

test("a migration that narrows the column is rejected", () => {
  const problems = findUsageBucketRangeProblems({
    prismaSchema,
    migrationSql: `${migrationSql}
      ALTER TABLE "ChatUsageBucket" ALTER COLUMN "count" SET DATA TYPE INTEGER;`,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /narrows ChatUsageBucket/);
});

test("every default plan's largest guardrail fits the column and JavaScript", () => {
  const storage = getPlanGuardrailStorage();
  assert.equal(storage.length, 3);
  for (const plan of storage) {
    assert.ok(
      Number.isSafeInteger(plan.largestStoredValue),
      `${plan.plan} is not a safe integer`
    );
    assert.ok(
      BigInt(plan.largestStoredValue) <= POSTGRES_INT8_MAX,
      `${plan.plan} exceeds bigint`
    );
    // Read-back must survive the same narrowing every consumer performs.
    assert.equal(
      usageBucketCount(BigInt(plan.largestStoredValue)),
      plan.largestStoredValue
    );
  }
});

test("the Max plan is the one that outgrew int4, and by the documented amount", () => {
  const max = getPlanGuardrailStorage().find((plan) => plan.plan === "Max");
  assert.ok(max);
  // 10,000 monthly credits x 40,000 micro-USD x 1.25 headroom x 5 purchased
  // headroom -- the exact product recorded in the policy document.
  assert.equal(max.largestStoredValue, 2_500_000_000);
  assert.equal(max.exceedsInt4, true);
  assert.ok(max.largestStoredValue > POSTGRES_INT4_MAX);

  // Pro stays under it, which is why only Max accounts failed in production.
  const pro = getPlanGuardrailStorage().find((plan) => plan.plan === "Pro");
  assert.equal(pro.exceedsInt4, false);
});

test("the int4 boundary is about 8,590 monthly credits", () => {
  const boundary = getInt4CreditBoundary();
  assert.ok(
    boundary > 8_580 && boundary < 8_600,
    `boundary was ${boundary}, expected ~8,590`
  );
});

test("usageBucketCount narrows a bigint and refuses an unsafe one", () => {
  assert.equal(usageBucketCount(BigInt(2_500_000_000)), 2_500_000_000);
  assert.equal(usageBucketCount(null), 0);
  assert.equal(usageBucketCount(undefined), 0);
  assert.equal(usageBucketCount(0n), 0);
  assert.throws(
    () => usageBucketCount(BigInt(Number.MAX_SAFE_INTEGER) + 2n),
    /supported range/
  );
});

test("the narrowed count is JSON-serializable where the raw column value is not", () => {
  // This is the whole reason read boundaries call `usageBucketCount()` rather
  // than passing the column through. `NextResponse.json()` is
  // `JSON.stringify`, and a `bigint` has no serialization -- so a route that
  // forwards the raw value answers 500 for exactly those customers who have a
  // usage row, and 200 for everyone else.
  assert.throws(
    () => JSON.stringify({ creditsToday: 17n }),
    /Do not know how to serialize a BigInt/
  );
  assert.equal(
    JSON.stringify({ creditsToday: usageBucketCount(17n) }),
    '{"creditsToday":17}'
  );
  // Absent and zero both narrow to the same JSON number, which is why neither
  // ever revealed the failure.
  assert.equal(
    JSON.stringify({ creditsToday: usageBucketCount(undefined) }),
    '{"creditsToday":0}'
  );
  assert.equal(
    JSON.stringify({ creditsToday: usageBucketCount(0n) }),
    '{"creditsToday":0}'
  );
  // The full column width survives, still as a number rather than a string.
  assert.equal(
    JSON.stringify({ creditsMonth: usageBucketCount(2_500_000_000n) }),
    '{"creditsMonth":2500000000}'
  );
});

test("the policy document records the storage contract", () => {
  // AGENTS.md sends readers here before they touch a cost limit, so the
  // constraint that caused the outage has to be findable in it.
  const policy = readFileSync(
    "docs/policy/credit-and-cost-limits.md",
    "utf8"
  );
  assert.match(policy, /BIGINT/);
  assert.match(policy, /2,500,000,000/);
  assert.match(policy, /2,147,483,647/);
  assert.match(policy, /8,590/);
  assert.match(policy, /usageBucketCount\(\)/);
  assert.match(policy, /Number\.isSafeInteger\(\)/);
  assert.match(policy, /widen_chat_usage_bucket_count/);
});
