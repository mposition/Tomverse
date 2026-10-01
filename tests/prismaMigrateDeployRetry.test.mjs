import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONNECT_RETRY_COUNT,
  RETRYABLE_PRISMA_CONNECT_CODES,
  isRetryablePrismaMigrateFailure,
} from "../scripts/direct-database-connect-core.mjs";

/**
 * The staging deploy of e7e2795 failed on 2026-09-13 with nothing wrong.
 *
 * `db:migrate` runs three commands. The first reported the database healthy --
 * it connected in 33ms and took and released the migration advisory lock --
 * and eight seconds later the third exited on `P1001: Can't reach database
 * server`, five seconds after starting, which is how long Prisma waits to
 * connect. The image was built and pushed, the five sibling services deploying
 * from that commit were unaffected, and the previous release kept serving
 * requests against that same database minutes later.
 *
 * The retry added on 2026-08-24 covered only the first command. These pin the
 * two things that let a blip on the last one cost a deploy: the failure is
 * classified as one worth another attempt, and `db:migrate` runs the wrapper
 * that makes it.
 */

const repoRoot = join(import.meta.dirname, "..");
const read = (path) => readFileSync(join(repoRoot, path), "utf8");

/** The incident's own output, as Railway recorded it. */
const INCIDENT_OUTPUT = [
  'Prisma schema loaded from prisma/schema.prisma.',
  'Datasource "db": PostgreSQL database "postgres", schema "public" at "db.prisma.io:5432"',
  "",
  "Error: P1001: Can't reach database server at `db.prisma.io:5432`",
  "",
  "Please make sure your database server is running at `db.prisma.io:5432`.",
].join("\n");

test("the incident's own output is retried", () => {
  assert.equal(isRetryablePrismaMigrateFailure(INCIDENT_OUTPUT), true);
});

test("every named connection code is retried", () => {
  for (const code of RETRYABLE_PRISMA_CONNECT_CODES) {
    assert.equal(
      isRetryablePrismaMigrateFailure(`Error: ${code}: the database is away`),
      true,
      `${code} should be retried`
    );
  }
});

test("a connection failure that cannot change is not retried", () => {
  // Authentication, a database that is not there, and a role that may not
  // connect fail identically on every attempt.
  for (const code of ["P1000", "P1003", "P1010"]) {
    assert.equal(
      isRetryablePrismaMigrateFailure(`Error: ${code}: nope`),
      false,
      `${code} should fail fast`
    );
  }
});

test("a migration that will not apply is not retried", () => {
  for (const code of ["P3009", "P3018"]) {
    assert.equal(
      isRetryablePrismaMigrateFailure(
        `Error: ${code}: migration \`20260913100000_x\` failed to apply`
      ),
      false,
      `${code} should fail fast`
    );
  }
});

test("a migration error vetoes a connection code in the same output", () => {
  // `migrate deploy` records a failed migration, and every later attempt fails
  // on that row rather than on the connection. Retrying would bury the reason
  // and delay a failure that needs a person.
  assert.equal(
    isRetryablePrismaMigrateFailure(
      `Error: P3009: migrate found a failed migration\nError: P1001: Can't reach database server`
    ),
    false
  );
});

test("an unrecognised failure is not retried", () => {
  // The inverse of the `pg` side, which treats a missing SQLSTATE as evidence
  // of a connection that never reached the server. Here there is only text,
  // and retrying schema changes on a guess is worse than stopping.
  for (const output of ["", "Error: something went wrong", null, undefined]) {
    assert.equal(isRetryablePrismaMigrateFailure(output), false);
  }
});

test("db:migrate runs the wrapper rather than the bare CLI", () => {
  // The tie. `db:migrate` ended in `prisma migrate deploy` with no second
  // attempt while the step before it retried, and nothing said they differed.
  const dbMigrate = JSON.parse(read("package.json")).scripts["db:migrate"];
  assert.ok(dbMigrate, "package.json must declare db:migrate");
  assert.match(dbMigrate, /scripts\/run-prisma-migrate-deploy\.mjs/);
  assert.doesNotMatch(
    dbMigrate,
    /(^|&&|\|\||;)\s*(npx\s+)?prisma\s+migrate\s+deploy/,
    "db:migrate must not call `prisma migrate deploy` without the retry wrapper"
  );
});

