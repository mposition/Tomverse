import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { verifyAmuxGitHubFileAtCommit } from "../lib/amux/ideaGitHubFileAtCommitCore.ts";

const ID = 42;
const COMMIT = "a".repeat(40);
const ROOT = "b".repeat(40);
const SUBTREE = "c".repeat(40);

function blobSha(bytes, algorithm = "sha1") {
  return createHash(algorithm)
    .update(`blob ${bytes.byteLength}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

function fixture(content = "Hello\r\nTomverse\n", algorithm = "sha1") {
  const bytes = Buffer.from(content, "utf8");
  const sha = blobSha(bytes, algorithm);
  const commitSha = algorithm === "sha1" ? COMMIT : "a".repeat(64);
  const rootSha = algorithm === "sha1" ? ROOT : "b".repeat(64);
  const subtreeSha = algorithm === "sha1" ? SUBTREE : "c".repeat(64);
  const calls = { commit: 0, tree: 0, blob: 0 };
  const adapter = {
    async readCommit(requestedSha) {
      calls.commit++;
      assert.equal(requestedSha, commitSha);
      return { repositoryId: ID, sha: commitSha, treeSha: rootSha };
    },
    async readTree(requestedSha) {
      calls.tree++;
      if (requestedSha === rootSha) {
        return {
          repositoryId: ID, sha: rootSha, truncated: false,
          entries: [{ path: "docs", mode: "040000", type: "tree", sha: subtreeSha, size: null }],
        };
      }
      assert.equal(requestedSha, subtreeSha);
      return {
        repositoryId: ID, sha: subtreeSha, truncated: false,
        entries: [{ path: "guide.md", mode: "100644", type: "blob", sha, size: bytes.byteLength }],
      };
    },
    async readBlob(requestedSha) {
      calls.blob++;
      assert.equal(requestedSha, sha);
      return { repositoryId: ID, sha, size: bytes.byteLength, bytes };
    },
  };
  return { adapter, calls, bytes, sha, commitSha, rootSha, subtreeSha };
}

test("verifies exact nested regular file bytes, SHA and preserved line endings", async () => {
  const item = fixture("\uFEFFfirst\r\nsecond\n");
  const result = await verifyAmuxGitHubFileAtCommit(ID, item.commitSha, "docs/guide.md", item.adapter);
  assert.equal(result.status, "verified_file");
  assert.equal(result.text, "\uFEFFfirst\r\nsecond\n");
  assert.equal(result.blobSha, item.sha);
  assert.equal(result.size, item.bytes.byteLength);
  assert.equal(result.sha256, createHash("sha256").update(item.bytes).digest("hex"));
  assert.deepEqual(item.calls, { commit: 1, tree: 2, blob: 1 });
});

test("supports SHA-256 Git repositories without mixing hash lengths", async () => {
  const item = fixture("sha256 tree", "sha256");
  assert.equal((await verifyAmuxGitHubFileAtCommit(ID, item.commitSha, "docs/guide.md", item.adapter)).status, "verified_file");
  const mixed = fixture();
  mixed.adapter.readCommit = async () => ({ repositoryId: ID, sha: COMMIT, treeSha: "b".repeat(64) });
  assert.deepEqual(await verifyAmuxGitHubFileAtCommit(ID, COMMIT, "docs/guide.md", mixed.adapter),
    { status: "hold", reason: "commit_unverified" });
});

test("rejects unsupported and ambiguous paths before fetching", async () => {
  const item = fixture();
  for (const path of ["", null, "../docs/guide.md", "docs//guide.md", "/docs/guide.md",
    "docs\\guide.md", "docs/./guide.md", "docs/a b.md", "docs/guide.md\n",
    "docs/한글.md", "docs/", `${"a/".repeat(33)}guide.md`, `${"a".repeat(513)}`]) {
    assert.deepEqual(await verifyAmuxGitHubFileAtCommit(ID, COMMIT, path, item.adapter),
      { status: "reject", reason: "unsupported_file_path" });
  }
  assert.deepEqual(item.calls, { commit: 0, tree: 0, blob: 0 });
});

test("rejects symlink, submodule and directory targets without reading blobs", async () => {
  for (const entry of [
    { mode: "120000", type: "blob" },
    { mode: "160000", type: "commit" },
    { mode: "040000", type: "tree" },
  ]) {
    const item = fixture();
    const original = item.adapter.readTree;
    item.adapter.readTree = async (sha) => {
      const tree = await original(sha);
      if (sha === item.subtreeSha) {
        tree.entries[0].mode = entry.mode;
        tree.entries[0].type = entry.type;
      }
      return tree;
    };
    assert.deepEqual(await verifyAmuxGitHubFileAtCommit(ID, COMMIT, "docs/guide.md", item.adapter),
      { status: "reject", reason: "non_regular_file" });
    assert.equal(item.calls.blob, 0);
  }
});

test("rejects oversized declared files before downloading the blob", async () => {
  const item = fixture();
  const original = item.adapter.readTree;
  item.adapter.readTree = async (sha) => {
    const tree = await original(sha);
    if (sha === item.subtreeSha) tree.entries[0].size = 64 * 1024 + 1;
    return tree;
  };
  assert.deepEqual(await verifyAmuxGitHubFileAtCommit(ID, COMMIT, "docs/guide.md", item.adapter),
    { status: "reject", reason: "file_too_large" });
  assert.equal(item.calls.blob, 0);
});

test("allows an empty file and exactly 64 KiB, but not one byte more", async () => {
  for (const content of ["", "x".repeat(64 * 1024)]) {
    const item = fixture(content);
    const result = await verifyAmuxGitHubFileAtCommit(ID, COMMIT, "docs/guide.md", item.adapter);
    assert.equal(result.status, "verified_file");
    assert.equal(result.size, Buffer.byteLength(content));
  }
});

test("truncated, duplicate, mismatched and malformed tree observations hold", async () => {
  for (const [mutate, reason] of [
    [(tree) => { tree.truncated = true; }, "tree_unverified"],
    [(tree) => { tree.entries.push({ ...tree.entries[0] }); }, "path_unverified"],
    [(tree) => { tree.repositoryId = ID + 1; }, "tree_unverified"],
    [(tree) => { tree.entries[0].sha = "bad"; }, "tree_unverified"],
  ]) {
    const item = fixture();
    const original = item.adapter.readTree;
    item.adapter.readTree = async (sha) => {
      const tree = await original(sha);
      if (sha === item.subtreeSha) mutate(tree);
      return tree;
    };
    const result = await verifyAmuxGitHubFileAtCommit(ID, COMMIT, "docs/guide.md", item.adapter);
    assert.deepEqual(result, { status: "hold", reason });
    assert.equal(item.calls.blob, 0);
  }
});

test("blob identity, declared size and content digest must all match", async () => {
  for (const [mutate, reason] of [
    [(blob) => { blob.repositoryId = ID + 1; }, "blob_unverified"],
    [(blob) => { blob.sha = "f".repeat(40); }, "blob_unverified"],
    [(blob) => { blob.size++; }, "blob_unverified"],
    [(blob) => { blob.bytes = Buffer.from("different"); }, "blob_unverified"],
    [(blob) => { blob.bytes = Buffer.from(blob.bytes); blob.bytes[0] ^= 1; }, "blob_digest_mismatch"],
  ]) {
    const item = fixture();
    const original = item.adapter.readBlob;
    item.adapter.readBlob = async (sha) => {
      const blob = await original(sha);
      mutate(blob);
      return blob;
    };
    const result = await verifyAmuxGitHubFileAtCommit(ID, COMMIT, "docs/guide.md", item.adapter);
    assert.deepEqual(result, { status: "hold", reason });
  }
});

test("valid Git blobs that are not UTF-8 text cannot pass", async () => {
  for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.from([0x61, 0, 0x62]),
    Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xe2, 0x82])]) {
    const item = fixture();
    const sha = blobSha(bytes);
    const originalTree = item.adapter.readTree;
    item.adapter.readTree = async (requestSha) => {
      const tree = await originalTree(requestSha);
      if (requestSha === item.subtreeSha) Object.assign(tree.entries[0], { sha, size: bytes.byteLength });
      return tree;
    };
    item.adapter.readBlob = async () => ({ repositoryId: ID, sha, size: bytes.byteLength, bytes });
    assert.deepEqual(await verifyAmuxGitHubFileAtCommit(ID, COMMIT, "docs/guide.md", item.adapter),
      { status: "reject", reason: "non_text_file" });
  }
});

test("missing paths, wrong commit identity and mixed tree hashes hold", async () => {
  const missing = fixture();
  const originalTree = missing.adapter.readTree;
  missing.adapter.readTree = async (sha) => {
    const tree = await originalTree(sha);
    if (sha === SUBTREE) tree.entries[0].path = "elsewhere.md";
    return tree;
  };
  assert.deepEqual(await verifyAmuxGitHubFileAtCommit(ID, COMMIT, "docs/guide.md", missing.adapter),
    { status: "hold", reason: "path_unverified" });

  const badCommit = fixture();
  badCommit.adapter.readCommit = async () => ({ repositoryId: ID + 1, sha: COMMIT, treeSha: ROOT });
  assert.deepEqual(await verifyAmuxGitHubFileAtCommit(ID, COMMIT, "docs/guide.md", badCommit.adapter),
    { status: "hold", reason: "commit_unverified" });

  const mixed = fixture();
  const mixedTree = mixed.adapter.readTree;
  mixed.adapter.readTree = async (sha) => {
    const tree = await mixedTree(sha);
    if (sha === ROOT) tree.entries[0].sha = "c".repeat(64);
    return tree;
  };
  assert.deepEqual(await verifyAmuxGitHubFileAtCommit(ID, COMMIT, "docs/guide.md", mixed.adapter),
    { status: "hold", reason: "tree_unverified" });
});

test("invalid contracts and collector exceptions hold rather than pass", async () => {
  const item = fixture();
  assert.deepEqual(await verifyAmuxGitHubFileAtCommit(0, COMMIT, "docs/guide.md", item.adapter),
    { status: "hold", reason: "invalid_file_contract" });
  assert.deepEqual(await verifyAmuxGitHubFileAtCommit(ID, COMMIT, "docs/guide.md", undefined),
    { status: "hold", reason: "invalid_file_contract" });
  const throwingAdapter = Object.defineProperty({}, "readCommit", {
    get() { throw new Error("do not leak"); },
  });
  assert.deepEqual(await verifyAmuxGitHubFileAtCommit(ID, COMMIT, "docs/guide.md", throwingAdapter),
    { status: "hold", reason: "collector_unavailable" });
  item.adapter.readTree = async () => { throw new Error("upstream secret must not leak"); };
  assert.deepEqual(await verifyAmuxGitHubFileAtCommit(ID, COMMIT, "docs/guide.md", item.adapter),
    { status: "hold", reason: "collector_unavailable" });
});
