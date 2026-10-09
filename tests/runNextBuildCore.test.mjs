import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  TURBOPACK_CACHE_DIR,
  isRecoverableTurbopackCacheFailure,
  nodeOptionsForBuild,
  LARGE_HEAP_FLAG,
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

test("a caller can ask for the same heap off CI without a deploy build getting it", () => {
  // What `npm run build:local` passes: a local build has died in Mark-Compact
  // at the default heap, and the remedy was an environment variable the
  // developer had to know about. It does not reproduce on an idle machine, so
  // this borrows CI's ceiling rather than fixing a deterministic failure.
  assert.equal(nodeOptionsForBuild({}, { largeHeap: true }),
    "--max-old-space-size=6144");
  assert.equal(nodeOptionsForBuild({ NODE_OPTIONS: "--trace-warnings" }, { largeHeap: true }),
    "--trace-warnings --max-old-space-size=6144");
  // An operator's own limit still wins, exactly as it does on CI.
  assert.equal(
    nodeOptionsForBuild({ NODE_OPTIONS: "--max-old-space-size=5120" }, { largeHeap: true }),
    "--max-old-space-size=5120");
  // The reason this is a request rather than "not CI": Railway declares no
  // build command, so it runs this same script. Raising its ceiling would
  // change how a deploy build fails, which a local convenience does not decide.
  assert.equal(nodeOptionsForBuild({ RAILWAY_ENVIRONMENT: "production" }), "");
  assert.equal(nodeOptionsForBuild({ RAILWAY_ENVIRONMENT: "production" }, { largeHeap: false }),
    "");
  // Stripped before the rest are forwarded, so it has to look like a flag.
  assert.match(LARGE_HEAP_FLAG, /^--[a-z-]+$/);
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

/**
 * The same corrupt cache in another form, from Railway deployment 4a96f1cc
 * (staging, develop 1c02353, 2026-10-07T11:41:55Z): a panic in the task
 * backend while reading the persisted store, reported as "Panic in async
 * function" with none of the earlier internal-error markers. The same commit
 * built and deployed on the other services that build it.
 */
const TASK_ID_PANIC = `
▲ Next.js 16.3.8 (Turbopack)
  Creating an optimized production build ...

thread 'tokio-rt-worker' (84) panicked at turbopack/crates/turbo-tasks-backend/src/backend/mod.rs:249:14:
Failed to get task id: Unable to read next free task id from database

Caused by:
    0: Unable to open static sorted file

> Build error occurred
[Error: Panic in async function]
`;

test("a task-backend panic reading the persisted cache is recognised", () => {
  assert.equal(isRecoverableTurbopackCacheFailure(TASK_ID_PANIC), true);
  // The panic site alone, without a cache-read line, is not enough.
  assert.equal(
    isRecoverableTurbopackCacheFailure(
      "thread 'tokio-rt-worker' panicked at turbopack/crates/turbo-tasks-backend/src/backend/mod.rs:10:1:\nindex out of bounds"
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
