// Keeps the cost guardrail arithmetic and its storage column in agreement.
//
// The guardrails are derived from each plan's credit grant and stored in
// `ChatUsageBucket."count"`. When that product outgrew int4 -- the Max plan's
// 2,500,000,000 micro-USD total-cost guardrail against int4's 2,147,483,647 --
// PostgreSQL raised 22003 in the guard query instead of returning an
// allow/deny decision, and every Max-plan chat request failed outright.
//
// So this runs on every PR: the column must still be BigInt, no migration may
// narrow it back, and no plan's derived guardrail may fall outside what the
// column or JavaScript can hold exactly. Changing a policy constant without
// re-checking the storage requirement fails here rather than in production.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  findUsageBucketRangeProblems,
  getInt4CreditBoundary,
  getPlanGuardrailStorage,
  POSTGRES_INT4_MAX,
} from "../lib/usageBucketRange.ts";

const root = process.cwd();
const prismaSchema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");

const migrationsDirectory = join(root, "prisma/migrations");
const migrationSql = readdirSync(migrationsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    try {
      return readFileSync(
        join(migrationsDirectory, entry.name, "migration.sql"),
        "utf8"
      );
    } catch {
      return "";
    }
  })
  .join("\n");

const problems = findUsageBucketRangeProblems({ prismaSchema, migrationSql });

const storage = getPlanGuardrailStorage();
const formatUsd = (microUsd) =>
  `US$${(microUsd / 1_000_000).toLocaleString("en-US", {
    maximumFractionDigits: 2,
  })}`;

for (const plan of storage) {
  console.log(
    `  ${plan.plan.padEnd(5)} largest stored value ${String(
      plan.largestStoredValue
    ).padStart(13)} micro-USD (${formatUsd(plan.largestStoredValue).padEnd(
      12
    )}) via ${plan.largestLimit}${plan.exceedsInt4 ? "  [past int4]" : ""}`
  );
}
console.log(
  `  int4 is outgrown from about ${getInt4CreditBoundary().toLocaleString(
    "en-US"
  )} monthly credits (int4 max ${POSTGRES_INT4_MAX.toLocaleString("en-US")}).`
);

if (problems.length > 0) {
  console.error(`\n${problems.length} usage-bucket storage problem(s):`);
  for (const problem of problems) console.error(`  - ${problem.message}`);
  console.error(
    "\nSee docs/policy/credit-and-cost-limits.md, the storage type contract."
  );
  process.exit(1);
}

console.log(
  `Usage bucket range check passed: ChatUsageBucket.count is BigInt and all ${storage.length} default plans fit the column and JavaScript's exact integer range.`
);
