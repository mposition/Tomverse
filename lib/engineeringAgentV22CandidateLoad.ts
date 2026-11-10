import "server-only";

import { isCanonicalRepoPath } from "@/lib/agentAuthorityFiles";
import { classifyAmuxExecutionPath } from "@/lib/amux/executionGradeCore";
import { V22_CANDIDATE_FILE_LIMITS, type V22PublishFile } from
  "@/lib/amux/v22PatchEvidence";
import { readEngineeringAgentGitBlob,
  readEngineeringAgentPinnedBaseTree } from
  "@/lib/engineeringAgentGitHubRead";
import { applyV22FileDiff, parseV22GitDiff } from
  "@/lib/engineeringAgentV22PatchApply";
import { verifyEngineeringAgentV22SparseCandidate } from
  "@/lib/engineeringAgentV22SparseCandidate";

type Base = Awaited<ReturnType<typeof readEngineeringAgentPinnedBaseTree>>;
type Ports = { readBase: (sha: string, onDevelop: boolean) => Promise<Base>;
  readBlob: (oid: string) => Promise<Uint8Array> };
const livePorts: Ports = {
  readBase: (sha, onDevelop) =>
    readEngineeringAgentPinnedBaseTree(sha, {}, { onDevelop }),
  readBlob: (oid) => readEngineeringAgentGitBlob(oid,
    {}, V22_CANDIDATE_FILE_LIMITS.maxFileBytes),
};
type VerifiedCandidate = ReturnType<typeof verifyEngineeringAgentV22SparseCandidate>;
type LoadedCandidate =
  (Extract<VerifiedCandidate, { ok: true }> & { baseRootTreeId: string;
    baseTree: Base["base"]; baseCommitterDate: string | null }) |
  Extract<VerifiedCandidate, { ok: false }>;

const validFiles = (files: readonly V22PublishFile[]) =>
  files.length >= 1 && files.length <= V22_CANDIDATE_FILE_LIMITS.maxFiles &&
  files.every((file) => isCanonicalRepoPath(file.path) &&
    file.mode === "100644");

/** Read only the old blobs named by a sparse v22 patch. GitHub is pinned to
 * the fixed repository's current develop head (with `onDevelop`, to a commit
 * that head contains); the worker supplies no URL or tree listing. A failure
 * gives no permission to publish.
 *
 * A stored patch whose evidence carries no file bytes (more files or bytes
 * than the sidecar keeps) names its files by `patchText` instead: each one's
 * new bytes are rebuilt from its pinned base blob by an exact in-memory
 * application, and must hash to the blob id the patch itself names. Only
 * modified `100644` text files qualify, as with stored file bytes. */
export async function loadEngineeringAgentV22Candidate(input: {
  baseSha: string; onDevelop?: boolean } & (
    { files: readonly V22PublishFile[]; patchText?: undefined } |
    { files?: undefined; patchText: string }),
ports: Ports = livePorts): Promise<LoadedCandidate> {
  if (!/^[0-9a-f]{40}$/.test(input.baseSha))
    return { ok: false, reason: "files_invalid" };
  const diff = input.files ? null : parseV22GitDiff(input.patchText ?? "");
  if (diff && (!diff.ok || diff.files.length >
      V22_CANDIDATE_FILE_LIMITS.maxFiles ||
      diff.files.some((file) =>
        classifyAmuxExecutionPath(file.path) === "invalid")))
    return { ok: false, reason: "patch_unsupported" };
  if (input.files && !validFiles(input.files))
    return { ok: false, reason: "files_invalid" };
  const pinned = await ports.readBase(input.baseSha,
    input.onDevelop === true);
  const paths = new Map(pinned.base.map((entry) => [entry.path, entry]));
  const bytes = new Map<string, Uint8Array>();
  const rebuilt: Uint8Array[] = [];
  try {
    const named = input.files ?? (diff?.ok ? diff.files : []);
    for (const file of named) {
      const previous = paths.get(file.path);
      if (previous?.type !== "blob" || previous.mode !== "100644" ||
          ("oldOid" in file && !previous.oid.startsWith(file.oldOid)))
        return { ok: false, reason: "base_blob_missing" };
      if (!bytes.has(previous.oid))
        bytes.set(previous.oid, await ports.readBlob(previous.oid));
    }
    let files = input.files;
    if (!files && diff?.ok) {
      const built: V22PublishFile[] = [];
      for (const file of diff.files) {
        const next = applyV22FileDiff(bytes.get(paths.get(file.path)!.oid)!,
          file);
        if (!next) return { ok: false, reason: "patch_does_not_apply" };
        rebuilt.push(next);
        built.push({ path: file.path, mode: "100644",
          bytesBase64: Buffer.from(next).toString("base64") });
      }
      files = built;
    }
    if (!files) return { ok: false, reason: "files_invalid" };
    const verified = verifyEngineeringAgentV22SparseCandidate({
      base: pinned.base, baseRootTreeId: pinned.rootTreeId,
      baseGitattributes: pinned.baseGitattributes,
      files, baseBlobs: bytes,
    });
    return verified.ok ? { ...verified,
      baseRootTreeId: pinned.rootTreeId, baseTree: pinned.base,
      baseCommitterDate: pinned.baseCommitterDate } : verified;
  } finally {
    for (const value of bytes.values()) value.fill(0);
    for (const value of rebuilt) value.fill(0);
  }
}
