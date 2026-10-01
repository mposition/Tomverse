import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";

import {
  CONNECT_RETRY_COUNT,
  isRetryablePrismaMigrateFailure,
  nextConnectRetryDelayMs,
} from "./direct-database-connect-core.mjs";

/**
 * Runs `prisma migrate deploy`, and runs it again when the only thing that
 * went wrong was reaching the database.
 *
 * The last step of `db:migrate` had no second attempt. On 2026-09-13 the two
 * steps before it reported the database healthy -- the probe connected in 33ms
 * and took and released the migration advisory lock -- and eight seconds later
 * this command exited on `P1001: Can't reach database server`, five seconds
 * after it started, which is how long Prisma waits. The deploy failed with a
 * built image, a healthy database and nothing to fix.
 *
 * Which failures are tried again is decided in
 * `direct-database-connect-core.mjs`, beside the same decision for `pg`, so the
 * two halves of `db:migrate` cannot drift apart. Everything else -- a migration
 * that will not apply, a failed row from an earlier deploy, a wrong URL --
 * fails on the first attempt with its own output intact.
 */

const PRISMA_CLI = resolvePath(
  import.meta.dirname,
  "..",
  "node_modules",
  "prisma",
  "build",
  "index.js"
);

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * One attempt.
 *
 * Output is piped so it can be classified, and written straight back out so a
 * deploy log reads exactly as it did before this wrapper existed.
 */
const runMigrateDeploy = () =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [PRISMA_CLI, "migrate", "deploy"], {
      stdio: ["inherit", "pipe", "pipe"],
    });

    let output = "";
    const capture = (stream, sink) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        output += chunk;
        sink.write(chunk);
      });
    };
    capture(child.stdout, process.stdout);
    capture(child.stderr, process.stderr);

    child.on("error", (error) => {
      // The CLI never started -- a missing install, not a database that is
      // briefly away. `isRetryablePrismaMigrateFailure` names no code in this
      // message, so it stops here rather than trying three more times.
      resolve({ status: 1, output: `${output}${error.message}\n` });
    });
    child.on("close", (code, signal) => {
      resolve({
        status: signal ? 1 : (code ?? 1),
        output: signal ? `${output}terminated by signal ${signal}\n` : output,
      });
    });
  });

let last = { status: 1, output: "" };

for (let attempt = 1; attempt <= CONNECT_RETRY_COUNT; attempt += 1) {
  last = await runMigrateDeploy();
  if (last.status === 0) break;

  const delayMs = isRetryablePrismaMigrateFailure(last.output)
    ? nextConnectRetryDelayMs(attempt)
    : null;
  if (delayMs === null) break;

  console.warn(
    `prisma migrate deploy could not reach the database; retrying in ${
      delayMs / 1_000
    }s (${attempt}/${CONNECT_RETRY_COUNT}).`
  );
  await sleep(delayMs);
}

// Setting the code rather than calling `process.exit`: the CLI's output was
// forwarded to a pipe, and exiting outright can drop whatever of it has not
// been flushed -- which on a failed deploy is the part someone needs to read.
process.exitCode = last.status === 0 ? 0 : last.status || 1;
