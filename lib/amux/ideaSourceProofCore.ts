import { createHash } from "node:crypto";

import type { IdeaSourceFile } from "./ideaSourceScopeCore.ts";

/** Consistency checks for observations made by a separate read-only GitHub
 * collector. These records are not attestations: a model or caller can forge
 * them. The collector must bind a stable repository ID, observation freshness,
 * a complete PR changed-file list and owned-ref reachability independently;
 * LFS pointers are checked as pointer bytes, not dereferenced content. Never
 * use this without a trusted collector, owner approval, provenance audit, a
 * fresh preview and the external-transfer guard. */
export const AMUX_SOURCE_FILE_MAX_BYTES = 64 * 1024;
const REGULAR_MODES = new Set(["100644", "100755"]);
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

type BlobObservation = {
  repository: string;
  path: string;
  fetchedCommitSha: string;
  objectType: string;
  objectMode: string;
  blobSha: string;
  bytes: Buffer;
};

type RepositoryProof = BlobObservation & {
  kind: "repository_file";
  reachableFromRepositoryOwnedRef: boolean;
};

type PullRequestProof = BlobObservation & {
  kind: "pull_request_file";
  number: number;
  currentBaseSha: string;
  currentHeadSha: string;
  baseRepository: string;
  headRepository: string;
  completeChangedFileList: boolean;
  changedPaths: string[];
};

export type SourceCollectionProof = RepositoryProof | PullRequestProof;
export type SourceProofDecision =
  | { consistent: true; checkedBytes: Buffer; byteLength: number; blobSha: string }
  | { consistent: false; code: "provenance_mismatch" | "revision_changed" | "path_not_in_pr" | "non_regular_file" | "bytes_mismatch" | "too_large" };

const sameRepository = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

const blobHashMatches = (bytes: Buffer, reported: string): boolean => {
  if (!SHA.test(reported)) return false;
  const algorithm = reported.length === 40 ? "sha1" : "sha256";
  const actual = createHash(algorithm)
    .update(Buffer.from(`blob ${bytes.length}\0`, "ascii"))
    .update(bytes)
    .digest("hex");
  return actual === reported;
};

export function checkSourceCollectionEvidence(
  source: IdeaSourceFile,
  proof: SourceCollectionProof,
): SourceProofDecision {
  if (!source || !proof || typeof source !== "object" || typeof proof !== "object") {
    return { consistent: false, code: "provenance_mismatch" };
  }
  if (source.kind !== proof.kind || !sameRepository(source.repository, proof.repository) ||
      source.path !== proof.path) {
    return { consistent: false, code: "provenance_mismatch" };
  }
  if (!Buffer.isBuffer(proof.bytes) || proof.bytes.length > AMUX_SOURCE_FILE_MAX_BYTES) {
    return { consistent: false, code: "too_large" };
  }
  if (source.kind === "repository_file" && proof.kind === "repository_file") {
    if (proof.reachableFromRepositoryOwnedRef !== true) {
      return { consistent: false, code: "provenance_mismatch" };
    }
    if (source.commitSha !== proof.fetchedCommitSha) {
      return { consistent: false, code: "revision_changed" };
    }
  } else if (source.kind === "pull_request_file" && proof.kind === "pull_request_file") {
    if (source.number !== proof.number ||
        !sameRepository(source.repository, proof.baseRepository) ||
        !sameRepository(source.repository, proof.headRepository)) {
      // Forked PRs require an explicit extra source approval; v1 refuses them.
      return { consistent: false, code: "provenance_mismatch" };
    }
    if (source.baseSha !== proof.currentBaseSha || source.headSha !== proof.currentHeadSha ||
        proof.fetchedCommitSha !== (source.side === "head" ? source.headSha : source.baseSha)) {
      return { consistent: false, code: "revision_changed" };
    }
    if (proof.completeChangedFileList !== true || !Array.isArray(proof.changedPaths) ||
        !proof.changedPaths.includes(source.path)) {
      return { consistent: false, code: "path_not_in_pr" };
    }
  } else {
    return { consistent: false, code: "provenance_mismatch" };
  }
  if (proof.objectType !== "blob" || !REGULAR_MODES.has(proof.objectMode)) {
    return { consistent: false, code: "non_regular_file" };
  }
  if (proof.blobSha?.length !== proof.fetchedCommitSha?.length ||
      !blobHashMatches(proof.bytes, proof.blobSha)) {
    return { consistent: false, code: "bytes_mismatch" };
  }
  // The caller must use this copy for the next preview; the collector may
  // mutate or release its original Buffer after the check.
  return {
    consistent: true,
    checkedBytes: Buffer.from(proof.bytes),
    byteLength: proof.bytes.length,
    blobSha: proof.blobSha,
  };
}
