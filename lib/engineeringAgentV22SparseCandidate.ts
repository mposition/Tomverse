import { gitObjectId, resultListingFromModifiedBlobs, toPolicyChanges,
  verifyResultListing, type TreeEntry } from
  "@/lib/engineeringAgentTreeVerify";
import type { V22PublishFile } from "@/lib/amux/v22PatchEvidence";
import { V22_CANDIDATE_FILE_LIMITS, checkV22PublishFiles } from
  "@/lib/amux/v22PatchEvidence";

/** A verified change set, not permission to publish. The existing credential,
 * source-slice, policy-named-test and version gates still decide T1/T2.
 * `addedPaths` names the files that are new; every other file must replace
 * an existing `100644` blob. */
export function verifyEngineeringAgentV22SparseCandidate(input: {
  base: readonly TreeEntry[];
  baseRootTreeId: string;
  baseGitattributes: string | null;
  files: readonly V22PublishFile[];
  addedPaths?: ReadonlySet<string>;
  baseBlobs: ReadonlyMap<string, Uint8Array>;
}): { ok: true; expectedTreeId: string;
  changes: Extract<ReturnType<typeof toPolicyChanges>, { ok: true }>["entries"] } |
  { ok: false; reason: string } {
  // Stored file bytes (at most five) and bytes rebuilt from a stored patch
  // pass the same path, text and secret checks, new files included.
  try { checkV22PublishFiles(input.files, V22_CANDIDATE_FILE_LIMITS); }
  catch { return { ok: false, reason: "files_invalid" }; }
  const files = input.files.map((file) => ({ path: file.path,
    mode: file.mode, bytes: Buffer.from(file.bytesBase64, "base64"),
    added: input.addedPaths?.has(file.path) === true }));
  try {
  const sparse = resultListingFromModifiedBlobs({
    base: input.base, baseRootTreeId: input.baseRootTreeId,
    files, maxFiles: V22_CANDIDATE_FILE_LIMITS.maxFiles,
  });
  if (!sparse.ok) return { ok: false, reason: sparse.reason };
  const verified = verifyResultListing({
    base: input.base, baseTruncated: false,
    baseRootTreeId: input.baseRootTreeId,
    result: sparse.result,
    claimedResultRootTreeId: sparse.rootTreeId,
    changedBlobs: sparse.changedBlobs,
    baseGitattributes: input.baseGitattributes,
  });
  if (!verified.ok || verified.unsupported.length > 0)
    return { ok: false, reason: verified.ok ?
      "unsupported_tree_change" : "tree_verification_failed" };
  // A file whose new bytes some other base blob already holds (a copy, a
  // revert) submits no blob, so its own bytes stand in for that base read;
  // toPolicyChanges hashes every piece against its id again.
  const known = new Map(input.baseBlobs);
  for (const file of files) known.set(gitObjectId("blob", file.bytes),
    file.bytes);
  const policy = toPolicyChanges(verified, known);
  if (!policy.ok) return { ok: false, reason: "base_blob_missing" };
  return { ok: true, expectedTreeId: verified.resultRootTreeId,
    changes: policy.entries };
  } finally { for (const file of files) file.bytes.fill(0); }
}
