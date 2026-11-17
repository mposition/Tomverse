/**
 * The size bounds on a v22 Task's patch, from the worker's checkout to the
 * pull request (owner decision 2026-11-15: no size or count limit of our own
 * on what a patch may change, only the limits of the systems it passes
 * through). Each is that system's, so nothing under it is refused for size:
 *
 * - A file: GitHub refuses a pushed file over 100 MiB, and its blob API
 *   serves blobs up to that size. A file the patch changes, adds or keeps is
 *   read and rebuilt up to this.
 * - The patch: it reaches the app in the settlement request, and Next.js
 *   buffers a request body that passes `proxy.ts` (every route) up to 10 MB
 *   (`experimental.proxyClientMaxBodySize`, left at its default; raising it
 *   would let any public route buffer more). JSON writes a newline, tab,
 *   quote or backslash as two bytes, so the escaped patch is at most twice
 *   its size, and the Task result (64 KiB) rides with it.
 *
 * The tier gate's T1 limits (`PUSH_LIMITS`) are not size limits on the patch:
 * past them a change is still a candidate, judged T2 for a person.
 *
 * The box sidecar and the Rust bridge
 * (apps/tomverse-orchestrator/src/wsl_bridge.rs, tomverse_api.rs) carry the
 * same numbers; tests/amuxV22PatchLimit.test.mjs keeps them equal.
 */
export const AMUX_V22_FILE_MAX_BYTES = 100 * 1024 * 1024;

export const AMUX_V22_PATCH_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The changed-path inventory rides in the settlement body beside the receipt
 * echo, so it is bound by the same proxy buffer as a patch and nothing
 * smaller: a run that changed tens of thousands of files still reports them.
 */
export const AMUX_V22_CHANGED_PATHS_JSON_MAX_BYTES = AMUX_V22_PATCH_MAX_BYTES;

/**
 * One git step of the worker's checkout (fetch, diff, add, status). A wedge
 * guard for a stuck lock or a dead filesystem, not a work limit: a step on a
 * large checkout takes minutes, and one that fails here loses the run's
 * change.
 */
export const AMUX_V22_GIT_STEP_TIMEOUT_MS = 2 * 60 * 60_000;

/**
 * A JSON body carrying one patch with its Task result: the escaped patch
 * (the sidecar keeps it within twice the patch bound) and one MiB for the
 * result and the envelope, under the 10 MB proxy buffer.
 */
export const AMUX_V22_PATCH_ENVELOPE_MAX_BYTES =
  2 * AMUX_V22_PATCH_MAX_BYTES + 1024 * 1024;
