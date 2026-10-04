import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { checkSourceCollectionEvidence } from "../lib/amux/ideaSourceProofCore.ts";

const a = "a".repeat(40);
const b = "b".repeat(40);
const bytes = Buffer.from("synthetic-source-only", "utf8");
const blobSha = createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex");
const repository = "mposition/Tomverse";
const path = "lib/amux/ideaInputCore.ts";

const repoSource = { kind: "repository_file", repository, commitSha: a, path };
const repoProof = {
  kind: "repository_file", repository, path, fetchedCommitSha: a,
  reachableFromRepositoryOwnedRef: true,
  objectType: "blob", objectMode: "100644", blobSha, bytes,
};
const prSource = {
  kind: "pull_request_file", repository, number: 42, baseSha: a, headSha: b,
  side: "head", path,
};
const prProof = {
  kind: "pull_request_file", repository, path, number: 42,
  currentBaseSha: a, currentHeadSha: b, fetchedCommitSha: b,
  baseRepository: repository, headRepository: repository,
  completeChangedFileList: true, changedPaths: [path],
  objectType: "blob", objectMode: "100755", blobSha, bytes,
};

test("repository file proof needs owned-ref reachability and exact bytes", () => {
  const checked = checkSourceCollectionEvidence(repoSource, repoProof);
  assert.equal(checked.consistent, true);
  assert.equal(checked.byteLength, bytes.length);
  assert.equal(checked.blobSha, blobSha);
  assert.deepEqual(checked.checkedBytes, bytes);
  assert.notEqual(checked.checkedBytes, bytes);
  assert.deepEqual(checkSourceCollectionEvidence(repoSource, { ...repoProof, reachableFromRepositoryOwnedRef: false }),
    { consistent: false, code: "provenance_mismatch" });
  assert.deepEqual(checkSourceCollectionEvidence(repoSource, { ...repoProof, reachableFromRepositoryOwnedRef: "false" }),
    { consistent: false, code: "provenance_mismatch" });
  assert.deepEqual(checkSourceCollectionEvidence(repoSource, { ...repoProof, fetchedCommitSha: b }),
    { consistent: false, code: "revision_changed" });
  assert.deepEqual(checkSourceCollectionEvidence(repoSource, { ...repoProof, bytes: Buffer.from("other") }),
    { consistent: false, code: "bytes_mismatch" });
  assert.deepEqual(checkSourceCollectionEvidence(repoSource, { ...repoProof, bytes: Buffer.alloc(65_537) }),
    { consistent: false, code: "too_large" });
});

test("PR file proof binds number, both current revisions, side, changed path and repository", () => {
  assert.equal(checkSourceCollectionEvidence(prSource, prProof).consistent, true);
  assert.deepEqual(checkSourceCollectionEvidence(prSource, { ...prProof, currentHeadSha: "c".repeat(40) }),
    { consistent: false, code: "revision_changed" });
  assert.deepEqual(checkSourceCollectionEvidence(prSource, { ...prProof, fetchedCommitSha: a }),
    { consistent: false, code: "revision_changed" });
  assert.equal(checkSourceCollectionEvidence({ ...prSource, side: "base" }, { ...prProof, fetchedCommitSha: a }).consistent, true);
  assert.deepEqual(checkSourceCollectionEvidence(prSource, { ...prProof, changedPaths: [] }),
    { consistent: false, code: "path_not_in_pr" });
  assert.deepEqual(checkSourceCollectionEvidence(prSource, { ...prProof, completeChangedFileList: false }),
    { consistent: false, code: "path_not_in_pr" });
  assert.deepEqual(checkSourceCollectionEvidence(prSource, { ...prProof, completeChangedFileList: "false" }),
    { consistent: false, code: "path_not_in_pr" });
  assert.deepEqual(checkSourceCollectionEvidence(prSource, { ...prProof, headRepository: "other/fork" }),
    { consistent: false, code: "provenance_mismatch" });
  assert.deepEqual(checkSourceCollectionEvidence(prSource, { ...prProof, number: 43 }),
    { consistent: false, code: "provenance_mismatch" });
  assert.deepEqual(checkSourceCollectionEvidence(prSource, { ...prProof, baseRepository: "other/fork" }),
    { consistent: false, code: "provenance_mismatch" });
  assert.equal(checkSourceCollectionEvidence(prSource, { ...prProof, repository: "MPosition/tomverse" }).consistent, true);
});

test("trees, symlinks, gitlinks and swapped paths are refused", () => {
  for (const objectMode of ["040000", "120000", "160000"]) {
    assert.deepEqual(checkSourceCollectionEvidence(repoSource, { ...repoProof, objectMode }),
      { consistent: false, code: "non_regular_file" });
  }
  assert.deepEqual(checkSourceCollectionEvidence(repoSource, { ...repoProof, objectType: "tree" }),
    { consistent: false, code: "non_regular_file" });
  assert.deepEqual(checkSourceCollectionEvidence(repoSource, { ...repoProof, path: "other.ts" }),
    { consistent: false, code: "provenance_mismatch" });
  assert.deepEqual(checkSourceCollectionEvidence(repoSource, { ...repoProof, repository: null }),
    { consistent: false, code: "provenance_mismatch" });
  assert.deepEqual(checkSourceCollectionEvidence(repoSource, { ...repoProof, bytes: "synthetic" }),
    { consistent: false, code: "too_large" });
  assert.deepEqual(checkSourceCollectionEvidence(null, null),
    { consistent: false, code: "provenance_mismatch" });
});

test("Git blob SHA-256 format and the exact byte cap are checked", () => {
  const boundaryBytes = Buffer.alloc(65_536, 7);
  const sha256 = createHash("sha256")
    .update(Buffer.from(`blob ${boundaryBytes.length}\0`))
    .update(boundaryBytes)
    .digest("hex");
  const sha256Source = { ...repoSource, commitSha: "a".repeat(64) };
  const proof = {
    ...repoProof, fetchedCommitSha: "a".repeat(64), bytes: boundaryBytes, blobSha: sha256,
  };
  const checked = checkSourceCollectionEvidence(sha256Source, proof);
  assert.equal(checked.consistent, true);
  assert.equal(checked.byteLength, 65_536);
  assert.deepEqual(checkSourceCollectionEvidence(repoSource, { ...repoProof, blobSha: sha256 }),
    { consistent: false, code: "bytes_mismatch" });
});
