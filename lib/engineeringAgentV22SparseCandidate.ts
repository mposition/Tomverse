import { detectSecrets } from "@/lib/engineeringAgentSecretPatterns";
import { gitObjectId, resultListingFromChanges, toPolicyChanges,
  verifyResultListing, type TreeEntry, type V22TreeChange } from
  "@/lib/engineeringAgentTreeVerify";

type Verified = Extract<ReturnType<typeof verifyResultListing>, { ok: true }>;

const utf8 = new TextDecoder("utf-8", { fatal: true });
const latin1 = new TextDecoder("latin1");

/** Text as the secret patterns read it: UTF-8, or byte for byte when the
 * file is not text, so a token inside a binary file is still seen. */
const scannable = (bytes: Uint8Array) => {
  try { return utf8.decode(bytes); } catch { return latin1.decode(bytes); }
};

/** A verified change set, not permission to publish. The existing credential,
 * source-slice, policy-named-test and version gates still decide T1/T2, and
 * what tree verification does not support (`unsupported`) is a T2 finding
 * for that gate. A file whose new bytes carry a secret is refused outright:
 * a T2 patch can still become a public draft pull request. */
export function verifyEngineeringAgentV22SparseCandidate(input: {
  base: readonly TreeEntry[];
  baseRootTreeId: string;
  baseGitattributes: string | null;
  changes: readonly V22TreeChange[];
  baseBlobs: ReadonlyMap<string, Uint8Array>;
}): { ok: true; expectedTreeId: string;
  changes: Extract<ReturnType<typeof toPolicyChanges>, { ok: true }>["entries"];
  unsupported: Verified["unsupported"] } |
  { ok: false; reason: string } {
  for (const change of input.changes)
    if (change.kind === "write" && detectSecrets(scannable(change.bytes)).length)
      return { ok: false, reason: "secret_detected" };
  const sparse = resultListingFromChanges({
    base: input.base, baseRootTreeId: input.baseRootTreeId,
    changes: input.changes,
  });
  if (!sparse.ok) return { ok: false, reason: sparse.reason === "path_conflict" ?
    "path_conflict" : sparse.reason === "files_invalid" ? "base_mismatch" :
      "tree_invalid" };
  const verified = verifyResultListing({
    base: input.base, baseTruncated: false,
    baseRootTreeId: input.baseRootTreeId,
    result: sparse.result,
    claimedResultRootTreeId: sparse.rootTreeId,
    changedBlobs: sparse.changedBlobs,
    baseGitattributes: input.baseGitattributes,
  });
  if (!verified.ok) return { ok: false, reason: "tree_invalid" };
  // A file whose new bytes some other base blob already holds (a copy, a
  // revert) submits no blob, so its own bytes stand in for that base read;
  // toPolicyChanges hashes every piece against its id again.
  const known = new Map(input.baseBlobs);
  for (const change of input.changes)
    if (change.kind === "write")
      known.set(gitObjectId("blob", change.bytes), change.bytes);
  const policy = toPolicyChanges(verified, known);
  if (!policy.ok) return { ok: false, reason: "base_mismatch" };
  return { ok: true, expectedTreeId: verified.resultRootTreeId,
    changes: policy.entries, unsupported: verified.unsupported };
}
