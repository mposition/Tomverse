import { spawnSync } from "node:child_process";
import { isSamePostgresDatabaseTarget } from "../lib/postgresConnectionConfigCore.mjs";

const target = process.env.TEST_DATABASE_URL?.trim();
const fail = (message) => { console.error(message); process.exit(1); };
if (!target) fail("TEST_DATABASE_URL must name a dedicated migrated test database.");
let url;
try { url = new URL(target); } catch { fail("Invalid TEST_DATABASE_URL."); }
if (!["postgres:", "postgresql:"].includes(url.protocol) ||
    !/(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(
      decodeURIComponent(url.pathname.slice(1)) + "_" + (url.searchParams.get("schema") ?? ""))) {
  fail("The target must be PostgreSQL with an explicit test database/schema marker.");
}
for (const configured of [process.env.DATABASE_URL, process.env.DIRECT_DATABASE_URL]) {
  if (configured?.trim() && isSamePostgresDatabaseTarget(target, configured.trim())) {
    fail("The test target must differ from configured application databases.");
  }
}
const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx",
  "--test", "--test-concurrency=1", "tests/integration/routing-dispatch-instrumentation.db.test.ts",
  "tests/integration/routing-application-provenance.db.test.ts",
  "tests/integration/routing-attempt-manifest.db.test.ts"], {
  cwd: new URL("..", import.meta.url), stdio: "inherit", env: { ...process.env,
    NODE_ENV: "test", DATABASE_URL: target, DIRECT_DATABASE_URL: target,
    NEXTAUTH_SECRET: "routing-provenance-test-session-key",
    MANIFEST_HASH_KEYS: "test:routing-provenance-test-manifest-key",
    MANIFEST_HASH_ACTIVE_KEY_ID: "test" },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
