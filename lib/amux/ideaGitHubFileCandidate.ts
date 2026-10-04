import type { AmuxOwnedRefSearchLimits } from "./ideaOwnedRefSearchCore.ts";
import { searchAmuxOwnedRefWitness } from "./ideaOwnedRefSearchCore.ts";
import type { AmuxGitHubFileAtCommitResult } from "./ideaGitHubFileAtCommitCore.ts";
import { verifyAmuxGitHubFileAtCommit } from "./ideaGitHubFileAtCommitCore.ts";
import {
  AmuxIdeaGitHubReadError,
  createAmuxIdeaGitHubRefReader,
  type AmuxIdeaGitHubRefAdapterConfig,
} from "./ideaGitHubRefReadAdapter.ts";

type VerifiedFile = Extract<AmuxGitHubFileAtCommitResult, { status: "verified_file" }>;

/**
 * Read-only composition of a repository-owned commit witness and exact file
 * bytes. This is an UNSCANNED candidate, not a model-transfer preview or an
 * authorization. Callers must separately scan/minimize the text, bind a
 * displayed preview to a one-time owner decision, then re-collect immediately
 * before the irreversible send. Never log or audit `file.text`.
 */
export type AmuxGitHubFileCandidateResult =
  | {
      status: "unscanned_candidate";
      inspectedRefs: number;
      witness: {
        repositoryId: number;
        name: string;
        protected: boolean | null;
        refObjectSha: string;
        refCommitSha: string;
      };
      file: VerifiedFile;
    }
  | { status: "hold" | "reject"; reason: string; inspectedRefs: number };

export async function collectAmuxGitHubFileCandidate(
  config: AmuxIdeaGitHubRefAdapterConfig,
  targetCommitSha: string,
  path: string,
  limits: AmuxOwnedRefSearchLimits,
): Promise<AmuxGitHubFileCandidateResult> {
  let inspectedRefs = 0;
  const hold = (reason: string): AmuxGitHubFileCandidateResult =>
    ({ status: "hold", reason, inspectedRefs });
  try {
    const reader = createAmuxIdeaGitHubRefReader(config);
    const expectedRepositoryId = config.expectedRepositoryId;
    await reader.readRepositoryIdentity();

    // A commit object returned by GitHub may belong only to a fork network.
    // Never read a file until the exact target commit has an owned-ref witness.
    const source = await searchAmuxOwnedRefWitness(
      expectedRepositoryId, targetCommitSha, limits, reader.adapter,
    );
    inspectedRefs = source.inspectedRefs;
    if (source.status !== "verified_witness") return hold(source.reason);

    const file = await verifyAmuxGitHubFileAtCommit(
      expectedRepositoryId, targetCommitSha, path, reader.fileAdapter,
    );
    if (file.status === "hold") return hold(file.reason);
    if (file.status === "reject") return { status: "reject", reason: file.reason, inspectedRefs };

    // Search re-read its witness before the file walk; close that intervening
    // race too. A moved/deleted ref requires a new collection and preview.
    const current = await reader.adapter.readRef(source.witness.name);
    if (!current || current.repositoryId !== expectedRepositoryId ||
        current.name !== source.witness.name ||
        current.objectSha !== source.witness.refObjectSha) return hold("ref_changed");
    await reader.readRepositoryIdentity();

    return {
      status: "unscanned_candidate",
      inspectedRefs,
      witness: source.witness,
      file,
    };
  } catch (error) {
    return hold(error instanceof AmuxIdeaGitHubReadError ? error.code : "collector_unavailable");
  }
}