test("the wrapper is bounded and uses the shared decision", () => {
  // A parser that stopped matching, or a wrapper that grew its own copy of the
  // rule, would make the assertions above green and the deploy no safer.
  const source = read("scripts/run-prisma-migrate-deploy.mjs");
  assert.match(
    source,
    /import\s*\{[^}]*isRetryablePrismaMigrateFailure[^}]*\}\s*from\s*"\.\/direct-database-connect-core\.mjs"/s,
    "the wrapper must take the decision from the shared module"
  );
  assert.match(source, /CONNECT_RETRY_COUNT/);
  assert.doesNotMatch(
    source.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""),
    /P1\d{3}/,
    "the wrapper must not carry its own copy of the retryable codes"
  );
  assert.ok(
    CONNECT_RETRY_COUNT >= 2 && CONNECT_RETRY_COUNT <= 6,
    `the retry budget must stay inside a pre-deploy step (got ${CONNECT_RETRY_COUNT})`
  );
});

/**
 * The wrapper itself, against a stand-in CLI.
 *
 * The classification above is only half of it: a wrapper that swallowed the
 * exit code, lost the CLI's output, or retried a migration failure would pass
 * every assertion so far and still break every deploy. These run it.
 */

const withStubbedPrismaCli = async (cliSource, run) => {
  const root = await mkdtemp(join(tmpdir(), "prisma-migrate-deploy-"));
  try {
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, "node_modules", "prisma", "build"), {
      recursive: true,
    });
    for (const name of [
      "run-prisma-migrate-deploy.mjs",
      "direct-database-connect-core.mjs",
    ]) {
      await copyFile(
        join(repoRoot, "scripts", name),
        join(root, "scripts", name)
      );
    }
    await writeFile(
      join(root, "node_modules", "prisma", "build", "index.js"),
      cliSource
    );
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const runWrapper = (root) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(root, "scripts", "run-prisma-migrate-deploy.mjs")],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

/** A stand-in CLI that counts its own invocations in `attempts.txt`. */
const countingCli = (body) => `
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const counter = join(import.meta.dirname, "..", "..", "..", "attempts.txt");
appendFileSync(counter, "x");
const attempt = readFileSync(counter, "utf8").length;
${body}
`;

const attemptCount = async (root) =>
  (await readFile(join(root, "attempts.txt"), "utf8")).length;

test("a database that comes back is deployed, not failed", async () => {
  const result = await withStubbedPrismaCli(
    countingCli(`
      if (attempt === 1) {
        process.stderr.write("Error: P1001: Can't reach database server at \\\`db.prisma.io:5432\\\`\\n");
        process.exit(1);
      }
      process.stdout.write("All migrations have been successfully applied.\\n");
      process.exit(0);
    `),
    async (root) => ({ ...(await runWrapper(root)), attempts: await attemptCount(root) })
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.attempts, 2);
  // The CLI's own output still reaches the deploy log, both attempts of it.
  assert.match(result.stderr, /P1001/);
  assert.match(result.stdout, /All migrations have been successfully applied\./);
  assert.match(result.stderr, /retrying in 4s \(1\/4\)/);
});

test("a migration that will not apply fails on the first attempt", async () => {
  const result = await withStubbedPrismaCli(
    countingCli(`
      process.stderr.write("Error: P3009: migrate found a failed migration\\n");
      process.exit(1);
    `),
    async (root) => ({ ...(await runWrapper(root)), attempts: await attemptCount(root) })
  );

  assert.equal(result.status, 1);
  assert.equal(result.attempts, 1, "a failed migration must not be retried");
  assert.match(result.stderr, /P3009/);
  assert.doesNotMatch(result.stderr, /retrying/);
});

test("a successful deploy runs the CLI once", async () => {
  const result = await withStubbedPrismaCli(
    countingCli(`
      process.stdout.write("No pending migrations to apply.\\n");
      process.exit(0);
    `),
    async (root) => ({ ...(await runWrapper(root)), attempts: await attemptCount(root) })
  );

  assert.equal(result.status, 0);
  assert.equal(result.attempts, 1);
});
