import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  collectAmuxPullRequestFileCandidate,
  inspectAmuxPullRequestFileCandidateCollection,
} from "../lib/amux/ideaPullRequestFileCandidate.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const PATH = "docs/guide.md";
const repository = { fullName: "mposition/Tomverse", id: 25 };
const source = {
  kind: "pull_request_file", repository: repository.fullName,
  number: 42, baseSha: BASE, headSha: HEAD, side: "head", path: PATH,
};
const fileList = {
  status: "complete", repositoryId: repository.id, number: 42,
  baseSha: BASE, headSha: HEAD, mergeBaseSha: BASE,
  basePaths: [PATH], headPaths: [PATH],
};
const candidate = {
  status: "unscanned_candidate", inspectedRefs: 1,
  witness: { repositoryId: repository.id },
  file: { repositoryId: repository.id, commitSha: HEAD, path: PATH },
};
const inspect = (first = fileList, next = candidate, last = fileList, selected = source) =>
  inspectAmuxPullRequestFileCandidateCollection(selected, repository, first, next, last);

test("bounded collection accepts stable same-side exact-file observations only", () => {
  const result = inspect();
  assert.equal(result.status, "unscanned_pr_candidate");
  assert.equal(result.fileList, fileList);
  assert.equal(result.candidate, candidate);
  const base = { ...source, side: "base" };
  assert.equal(inspect(fileList, { ...candidate, file: { ...candidate.file,
    commitSha: BASE } }, fileList, base).status, "unscanned_pr_candidate");
});

test("a changed or incomplete second PR observation discards the candidate", () => {
  for (const changed of [
    { ...fileList, headSha: "c".repeat(40) },
    { ...fileList, basePaths: [] },
    { ...fileList, headPaths: [] },
    { ...fileList, number: 43 },
    { status: "hold", reason: "transport_error" },
  ]) assert.deepEqual(inspect(fileList, candidate, changed),
    { status: "hold", reason: "pr_collection_changed" });
  assert.deepEqual(inspect({ ...fileList, mergeBaseSha: "c".repeat(40) }),
    { status: "hold", reason: "pr_collection_changed" });
  // Defense-in-depth: the real list collector cannot emit this as complete.
  const movedBase = { ...fileList, mergeBaseSha: "c".repeat(40) };
  assert.deepEqual(inspect(movedBase, candidate, movedBase),
    { status: "hold", reason: "pr_base_not_merge_base" });
  const wrongRepository = { ...fileList, repositoryId: 26 };
  assert.deepEqual(inspect(wrongRepository, candidate, wrongRepository),
    { status: "hold", reason: "pr_collection_changed" });
  assert.deepEqual(inspect({ ...fileList, basePaths: undefined }),
    { status: "hold", reason: "pr_collection_changed" });
});

test("source and file candidate must match repository, side, SHA and path", () => {
  for (const changed of [
    { ...candidate, file: { ...candidate.file, repositoryId: 26 } },
    { ...candidate, witness: { repositoryId: 26 } },
    { ...candidate, file: { ...candidate.file, commitSha: BASE } },
    { ...candidate, file: { ...candidate.file, path: "docs/other.md" } },
  ]) assert.deepEqual(inspect(fileList, changed),
    { status: "hold", reason: "pr_file_candidate_mismatch" });
  assert.deepEqual(inspect(fileList, candidate, fileList,
    { ...source, path: "docs/other.md" }),
  { status: "hold", reason: "pr_collection_changed" });
  assert.deepEqual(inspect(fileList, candidate, fileList,
    { ...source, side: "base" }),
  { status: "hold", reason: "pr_file_candidate_mismatch" });
});

test("file candidate hold and reject stay non-successful", () => {
  assert.deepEqual(inspect(fileList, { status: "hold", reason: "ref_changed" }),
    { status: "hold", reason: "ref_changed" });
  assert.deepEqual(inspect(fileList, { status: "reject", reason: "not_regular_file" }),
    { status: "reject", reason: "not_regular_file" });
});

test("wrapper rejects a repository file before any network request", async () => {
  let fetchCalls = 0;
  const config = { owner: "mposition", repo: "Tomverse", expectedRepositoryId: 25,
    token: "test-read-token", fetchImpl: async () => {
      fetchCalls++;
      throw new Error("network called");
    } };
  assert.deepEqual(await collectAmuxPullRequestFileCandidate(config,
    { kind: "repository_file", repository: repository.fullName,
      commitSha: HEAD, path: PATH }, {}),
  { status: "hold", reason: "pr_source_unverified" });
  assert.deepEqual(await collectAmuxPullRequestFileCandidate(config,
    { ...source, repository: undefined }, {}),
  { status: "hold", reason: "pr_source_unverified" });
  assert.deepEqual(await collectAmuxPullRequestFileCandidate(config,
    { ...source, side: "merge" }, {}),
  { status: "hold", reason: "pr_source_unverified" });
  assert.deepEqual(await collectAmuxPullRequestFileCandidate(
    { ...config, expectedRepositoryId: undefined }, source, {}),
  { status: "hold", reason: "pr_source_unverified" });
  assert.deepEqual(await collectAmuxPullRequestFileCandidate(
    { ...config, signal: {} }, source, {}),
  { status: "hold", reason: "pr_collection_unverified" });
  assert.equal(fetchCalls, 0);
});

