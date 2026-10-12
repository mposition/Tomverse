import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  TURBOPACK_CACHE_DIR,
  isRecoverableTurbopackCacheFailure,
  nodeOptionsForBuild,
} from "../scripts/run-next-build-core.mjs";

test("GitHub build has a bounded larger heap without overriding an explicit operator limit", () => {
  assert.equal(nodeOptionsForBuild({}), "");
  assert.equal(nodeOptionsForBuild({ GITHUB_ACTIONS: "1" }), "");
  assert.equal(nodeOptionsForBuild({ GITHUB_ACTIONS: "true" }),
    "--max-old-space-size=6144");
  assert.equal(nodeOptionsForBuild({ GITHUB_ACTIONS: "true",
    NODE_OPTIONS: "--trace-warnings" }),
  "--trace-warnings --max-old-space-size=6144");
  for (const explicit of ["--max-old-space-size=5120", "--max_old_space_size=5120"]) {
    assert.equal(nodeOptionsForBuild({ GITHUB_ACTIONS: "true", NODE_OPTIONS: explicit }),
      explicit);
  }
});

/**
 * The failure this guard exists for, copied from Railway deployment 0d227e99
 * (production, main d031bf3, 2026-08-24T00:26:59Z). The commit was a list of
 * model ids and its tests; the build died because the Turbopack cache Railway
 * restored referenced a segment that was not in it.
 */
const CACHE_RESTORE_FAILURE = `
> ai-chat-hub@0.1.0 build
> next build

▲ Next.js 16.3.1 (Turbopack)
  Creating an optimized production build ...

thread 'tokio-rt-worker' (85) panicked at turbopack/crates/turbo-tasks-backend/src/backend/operation/mod.rs:721:25:
Failed to restore data for task TaskId 1: Failed to restore Data for TaskId 1

Caused by:
    0: Looking up task storage for TaskId 1 from database failed
    1: Unable to open static sorted file referenced from 00000062.meta
    2: failed to open file \`/app/.next/cache/turbopack/v16.3.1-3d32eb87/00000057.sst\`: No such file or directory (os error 2)

FATAL: An unexpected Turbopack error occurred:
Failed to restore data for task TaskId 1: Failed to restore Data for TaskId 1

> Build error occurred
Error [TurbopackInternalError]: Failed to restore data for task TaskId 1
`;

test("the production cache-restore failure is recognised", () => {
  assert.equal(isRecoverableTurbopackCacheFailure(CACHE_RESTORE_FAILURE), true);
});

// Next.js 16.3.8 aborts outside the per-task panic boundary instead of emitting
// TurbopackInternalError. Observed on Railway staging d9efa670, 2026-10-11.
const PANIC_BOUNDARY_CACHE_FAILURE = `
thread 'tokio-rt-worker' (105) panicked at turbopack/crates/turbo-tasks-backend/src/backend/operation/mod.rs:551:13:
Restore failures:
Failed to restore data for task TaskId 4: Batch data restore failed: Failed to restore Data for batch of 3 tasks
Caused by:
    0: Looking up typed data for 3 tasks from database failed
    1: Unable to open static sorted file referenced from 00003182.meta
    2: failed to open file \`/app/.next/cache/turbopack/v16.3.8-b0fad0d4/00003173.sst\`: No such file or directory (os error 2)
turbo-tasks: an internal panic occurred outside the per-task panic boundary. This is a bug in turbo-tasks/Turbopack
Aborting.
`;

test("the panic-boundary cache restore failure is recognised", () => {
  assert.equal(isRecoverableTurbopackCacheFailure(PANIC_BOUNDARY_CACHE_FAILURE), true);
});

test("the panic-boundary marker does not retry unrelated failures", () => {
  const marker = "This is a bug in turbo-tasks/Turbopack";
  assert.equal(isRecoverableTurbopackCacheFailure(marker), false);
  assert.equal(isRecoverableTurbopackCacheFailure(`${marker}\nUnexpected task execution failure`), false);
  assert.equal(isRecoverableTurbopackCacheFailure(
    PANIC_BOUNDARY_CACHE_FAILURE.replace(marker, "An unrelated process panicked")), false);
});

