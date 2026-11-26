import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

let database;
try { database = new URL(process.env.TEST_DATABASE_URL ?? ""); }
catch { /* Report a missing or invalid local target below. */ }

if (!database || !["postgres:", "postgresql:"].includes(database.protocol)
  || !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname)
  || !/(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(database.pathname.slice(1))) {
  console.error("Set TEST_DATABASE_URL to a disposable loopback PostgreSQL database with a test marker in its name.");
  process.exit(1);
}

const runner = resolve(import.meta.dirname, "run-db-integration-tests.mjs");
const result = spawnSync(process.execPath, [runner], {
  env: {
    ...process.env,
    DB_INTEGRATION_GROUP: "",
    DB_INTEGRATION_SUITES: "tests/integration/mobile-auth-schema.db.test.ts,tests/integration/mobile-auth-service.db.test.ts,tests/integration/desktop-remote-control.db.test.ts",
  },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
