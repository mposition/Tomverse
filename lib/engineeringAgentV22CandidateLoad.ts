import "server-only";

import { isCanonicalRepoPath } from "@/lib/agentAuthorityFiles";
import { PUSH_LIMITS } from "@/lib/agentPushPolicy";
import type { V22PublishFile } from "@/lib/amux/v22PatchEvidence";
import { readEngineeringAgentGitBlob,
  readEngineeringAgentPinnedBaseTree } from
  "@/lib/engineeringAgentGitHubRead";
import { verifyEngineeringAgentV22SparseCandidate } from
  "@/lib/engineeringAgentV22SparseCandidate";

type Base = Awaited<ReturnType<typeof readEngineeringAgentPinnedBaseTree>>;
type Ports = { readBase: (sha: string) => Promise<Base>;
  readBlob: (oid: string) => Promise<Uint8Array> };
const livePorts: Ports = {
  readBase: readEngineeringAgentPinnedBaseTree,
  readBlob: (oid) => readEngineeringAgentGitBlob(oid),
};
type VerifiedCandidate = ReturnType<typeof verifyEngineeringAgentV22SparseCandidate>;
type LoadedCandidate =
  (Extract<VerifiedCandidate, { ok: true }> & { baseRootTreeId: string;
    baseTree: Base["base"]; baseCommitterDate: string | null }) |
  Extract<VerifiedCandidate, { ok: false }>;

/** Read only the old blobs named by a sparse v22 patch. GitHub is pinned to
 * the fixed repository's current develop head; the worker supplies no URL or
 * tree listing. A failure gives no permission to publish. */
export async function loadEngineeringAgentV22Candidate(input: {
  baseSha: string; files: readonly V22PublishFile[];
}, ports: Ports = livePorts): Promise<LoadedCandidate> {
  if (!/^[0-9a-f]{40}$/.test(input.baseSha) ||
      input.files.length < 1 || input.files.length > PUSH_LIMITS.maxFiles ||
      input.files.some((file) => !isCanonicalRepoPath(file.path) ||
        file.mode !== "100644"))
    return { ok: false, reason: "files_invalid" };
  const pinned = await ports.readBase(input.baseSha);
  const paths = new Map(pinned.base.map((entry) => [entry.path, entry]));
  const bytes = new Map<string, Uint8Array>();
  try {
    for (const file of input.files) {
      const previous = paths.get(file.path);
      if (previous?.type !== "blob" || previous.mode !== "100644")
        return { ok: false, reason: "base_blob_missing" };
      if (!bytes.has(previous.oid))
        bytes.set(previous.oid, await ports.readBlob(previous.oid));
    }
    const verified = verifyEngineeringAgentV22SparseCandidate({
      base: pinned.base, baseRootTreeId: pinned.rootTreeId,
      baseGitattributes: pinned.baseGitattributes,
      files: input.files, baseBlobs: bytes,
    });
    return verified.ok ? { ...verified,
      baseRootTreeId: pinned.rootTreeId, baseTree: pinned.base,
      baseCommitterDate: pinned.baseCommitterDate } : verified;
  } finally { for (const value of bytes.values()) value.fill(0); }
}
