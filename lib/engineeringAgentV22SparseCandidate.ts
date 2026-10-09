import { resultListingFromModifiedBlobs, toPolicyChanges,
  verifyResultListing, type TreeEntry } from
  "@/lib/engineeringAgentTreeVerify";
import type { V22PublishFile } from "@/lib/amux/v22PatchEvidence";
import { encodeV22PatchEvidence } from "@/lib/amux/v22PatchEvidence";

/** A verified change set, not permission to publish. The existing credential,
 * source-slice, policy-named-test and version gates still decide T1/T2. */
export function verifyEngineeringAgentV22SparseCandidate(input: {
  base: readonly TreeEntry[];
  baseRootTreeId: string;
  baseGitattributes: string | null;
  files: readonly V22PublishFile[];
  baseBlobs: ReadonlyMap<string, Uint8Array>;
}): { ok: true; expectedTreeId: string;
  changes: Extract<ReturnType<typeof toPolicyChanges>, { ok: true }>["entries"] } |
  { ok: false; reason: string } {
  let guarded: Buffer;
  try { guarded = encodeV22PatchEvidence("diff --git a/x b/x\n",
    input.files); }
  catch { return { ok: false, reason: "files_invalid" }; }
  guarded.fill(0);
  const files = input.files.map((file) => ({ path: file.path,
    mode: file.mode, bytes: Buffer.from(file.bytesBase64, "base64") }));
  try {
  const sparse = resultListingFromModifiedBlobs({
    base: input.base, baseRootTreeId: input.baseRootTreeId,
    files,
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
  const policy = toPolicyChanges(verified, input.baseBlobs);
  if (!policy.ok) return { ok: false, reason: "base_blob_missing" };
  return { ok: true, expectedTreeId: verified.resultRootTreeId,
    changes: policy.entries };
  } finally { for (const file of files) file.bytes.fill(0); }
}
