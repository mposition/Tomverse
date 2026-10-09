/**
 * Is this build failure a corrupt Turbopack persistent cache, and nothing else?
 *
 * Railway restores `.next/cache` between builds so Turbopack can resume. On
 * 2026-08-24 the restored cache for `main` was internally inconsistent -- a
 * `.meta` file referenced a `.sst` segment that was not in the restored tree --
 * and Turbopack panicked rather than falling back to a cold build:
 *
 *     FATAL: An unexpected Turbopack error occurred:
 *     Failed to restore data for task TaskId 1
 *       Caused by:
 *         1: Unable to open static sorted file referenced from 00000062.meta
 *         2: failed to open file `/app/.next/cache/turbopack/v16.3.1-.../00000057.sst`:
 *            No such file or directory (os error 2)
 *
 * The deployment failed with an exit code that says nothing about the cache,
 * on a commit whose diff was a list of model ids and its tests. The cache is
 * a derived artefact: the correct response to one that cannot be read is to
 * throw it away, not to fail the release.
 *
 * ## Why this is narrow on purpose
 *
 * A build wrapper that retried on *any* failure would hide real breakage and
 * double the time it takes to learn about it. This matches the cache-restore
 * signature and nothing else, so a type error, a failed prerender or a lint
 * failure exits on the first attempt exactly as before. The retry also runs
 * at most once: a corrupt cache is deleted before it, so a second identical
 * failure is no longer about the cache and must be surfaced.
 *
 * Both markers are required. `TurbopackInternalError` alone covers unrelated
 * internal errors that a cold cache would not fix, and the file-not-found
 * line alone could appear in ordinary application output.
 */

/** The directory a failed restore makes unusable, relative to the repo root. */
export const TURBOPACK_CACHE_DIR = ".next/cache/turbopack";

/**
 * The build's child workers must inherit the CI type-check heap limit.
 *
 * `largeHeap` asks for that same limit off CI, which is what `npm run
 * build:local` does. A local build has died in Mark-Compact at the default heap
 * (2026-10-07), and the remedy was an environment variable the developer had to
 * know about; it does not reproduce on an otherwise idle machine at this tree,
 * so treat this as the one-command way to borrow CI's ceiling rather than as a
 * fix for a deterministic failure.
 *
 * It is a caller's request rather than "anything that is not CI" because
 * Railway declares no build command and runs this very script, and raising the
 * ceiling there would change how a deploy build fails -- a container limit
 * reached instead of V8 refusing -- which is not a local convenience's call.
 */
export const nodeOptionsForBuild = (env, { largeHeap = false } = {}) => {
  const configured = env.NODE_OPTIONS ?? "";
  if ((env.GITHUB_ACTIONS !== "true" && !largeHeap) ||
      /--max[-_]old[-_]space[-_]size(?:=|\s)/.test(configured)) return configured;
  return `${configured ? `${configured} ` : ""}--max-old-space-size=6144`;
};

/**
 * Taken out of the arguments before the rest are forwarded: everything else
 * goes to `next build`, which would reject a flag of ours.
 */
export const LARGE_HEAP_FLAG = "--large-heap";

const INTERNAL_ERROR_MARKERS = [
  "TurbopackInternalError",
  "An unexpected Turbopack error occurred",
  // 2026-10-07 (staging, develop 1c02353): the same corrupt cache surfaced as a
  // panic in Turbopack's task backend, reported only as "Panic in async
  // function", with neither marker above. The panic site is the persisted task
  // store, which is what a cold cache replaces.
  "panicked at turbopack/crates/turbo-tasks-backend/",
];

const CACHE_RESTORE_MARKERS = [
  "Failed to restore data for task",
  "Failed to restore Data for TaskId",
  "Looking up task storage for TaskId",
  "Unable to open static sorted file referenced from",
  "Unable to read next free task id from database",
];

/**
 * True only when the output shows Turbopack failing to read its own persisted
 * cache. `output` is the build's combined stdout and stderr.
 */
export const isRecoverableTurbopackCacheFailure = (output) => {
  if (typeof output !== "string" || output.length === 0) return false;
  const internal = INTERNAL_ERROR_MARKERS.some((marker) =>
    output.includes(marker)
  );
  if (!internal) return false;
  return CACHE_RESTORE_MARKERS.some((marker) => output.includes(marker));
};