function syntheticGitHub({ driftOnSecondList = false } = {}) {
  const treeSha = "c".repeat(40);
  const subtreeSha = "d".repeat(40);
  const text = "AMUX synthetic PR file\n";
  const bytes = Buffer.from(text, "utf8");
  const blobSha = createHash("sha1").update(`blob ${bytes.byteLength}\0`, "utf8")
    .update(bytes).digest("hex");
  const calls = [];
  let prReads = 0;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    calls.push(path);
    if (parsed.pathname === "/repos/mposition/Tomverse") {
      return Response.json({ id: 25, full_name: "mposition/Tomverse" });
    }
    if (parsed.pathname === "/repos/mposition/Tomverse/pulls/42") {
      prReads++;
      const headSha = driftOnSecondList && prReads >= 3 ? "e".repeat(40) : HEAD;
      return Response.json({ number: 42, changed_files: 1,
        base: { sha: BASE, repo: { id: 25 } },
        head: { sha: headSha, repo: { id: 25 } } });
    }
    if (parsed.pathname === `/repos/mposition/Tomverse/compare/${BASE}...${HEAD}` ||
        parsed.pathname === `/repos/mposition/Tomverse/compare/${BASE}...${"e".repeat(40)}`) {
      return Response.json({ status: "ahead", ahead_by: 1, behind_by: 0,
        base_commit: { sha: BASE }, merge_base_commit: { sha: BASE } });
    }
    if (parsed.pathname === "/repos/mposition/Tomverse/pulls/42/files") {
      return Response.json([{ filename: PATH, status: "modified" }]);
    }
    if (parsed.pathname === "/graphql") {
      const body = JSON.parse(init.body);
      const ref = { name: "pr", prefix: "refs/heads/",
        target: { __typename: "Commit", oid: HEAD } };
      if (body.query.includes("AmuxIdeaRefs")) return Response.json({ data: {
        repository: { databaseId: 25, refs: { nodes: [ref],
          pageInfo: { hasNextPage: false, endCursor: null } } },
      } });
      if (body.query.includes("AmuxIdeaRef")) return Response.json({ data: {
        repository: { databaseId: 25, ref },
      } });
    }
    if (parsed.pathname === `/repos/mposition/Tomverse/git/commits/${HEAD}`) {
      return Response.json({ sha: HEAD, tree: { sha: treeSha } });
    }
    if (parsed.pathname === `/repos/mposition/Tomverse/compare/${HEAD}...${HEAD}`) {
      return Response.json({ status: "identical", ahead_by: 0, behind_by: 0,
        total_commits: 0, commits: [], base_commit: { sha: HEAD },
        merge_base_commit: { sha: HEAD } });
    }
    if (parsed.pathname === `/repos/mposition/Tomverse/git/trees/${treeSha}`) {
      return Response.json({ sha: treeSha, truncated: false,
        tree: [{ path: "docs", mode: "040000", type: "tree", sha: subtreeSha }] });
    }
    if (parsed.pathname === `/repos/mposition/Tomverse/git/trees/${subtreeSha}`) {
      return Response.json({ sha: subtreeSha, truncated: false,
        tree: [{ path: "guide.md", mode: "100644", type: "blob",
          sha: blobSha, size: bytes.byteLength }] });
    }
    if (parsed.pathname === `/repos/mposition/Tomverse/git/blobs/${blobSha}`) {
      return Response.json({ sha: blobSha, encoding: "base64", size: bytes.byteLength,
        content: bytes.toString("base64") });
    }
    throw new Error(`unexpected synthetic endpoint ${path}`);
  };
  return { fetchImpl, calls, text };
}

test("wrapper collects list → exact file → list and returns only stable candidate", async () => {
  const synthetic = syntheticGitHub();
  const result = await collectAmuxPullRequestFileCandidate({
    owner: "mposition", repo: "Tomverse", expectedRepositoryId: 25,
    token: "synthetic-read-token", fetchImpl: synthetic.fetchImpl,
  }, source, { maxPages: 2, maxRefs: 2, maxComparisons: 2, maxTagDepth: 2 });
  assert.equal(result.status, "unscanned_pr_candidate");
  assert.equal(result.candidate.file.text, synthetic.text);
  assert.equal(synthetic.calls.filter((path) => path.includes("/pulls/42/files")).length, 2);
  assert.equal(synthetic.calls.filter((path) => path.includes(`/git/blobs/`)).length, 1);
});

test("wrapper discards exact file when the PR head changes before final list", async () => {
  const synthetic = syntheticGitHub({ driftOnSecondList: true });
  const result = await collectAmuxPullRequestFileCandidate({
    owner: "mposition", repo: "Tomverse", expectedRepositoryId: 25,
    token: "synthetic-read-token", fetchImpl: synthetic.fetchImpl,
  }, source, { maxPages: 2, maxRefs: 2, maxComparisons: 2, maxTagDepth: 2 });
  assert.deepEqual(result, { status: "hold", reason: "pr_collection_changed" });
  assert.equal(synthetic.calls.filter((path) => path.includes("/pulls/42/files")).length, 2);
});
