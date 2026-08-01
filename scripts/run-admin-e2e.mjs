import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Entry point for the Admin Console E2E suite.
 *
 * Order matters: the connection string is validated, then the Prisma schema is
 * pushed, and only then does Playwright start the server. Doing the push here
 * rather than in a Playwright `globalSetup` removes any ambiguity about whether
 * the schema exists before `next start` opens its first connection.
 *
 * ADMIN_E2E_DATABASE_URL (or TEST_DATABASE_URL) must name a disposable
 * PostgreSQL database with a `test`/`ci`/`e2e` marker: the suite truncates
 * every table before each test. See
 * tests/e2e-admin/support/harness-config.ts.
 */

const repoRoot = resolve(import.meta.dirname, "..");

const fail = (message) => {
  console.error(`[admin-e2e] ${message}`);
  process.exit(1);
};

const HARNESS_CONFIG = "../tests/e2e-admin/support/harness-config.ts";

const loadHarnessConfig = async () => {
  try {
    return await import(HARNESS_CONFIG);
  } catch (error) {
    // Only a "node cannot load TypeScript here" failure is retried; anything
    // else is a real problem and must not be hidden by the fallback.
    if (
      error?.code !== "ERR_UNKNOWN_FILE_EXTENSION" &&
      error?.code !== "ERR_MODULE_NOT_FOUND" &&
      !(error instanceof SyntaxError)
    ) {
      throw error;
    }
    const { register } = await import("tsx/esm/api");
    register();
    return import(HARNESS_CONFIG);
  }
};

const { resolveAdminE2EDatabaseUrl } = await loadHarnessConfig();

let databaseUrl;
try {
  databaseUrl = resolveAdminE2EDatabaseUrl(process.env);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const run = (command, args, env, label) => {
  console.log(`[admin-e2e] ${label}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) fail(`${label} failed to start: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(
  process.execPath,
  ["node_modules/prisma/build/index.js", "db", "push"],
  {
    DATABASE_URL: databaseUrl,
    DIRECT_URL: databaseUrl,
    DIRECT_DATABASE_URL: databaseUrl,
  },
  "Synchronizing the Prisma schema into the isolated admin E2E database"
);

run(
  process.execPath,
  [
    "node_modules/@playwright/test/cli.js",
    "test",
    "--config=playwright.admin.config.ts",
    ...process.argv.slice(2),
  ],
  {},
  "Running the Admin Console E2E suite"
);
