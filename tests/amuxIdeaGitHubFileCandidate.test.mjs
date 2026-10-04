import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { collectAmuxGitHubFileCandidate } from "../lib/amux/ideaGitHubFileCandidate.ts";

const ID = 25;
const COMMIT = "a".repeat(40);
const ROOT = "b".repeat(40);
const TEXT = "A small public source file\n";
const bytes = Buffer.from(TEXT, "utf8");
const BLOB = createHash("sha1")
  .update(`blob ${bytes.byteLength}\0`, "utf8").update(bytes).digest("hex");
const limits = { maxPages: 3, maxRefs: 3, maxComparisons: 3, maxTagDepth: 2 };
const node = (oid = COMMIT) => ({
  name: "main", prefix: "refs/heads/", target: { __typename: "Commit", oid },
});
const gql = (field) => ({ data: { repository: { databaseId: ID, ...field } } });

function fixture() {
  const calls = [];
  const changes = {
    refs: null, secondRef: undefined, firstRepo: null, secondRepo: null,
    blob: null, tree: null,
  };
  let refReads = 0;
  let repoReads = 0;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    calls.push(path);
    if (path === "/repos/mposition/Tomverse") {
      repoReads++;
      return Response.json(repoReads === 1 && changes.firstRepo
        ? changes.firstRepo : repoReads === 2 && changes.secondRepo
          ? changes.secondRepo : { id: ID, full_name: "mposition/Tomverse" });
    }
    if (path === "/graphql") {
      const request = JSON.parse(init.body);
      if (request.query.includes("query AmuxIdeaRefs")) return Response.json(gql({
        refs: {
          nodes: request.variables.prefix === "refs/heads/"
            ? changes.refs ?? [node()] : [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }));
      if (request.query.includes("query AmuxIdeaRef")) {
        refReads++;
        return Response.json(gql({ ref: refReads === 2 && changes.secondRef !== undefined
          ? changes.secondRef : node() }));
      }
    }
    if (path === `/repos/mposition/Tomverse/git/commits/${COMMIT}`) {
      return Response.json({ sha: COMMIT, tree: { sha: ROOT } });
    }
    if (path === `/repos/mposition/Tomverse/compare/${COMMIT}...${COMMIT}`) {
      return Response.json({
        status: "identical", ahead_by: 0, behind_by: 0, total_commits: 0,
        base_commit: { sha: COMMIT }, merge_base_commit: { sha: COMMIT }, commits: [],
      });
    }
    if (path === `/repos/mposition/Tomverse/git/trees/${ROOT}`) {
      return Response.json(changes.tree ?? {
        sha: ROOT, truncated: false,
        tree: [{ path: "README.md", mode: "100644", type: "blob",
          sha: BLOB, size: bytes.byteLength }],
      });
    }
    if (path === `/repos/mposition/Tomverse/git/blobs/${BLOB}`) {
      return Response.json(changes.blob ?? {
        sha: BLOB, encoding: "base64", size: bytes.byteLength,
        content: bytes.toString("base64"),
      });
    }
    throw new Error("unexpected endpoint");
  };
  const config = {
    owner: "mposition", repo: "Tomverse", expectedRepositoryId: ID,
    token: "read-only-test-token", fetchImpl,
  };
  return { calls, changes, config };
}

test("owned-ref witness and exact file bytes form only an unscanned candidate", async () => {
  const item = fixture();
  const result = await collectAmuxGitHubFileCandidate(item.config, COMMIT, "README.md", limits);
  assert.equal(result.status, "unscanned_candidate");
  assert.equal(result.file.text, TEXT);
  assert.equal(result.file.blobSha, BLOB);
  assert.equal(result.file.commitSha, COMMIT);
  assert.equal(result.witness.name, "refs/heads/main");
  assert.equal(result.witness.protected, null);
  assert.equal(item.calls.filter((path) => path === "/repos/mposition/Tomverse").length, 2);
  assert.equal(item.calls.filter((path) => path === "/graphql").length, 3);
  assert(item.calls.indexOf(`/repos/mposition/Tomverse/git/blobs/${BLOB}`) >
    item.calls.indexOf(`/repos/mposition/Tomverse/compare/${COMMIT}...${COMMIT}`));
  assert.equal(item.calls.at(-1), "/repos/mposition/Tomverse");
});

test("no owned-ref witness means file bytes are never read", async () => {
  const item = fixture();
  item.changes.refs = [];
  const result = await collectAmuxGitHubFileCandidate(item.config, COMMIT, "README.md", limits);
  assert.deepEqual(result,
    { status: "hold", reason: "no_verified_witness", inspectedRefs: 0 });
  assert(!item.calls.some((path) => path.includes("/git/blobs/") || path.includes("/git/trees/")));
});

test("ref movement during the file read invalidates the candidate", async () => {
  const item = fixture();
  item.changes.secondRef = node("f".repeat(40));
  assert.deepEqual(await collectAmuxGitHubFileCandidate(item.config, COMMIT, "README.md", limits),
    { status: "hold", reason: "ref_changed", inspectedRefs: 1 });
});

test("a ref deleted during the file read is held, never accepted", async () => {
  const item = fixture();
  item.changes.secondRef = null;
  assert.deepEqual(await collectAmuxGitHubFileCandidate(item.config, COMMIT, "README.md", limits),
    { status: "hold", reason: "invalid_response", inspectedRefs: 1 });
});

test("wrong repository at the first identity read stops before any source search", async () => {
  const item = fixture();
  item.changes.firstRepo = { id: ID + 1, full_name: "mposition/Tomverse" };
  assert.deepEqual(await collectAmuxGitHubFileCandidate(item.config, COMMIT, "README.md", limits),
    { status: "hold", reason: "wrong_repository", inspectedRefs: 0 });
  assert.deepEqual(item.calls, ["/repos/mposition/Tomverse"]);
});

test("repository replacement after reading file bytes invalidates the candidate", async () => {
  const item = fixture();
  item.changes.secondRepo = { id: ID + 1, full_name: "mposition/Tomverse" };
  assert.deepEqual(await collectAmuxGitHubFileCandidate(item.config, COMMIT, "README.md", limits),
    { status: "hold", reason: "wrong_repository", inspectedRefs: 1 });
});

test("wrong file bytes and unsupported paths never become candidates", async () => {
  const altered = fixture();
  const wrong = Buffer.from("B small public source file\n", "utf8");
  assert.equal(wrong.byteLength, bytes.byteLength);
  altered.changes.blob = {
    sha: BLOB, encoding: "base64", size: wrong.byteLength,
    content: wrong.toString("base64"),
  };
  assert.deepEqual(await collectAmuxGitHubFileCandidate(altered.config, COMMIT, "README.md", limits),
    { status: "hold", reason: "blob_digest_mismatch", inspectedRefs: 1 });

  const unsafe = fixture();
  assert.deepEqual(await collectAmuxGitHubFileCandidate(unsafe.config, COMMIT, "../README.md", limits),
    { status: "reject", reason: "unsupported_file_path", inspectedRefs: 1 });
  assert(!unsafe.calls.some((path) => path.includes("/git/trees/") || path.includes("/git/blobs/")));
});

test("an unexpected collector contract error still holds without leaking details", async () => {
  const item = fixture();
  const config = { ...item.config, signal: "not-an-abort-signal" };
  assert.deepEqual(await collectAmuxGitHubFileCandidate(config, COMMIT, "README.md", limits),
    { status: "hold", reason: "collector_unavailable", inspectedRefs: 0 });
});