// Production, Railway deployment 40fda894 (main f08502b3e), 2026-10-12: only
// the other threads' panics reached the log, each naming the failed restore,
// then the abort. Shortened from twenty-odd identical thread lines.
const OTHER_THREAD_RESTORE_FAILURE = `
  Creating an optimized production build ...

thread 'tokio-rt-worker' (90) panicked at turbopack/crates/turbo-tasks-backend/src/backend/operation/mod.rs:292:17:
Restore of All for task TaskId 4560720 failed in another thread: restoring failed
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace

thread 'tokio-rt-worker' (87) panicked at turbopack/crates/turbo-tasks-backend/src/backend/operation/mod.rs:292:17:
Restore of All for task TaskId 4547133 failed in another thread: restoring failed

turbo-tasks: an internal panic occurred outside the per-task panic boundary. This is a bug in turbo-tasks/Turbopack — please report it at https://github.com/vercel/next.js/discussions and include the panic message and stack trace above.

Aborting.
[build] next build terminated by signal SIGABRT.
`;

test("a restore that failed in another thread is recognised", () => {
  assert.equal(isRecoverableTurbopackCacheFailure(OTHER_THREAD_RESTORE_FAILURE), true);
});

test("the other-thread restore line alone is not enough", () => {
  assert.equal(
    isRecoverableTurbopackCacheFailure(
      "Restore of All for task TaskId 1 failed in another thread: restoring failed"
    ),
    false
  );
});

// A wrapper that retried on anything would hide real breakage and take twice
// as long to report it. These are the failures that must still exit on the
// first attempt.
test("ordinary build failures are not retried", () => {
  const notRecoverable = [
    "",
    "Failed to compile.\n./app/page.tsx:3:1\nType error: Property 'x' does not exist.",
    "> Build error occurred\nError: Export encountered errors on /pricing",
    "npm error code 1\nnpm error path /app/node_modules/@prisma/engines\nnpm error Error: aborted\nnpm error code: 'ECONNRESET'",
    "Error: connect ECONNREFUSED 127.0.0.1:5432",
    "TypeError: Cannot read properties of undefined (reading 'map')",
  ];
  for (const output of notRecoverable) {
    assert.equal(
      isRecoverableTurbopackCacheFailure(output),
      false,
      output.slice(0, 60)
    );
  }
});

// Both halves of the signature are required: an internal Turbopack error that
// a cold cache would not fix must not be retried, and a bare missing-file line
// is ordinary output.
test("neither half of the signature is enough on its own", () => {
  assert.equal(
    isRecoverableTurbopackCacheFailure(
      "Error [TurbopackInternalError]: Something else went wrong entirely"
    ),
    false
  );
  assert.equal(
    isRecoverableTurbopackCacheFailure(
      "Unable to open static sorted file referenced from 00000062.meta"
    ),
    false
  );
});

test("non-string input is refused rather than coerced", () => {
  for (const value of [undefined, null, 0, {}, []]) {
    assert.equal(isRecoverableTurbopackCacheFailure(value), false);
  }
});

// The wrapper deletes this path, so a rename in one file and not the other
// would silently stop the recovery from recovering anything.
test("the wrapper deletes the directory the error names", () => {
  assert.equal(TURBOPACK_CACHE_DIR, ".next/cache/turbopack");
  assert.ok(CACHE_RESTORE_FAILURE.includes(`/app/${TURBOPACK_CACHE_DIR}/`));

  const wrapper = readFileSync(
    new URL("../scripts/run-next-build.mjs", import.meta.url),
    "utf8"
  );
  assert.match(wrapper, /TURBOPACK_CACHE_DIR/);
  // The retry must be bounded. Two build invocations, no loop.
  assert.equal((wrapper.match(/await runBuild\(\)/g) ?? []).length, 2);
  assert.doesNotMatch(wrapper, /while\s*\(/);
});
