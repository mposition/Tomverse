import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const fail = (message) => {
  console.error(`DB integration test safety check failed: ${message}`);
  process.exit(1);
};

const rawTestDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawTestDatabaseUrl) {
  fail(
    "TEST_DATABASE_URL is required and must point to a dedicated PostgreSQL test database."
  );
}

let testDatabaseUrl;
try {
  testDatabaseUrl = new URL(rawTestDatabaseUrl);
} catch {
  fail("TEST_DATABASE_URL is not a valid URL.");
}

if (
  testDatabaseUrl.protocol !== "postgres:" &&
  testDatabaseUrl.protocol !== "postgresql:"
) {
  fail("TEST_DATABASE_URL must use the postgres or postgresql protocol.");
}

const databaseName = decodeURIComponent(testDatabaseUrl.pathname.replace(/^\//, ""));
const schemaName = testDatabaseUrl.searchParams.get("schema") || "";
const isolationMarker = `${databaseName}_${schemaName}`;
if (!/(?:^|[_-])(?:test|testing|ci)(?:[_-]|$)/i.test(isolationMarker)) {
  fail(
    "the database name or schema must contain a separate test marker such as tomverse_test."
  );
}

for (const configuredUrl of [
  process.env.DATABASE_URL,
  process.env.DIRECT_DATABASE_URL,
]) {
  if (configuredUrl?.trim() === rawTestDatabaseUrl) {
    fail("TEST_DATABASE_URL must not be identical to the configured application database URL.");
  }
}

const testEnvironment = {
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: rawTestDatabaseUrl,
  DIRECT_DATABASE_URL: rawTestDatabaseUrl,
  NEXTAUTH_SECRET:
    process.env.NEXTAUTH_SECRET || "tomverse-db-integration-test-secret-2026",
  CHAT_USER_CONCURRENT: "50",
  CHAT_USER_PER_MINUTE: "500",
  CHAT_IP_PER_MINUTE: "500",
  CHAT_USER_TOKENS_PER_DAY: "100000000",
  CHAT_USER_TOKENS_PER_MONTH: "100000000",
  CHAT_FREE_COST_MICROUSD_PER_DAY: "100000000",
  CHAT_FREE_COST_MICROUSD_PER_MONTH: "100000000",
  CHAT_PROVIDER_OPENAI_COST_MICROUSD_PER_DAY: "100000000",
  CHAT_PROVIDER_OPENAI_COST_MICROUSD_PER_MONTH: "100000000",
};

const run = (args, label) => {
  console.log(`\n[db-integration] ${label}`);
  const result = spawnSync(process.execPath, args, {
    cwd: resolve(import.meta.dirname, ".."),
    env: testEnvironment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
};

console.log(
  `[db-integration] Using dedicated database ${databaseName} on ${testDatabaseUrl.hostname}.`
);
run(
  ["node_modules/prisma/build/index.js", "db", "push"],
  "Synchronizing the current Prisma schema"
);
run(
  [
    "--conditions=react-server",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/credit-finance.db.test.ts",
    "tests/integration/model-registry.db.test.ts",
    "tests/integration/admin-security.db.test.ts",
    "tests/integration/admin-users.db.test.ts",
    "tests/integration/login-methods.db.test.ts",
    "tests/integration/account-deletion.db.test.ts",
  ],
  "Running financial, credit, model-registry, admin-security, admin-users, login-methods, and account-deletion transaction scenarios"
);
