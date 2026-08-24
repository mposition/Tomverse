import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  TURBOPACK_CACHE_DIR,
  isRecoverableTurbopackCacheFailure,
} from "../scripts/run-next-build-core.mjs";

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
