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

// How the test database gets its schema.
//
// `migrations` is the default because it is the only mode that proves anything
// about deployment: `db push` reads schema.prisma directly and would keep
// passing even if the migration history could not build the schema at all --
// which is exactly the state this repository was in until the baseline
// migration replaced it. Building from migrations and then asserting no drift
// also catches a schema.prisma change that nobody wrote a migration for.
//
// `push` stays available for local iteration on a schema whose migration is
// not written yet.
const schemaSource = (
  process.env.DB_INTEGRATION_SCHEMA_SOURCE || "migrations"
).trim();
if (!["migrations", "push"].includes(schemaSource)) {
  fail(
    `DB_INTEGRATION_SCHEMA_SOURCE must be "migrations" or "push"; received "${schemaSource}".`
  );
}

if (schemaSource === "push") {
  console.warn(
    "[db-integration] DB_INTEGRATION_SCHEMA_SOURCE=push: the migration history is NOT exercised by this run."
  );
  run(
    ["node_modules/prisma/build/index.js", "db", "push"],
    "Synchronizing the current Prisma schema"
  );
} else {
  // `db push` regenerates the client as part of its work; `migrate deploy`
  // does not. Without this, a schema change that has been migrated but not
  // reinstalled fails as `Cannot read properties of undefined` on a model the
  // client has never heard of -- which says nothing about what is wrong.
  run(
    ["node_modules/prisma/build/index.js", "generate"],
    "Generating the Prisma client for the current schema"
  );
  run(
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    "Building the schema from the migration history"
  );
  run(
    [
      "node_modules/prisma/build/index.js",
      "migrate",
      "diff",
      "--from-schema",
      "prisma/schema.prisma",
      "--to-config-datasource",
      "prisma.config.ts",
      "--exit-code",
    ],
    "Checking the migrated schema for drift against schema.prisma"
  );
}
run(
  [
    "--conditions=react-server",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/credit-finance.db.test.ts",
    "tests/integration/chat-concurrency.db.test.ts",
    "tests/integration/chat-rate-limit.db.test.ts",
    "tests/integration/fallback-pricing-metrics.db.test.ts",
    "tests/integration/model-registry.db.test.ts",
    "tests/integration/admin-security.db.test.ts",
    "tests/integration/admin-users.db.test.ts",
    "tests/integration/login-methods.db.test.ts",
    "tests/integration/account-deletion.db.test.ts",
    "tests/integration/conversation-title.db.test.ts",
    "tests/integration/conversation-lock-migration.db.test.ts",
    "tests/integration/provider-recovery.db.test.ts",
    "tests/integration/provider-failure-scope.db.test.ts",
    "tests/integration/subscription-sync-ordering.db.test.ts",
    "tests/integration/plan-change-reservation.db.test.ts",
    "tests/integration/image-generation.db.test.ts",
    "tests/integration/external-import-schema.db.test.ts",
    "tests/integration/external-import-lifecycle.db.test.ts",
  ],
  "Running financial, credit, chat-concurrency, chat-rate-limit, fallback-pricing, model-registry, admin-security, admin-users, login-methods, account-deletion, conversation-title, conversation-lock-migration, provider-recovery, provider-failure-scope, subscription-sync-ordering, plan-change-reservation, image-generation, and external-import transaction scenarios"
);
// Runs apart from the batch above: it drives the real route handlers, which
// needs mock.module (--experimental-test-module-mocks) to replace the session
// seam. Module mocks are process-global, so keeping this in its own process
// stops the next-auth stub from leaking into the suites above.
run(
  [
    "--conditions=react-server",
    "--experimental-test-module-mocks",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/perplexity-deep-research-route.db.test.ts",
  ],
  "Running the deep-research submit/poll credit and persistence scenarios"
);
run(
  [
    "--conditions=react-server",
    "--experimental-test-module-mocks",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/provider-recovery-route.db.test.ts",
  ],
  "Running the administrator provider recovery route and its audit trail"
);
// Also its own process: it replaces the notification queue module to inject an
// outbox write failure, which every importer in the process would otherwise
// inherit.
run(
  [
    "--conditions=react-server",
    "--experimental-test-module-mocks",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/refund-decision-route.db.test.ts",
  ],
  "Running the administrator refund decision transaction and its outbox"
);
// Its own process for the same reason as the refund decision suite: it wraps
// the notification queue module to inject an enqueue failure, and it stubs the
// session and admin-auth seams for the feedback routes.
run(
  [
    "--conditions=react-server",
    "--experimental-test-module-mocks",
    "--no-warnings=ExperimentalWarning",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "tests/integration/feedback-lifecycle.db.test.ts",
  ],
  "Running the feedback lifecycle notification transaction scenarios"
);
