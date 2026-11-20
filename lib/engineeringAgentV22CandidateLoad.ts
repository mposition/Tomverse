import "server-only";

import { classifyAmuxExecutionPath } from "@/lib/amux/executionGradeCore";
import { readEngineeringAgentGitBlob,
  readEngineeringAgentPinnedBaseTree } from
  "@/lib/engineeringAgentGitHubRead";
import type { V22TreeChange } from "@/lib/engineeringAgentTreeVerify";
import { applyV22FileDiff, parseV22GitDiff, type V22FileMode } from
  "@/lib/engineeringAgentV22PatchApply";
import { verifyEngineeringAgentV22SparseCandidate } from
  "@/lib/engineeringAgentV22SparseCandidate";

type Base = Awaited<ReturnType<typeof readEngineeringAgentPinnedBaseTree>>;
type Ports = { readBase: (sha: string, onDevelop: boolean) => Promise<Base>;
  readBlob: (oid: string) => Promise<Uint8Array> };
const livePorts: Ports = {
  readBase: (sha, onDevelop) =>
    readEngineeringAgentPinnedBaseTree(sha, {}, { onDevelop }),
  readBlob: (oid) => readEngineeringAgentGitBlob(oid, {}),
};
type VerifiedCandidate = ReturnType<typeof verifyEngineeringAgentV22SparseCandidate>;
type LoadedCandidate =
  (Extract<VerifiedCandidate, { ok: true }> & { baseRootTreeId: string;
    baseTree: Base["base"]; baseCommitterDate: string | null }) |
  Extract<VerifiedCandidate, { ok: false }>;

const FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755", "120000"]);

/**
 * The candidate a stored v22 patch makes: the patch text, rebuilt in memory
 * against the old blobs it names (engineeringAgentV22PatchApply), into the
 * tree the publisher's `git apply --cached` must write. GitHub is pinned to
 * the fixed repository's current develop head (with `onDevelop`, to a commit
 * that head contains); the worker supplies no URL or tree listing. A failure
 * gives no permission to publish.
 *
 * Only the patch text is read. A sidecar that still stores the bytes of up to
 * five changed files beside it (before 2026-11-15) is not trusted for them:
 * the text names everything the publisher applies.
 *
 * A failure is named by a reason this builder alone writes, so a draft an
 * earlier builder kept (`base_blob_missing`, `files_invalid`, ...) can be
 * told apart and judged again (engineeringAgentV22TierPromotion):
 * `patch_unreadable` for text that is not a diff this can rebuild,
 * `path_invalid` for a name no execution path may hold, `base_mismatch` when the base lacks what the patch changes,
 * `patch_mismatch` when it does not apply exactly or yields another blob,
 * `path_conflict` and `secret_detected` from the change set, `tree_invalid`
 * when the listing does not verify. No size is refused: a patch is bounded
 * only by the systems it passes through (owner decision 2026-11-18), and
 * `patch_over_limit`, which a builder before it wrote past 4 MiB, is now only
 * read, as a reason a deploy judges again.
 */
export async function loadEngineeringAgentV22Candidate(input: {
  baseSha: string; onDevelop?: boolean; patchText: string },
ports: Ports = livePorts): Promise<LoadedCandidate> {
  if (!/^[0-9a-f]{40}$/.test(input.baseSha))
    return { ok: false, reason: "patch_unreadable" };
  const diff = parseV22GitDiff(input.patchText);
  if (!diff.ok) return { ok: false, reason: diff.reason };
  if (diff.files.some((file) => [file.oldPath, file.newPath].some((path) =>
    path !== null && classifyAmuxExecutionPath(path) === "invalid")))
    return { ok: false, reason: "path_invalid" };
  const pinned = await ports.readBase(input.baseSha,
    input.onDevelop === true);
  const paths = new Map(pinned.base.map((entry) => [entry.path, entry]));
  const bytes = new Map<string, Uint8Array>();
  const rebuilt: Uint8Array[] = [];
  try {
    for (const file of diff.files) {
      if (file.oldPath === null) continue;
      const previous = paths.get(file.oldPath);
      if (previous?.type !== "blob" || !FILE_MODES.has(previous.mode) ||
          (file.oldMode !== null && previous.mode !== file.oldMode) ||
          (file.oldOid !== null && !previous.oid.startsWith(file.oldOid)))
        return { ok: false, reason: "base_mismatch" };
      if (!bytes.has(previous.oid))
        bytes.set(previous.oid, await ports.readBlob(previous.oid));
    }
    const changes: V22TreeChange[] = [];
    for (const file of diff.files) {
      const previous = file.oldPath === null ? null : paths.get(file.oldPath)!;
      const old = previous ? bytes.get(previous.oid)! : null;
      const next = applyV22FileDiff(old, file);
      if (!next) return { ok: false, reason: "patch_mismatch" };
      if (next !== old) rebuilt.push(next);
      if (file.oldPath !== null && !file.copy && file.newPath !== file.oldPath)
        changes.push({ kind: "delete", path: file.oldPath });
      if (file.newPath !== null)
        changes.push({ kind: "write", path: file.newPath, bytes: next,
          mode: file.newMode ?? (previous!.mode as V22FileMode),
          exists: file.newPath === file.oldPath });
    }
    const verified = verifyEngineeringAgentV22SparseCandidate({
      base: pinned.base, baseRootTreeId: pinned.rootTreeId,
      baseGitattributes: pinned.baseGitattributes,
      changes, baseBlobs: bytes,
    });
    return verified.ok ? { ...verified,
      baseRootTreeId: pinned.rootTreeId, baseTree: pinned.base,
      baseCommitterDate: pinned.baseCommitterDate } : verified;
  } finally {
    for (const value of bytes.values()) value.fill(0);
    for (const value of rebuilt) value.fill(0);
  }
}
