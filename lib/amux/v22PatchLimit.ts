/**
 * What is left of the size bounds on a v22 Task's patch (owner decisions
 * 2026-11-15 and 2026-11-18, docs/policy/amux-v22-result-transfer.md): no
 * bound of our own on a run's result, patch or changed-path list. A result
 * travels to the app in fixed-size chunks (lib/amux/v22TransferCore.ts), so
 * what one request carries no longer bounds what a run may change. What
 * remains is an external system's limit, or the old inline path's:
 *
 * - A file: GitHub refuses a pushed file over 100 MiB, and its blob API
 *   serves blobs up to that size. A file the patch changes, adds or keeps is
 *   read and rebuilt up to this.
 * - The inline path: a bridge or sidecar from before the chunked transfer
 *   sends the patch inside the result request, which Next.js buffers through
 *   `proxy.ts` up to 10 MiB. Its numbers stay for that path, for the stored
 *   JSON (files) evidence of a sidecar before 2026-11-15, and for a publisher
 *   that has not said it reads patch chunks.
 *
 * The box sidecar and the Rust bridge
 * (apps/tomverse-orchestrator/src/wsl_bridge.rs, tomverse_api.rs) carry the
 * same numbers; tests/amuxV22PatchLimit.test.mjs keeps them equal.
 */
export const AMUX_V22_FILE_MAX_BYTES = 100 * 1024 * 1024;

/**
 * One git step of the worker's checkout (fetch, diff, add, status). A wedge
 * guard for a stuck lock or a dead filesystem, not a work limit: a step on a
 * large checkout takes minutes, and one that fails here loses the run's
 * change.
 */
export const AMUX_V22_GIT_STEP_TIMEOUT_MS = 2 * 60 * 60_000;

/**
 * The most an inline patch carries: the old result request, the JSON (files)
 * evidence a sidecar before 2026-11-15 stored, and the claim of a publisher
 * that reads no patch chunks. Not a bound on a patch: a chunked transfer
 * stores any size.
 */
export const AMUX_V22_LEGACY_INLINE_PATCH_MAX_BYTES = 4 * 1024 * 1024;

/**
 * An old inline JSON body carrying one patch with its Task result: the
 * escaped patch (at most twice its bytes) and one MiB for the result and the
 * envelope, under the 10 MiB proxy buffer.
 */
export const AMUX_V22_LEGACY_PATCH_ENVELOPE_MAX_BYTES =
  2 * AMUX_V22_LEGACY_INLINE_PATCH_MAX_BYTES + 1024 * 1024;

/**
 * @deprecated The one patch bound before the chunked transfer. Kept only
 * while the sidecar (lib/amux/v22PatchCapture.mjs, v22OneShotSidecar.mjs) and
 * the engineering agent (lib/engineeringAgentStore.ts,
 * lib/engineeringAgentV22CandidateLoad.ts) still import it; their own changes
 * remove those imports. New code uses AMUX_V22_LEGACY_INLINE_PATCH_MAX_BYTES.
 */
export const AMUX_V22_PATCH_MAX_BYTES = AMUX_V22_LEGACY_INLINE_PATCH_MAX_BYTES;

/**
 * @deprecated The changed-path JSON bound before the chunked transfer; kept
 * only while lib/amux/v22PatchCapture.mjs still imports it.
 */
export const AMUX_V22_CHANGED_PATHS_JSON_MAX_BYTES = AMUX_V22_LEGACY_INLINE_PATCH_MAX_BYTES;
