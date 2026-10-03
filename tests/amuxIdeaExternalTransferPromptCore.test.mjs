import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildAmuxScopedPullRequestTransferPromptCandidate,
  buildAmuxScopedRepositoryTransferPromptCandidate,
} from "../lib/amux/ideaExternalTransferPromptCore.ts";

const COMMIT = "a".repeat(40);
const HEAD = "b".repeat(40);
const SECRET = "s".repeat(32);
const PATH = "docs/guide.md";
const IDEA = "Review Korean onboarding";
const TEXT = "첫 화면의 안내 문구를 확인합니다.\n";
const bytes = Buffer.from(TEXT, "utf8");

function candidate(commitSha = COMMIT) {
  return { status: "unscanned_candidate", inspectedRefs: 1,
    witness: { repositoryId: 25, name: "refs/heads/main", protected: null,
      refObjectSha: commitSha, refCommitSha: commitSha },
    file: { status: "verified_file", repositoryId: 25, commitSha,
      path: PATH, size: bytes.length, text: TEXT,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      blobSha: createHash("sha1").update(`blob ${bytes.length}\0`, "utf8")
        .update(bytes).digest("hex") },
  };
}

const repositoryInput = {
  previewId: "11111111-1111-4111-8111-111111111111",
  idea: { version: 1, idea: IDEA, repositories: ["mposition/Tomverse"],
    pullRequests: [] },
  scopeJson: JSON.stringify({ version: 1, sources: [{ kind: "repository_file",
    repository: "mposition/Tomverse", commitSha: COMMIT, path: PATH }] }),
  repositoryIds: new Map([["mposition/tomverse", 25]]),
  modelId: "gpt-6-astra",
  selections: [{ sourceIndex: 0, candidate: candidate(), startByte: 0,
    endByte: bytes.length }],
  digestSecret: SECRET,
};

test("external transfer candidate includes the exact scanned excerpt in the model prompt", () => {
  const result = buildAmuxScopedRepositoryTransferPromptCandidate(repositoryInput);
  assert.equal(result.status, "prompt_candidate");
  assert.match(result.prompt, /Review Korean onboarding/);
  assert.match(result.prompt, /첫 화면의 안내 문구를 확인합니다/);
  assert.equal(result.sources[0].excerptText, TEXT);
  assert.match(result.sourcePreviewDigest, /^[a-f0-9]{64}$/);
});

test("the model prompt uses the same normalized idea snapshot checked for the excerpt", () => {
  const padded = buildAmuxScopedRepositoryTransferPromptCandidate({
    ...repositoryInput, idea: { ...repositoryInput.idea,
      idea: "  Review Korean onboarding  " },
  });
  assert.equal(padded.status, "prompt_candidate");
  assert.match(padded.prompt, /"text":"Review Korean onboarding"/);
  assert.doesNotMatch(padded.prompt, /"text":"  Review Korean onboarding  "/);

  let reads = 0;
  const changingIdea = { ...repositoryInput.idea,
    get idea() { reads += 1; return reads === 1 ? IDEA : "Changed after validation"; } };
  const changing = buildAmuxScopedRepositoryTransferPromptCandidate({
    ...repositoryInput, idea: changingIdea,
  });
  assert.equal(changing.status, "prompt_candidate");
  assert.equal(reads, 1);
  assert.match(changing.prompt, /Review Korean onboarding/);
  assert.doesNotMatch(changing.prompt, /Changed after validation/);
});

test("external transfer candidate rejects a changed source or oversized combined prompt", () => {
  const changed = buildAmuxScopedRepositoryTransferPromptCandidate({
    ...repositoryInput,
    scopeJson: JSON.stringify({ version: 1, sources: [{ kind: "repository_file",
      repository: "mposition/Tomverse", commitSha: HEAD, path: PATH }] }),
  });
  assert.deepEqual(changed, { status: "hold", reason: "source_scope_mismatch" });

  const oversized = buildAmuxScopedRepositoryTransferPromptCandidate({
    ...repositoryInput,
    idea: { ...repositoryInput.idea, idea: "한".repeat(2_700) },
  });
  assert.deepEqual(oversized, { status: "reject", reason: "chunk_input_too_large" });
});

test("PR candidate binds the complete changed-file witness to the displayed prompt", () => {
  const idea = { version: 1, idea: IDEA, repositories: [],
    pullRequests: [{ repository: "mposition/Tomverse", number: 42 }] };
  const source = { kind: "pull_request_file", repository: "mposition/Tomverse",
    number: 42, baseSha: COMMIT, headSha: HEAD, side: "head", path: PATH };
  const input = {
    ...repositoryInput, idea,
    scopeJson: JSON.stringify({ version: 1, sources: [source] }),
    repositoryIdentities: new Map([["mposition/tomverse",
      { fullName: "mposition/Tomverse", id: 25 }]]),
    selections: [{ sourceIndex: 0, candidate: candidate(HEAD),
      fileList: { status: "complete", repositoryId: 25, number: 42,
        baseSha: COMMIT, headSha: HEAD, mergeBaseSha: COMMIT,
        basePaths: [PATH], headPaths: [PATH] },
      startByte: 0, endByte: bytes.length }],
  };
  const result = buildAmuxScopedPullRequestTransferPromptCandidate(input);
  assert.equal(result.status, "prompt_candidate");
  assert.equal(result.sources[0].commitSha, HEAD);
  assert.match(result.prompt, /첫 화면의 안내 문구를 확인합니다/);

  const missingWitness = buildAmuxScopedPullRequestTransferPromptCandidate({
    ...input, selections: [{ ...input.selections[0], fileList: undefined }],
  });
  assert.deepEqual(missingWitness, { status: "hold", reason: "pr_source_scope_mismatch" });
});
