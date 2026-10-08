import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { verifyAmuxGitHubFileAtCommit } from "../lib/amux/ideaGitHubFileAtCommitCore.ts";
import { createAmuxIdeaGitHubRefReader } from "../lib/amux/ideaGitHubRefReadAdapter.ts";

const ID = 25;
const COMMIT = "a".repeat(40);
const ROOT = "b".repeat(40);
const SUBTREE = "c".repeat(40);
const PATH = "docs/guide.md";
const gitBlobSha = (bytes) => createHash("sha1")
  .update(`blob ${bytes.byteLength}\0`, "utf8").update(bytes).digest("hex");

function fixture(text = "Hello from GitHub\r\n") {
  const bytes = Buffer.from(text, "utf8");
  const blobSha = gitBlobSha(bytes);
  const calls = [];
  const overrides = {};
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, search: parsed.search, init });
    const path = parsed.pathname;
    if (path === "/repos/mposition/Tomverse") {
      return Response.json(overrides.repo ?? { id: ID, full_name: "mposition/Tomverse" });
    }
    if (path === `/repos/mposition/Tomverse/git/commits/${COMMIT}`) {
      return Response.json(overrides.commit ?? { sha: COMMIT, tree: { sha: ROOT } });
    }
    if (path === `/repos/mposition/Tomverse/git/trees/${ROOT}`) {
      return Response.json(overrides.root ?? {
        sha: ROOT, truncated: false,
        tree: [{ path: "docs", mode: "040000", type: "tree", sha: SUBTREE }],
      });
    }
    if (path === `/repos/mposition/Tomverse/git/trees/${SUBTREE}`) {
      return Response.json(overrides.subtree ?? {
        sha: SUBTREE, truncated: false,
        tree: [{ path: "guide.md", mode: "100644", type: "blob",
          sha: blobSha, size: bytes.byteLength }],
      });
    }
    if (path === `/repos/mposition/Tomverse/git/blobs/${blobSha}`) {
      const base64 = bytes.toString("base64");
      return Response.json(overrides.blob ?? {
        sha: blobSha, encoding: "base64", size: bytes.byteLength,
        content: `${base64.slice(0, 8)}\n${base64.slice(8)}\n`,
      });
    }
    throw new Error("unexpected endpoint");
  };
  const reader = createAmuxIdeaGitHubRefReader({
    owner: "mposition", repo: "Tomverse", expectedRepositoryId: ID,
    token: "test-read-token", fetchImpl,
  });
  return { reader, calls, overrides, bytes, blobSha };
}

test("REST adapter normalizes GitHub trees and feeds exact bytes to the core", async () => {
  const item = fixture("\uFEFFline one\r\nline two\n");
  assert.deepEqual(await item.reader.readRepositoryIdentity(),
    { id: ID, fullName: "mposition/Tomverse" });
  const result = await verifyAmuxGitHubFileAtCommit(ID, COMMIT, PATH, item.reader.fileAdapter);
  assert.equal(result.status, "verified_file");
  assert.equal(result.text, "\uFEFFline one\r\nline two\n");
  assert.equal(result.blobSha, item.blobSha);
  assert.equal(result.sha256, createHash("sha256").update(item.bytes).digest("hex"));
  assert.deepEqual(await item.reader.readRepositoryIdentity(),
    { id: ID, fullName: "mposition/Tomverse" });
  assert.deepEqual(item.calls.map(({ path }) => path), [
    "/repos/mposition/Tomverse",
    `/repos/mposition/Tomverse/git/commits/${COMMIT}`,
    `/repos/mposition/Tomverse/git/trees/${ROOT}`,
    `/repos/mposition/Tomverse/git/trees/${SUBTREE}`,
    `/repos/mposition/Tomverse/git/blobs/${item.blobSha}`,
    "/repos/mposition/Tomverse",
  ]);
  assert(item.calls.every(({ search, init }) => search === "" &&
    init.method === "GET" && init.redirect === "error" &&
    init.headers.Authorization === "Bearer test-read-token"));
});

test("tree size omission becomes null, never an unverified undefined", async () => {
  const item = fixture();
  const tree = await item.reader.fileAdapter.readTree(ROOT);
  assert.deepEqual(tree.entries[0], {
    path: "docs", mode: "040000", type: "tree", sha: SUBTREE, size: null,
  });
});

test("malformed commit, tree and blob responses fail closed", async () => {
  const cases = [
    ["commit", { sha: COMMIT, tree: { sha: "wrong" } }, "readCommit", COMMIT],
    ["root", { sha: ROOT, truncated: false, tree: [{ path: "docs", mode: "040000",
      type: "tree", sha: SUBTREE, size: -1 }] }, "readTree", ROOT],
    ["subtree", { sha: SUBTREE, truncated: false, tree: [{ path: "guide.md",
      mode: "100644", type: "unknown", sha: "f".repeat(40), size: 3 }] }, "readTree", SUBTREE],
  ];
  for (const [key, response, method, sha] of cases) {
    const item = fixture();
    item.overrides[key] = response;
    await assert.rejects(item.reader.fileAdapter[method](sha),
      (error) => error.code === "invalid_response");
  }
  for (const content of ["a", "YQ==\t", "Y=Q=", "YQ==AAAA", "////"]) {
    const item = fixture("a");
    item.overrides.blob = { sha: item.blobSha, encoding: "base64", size: 1, content };
    await assert.rejects(item.reader.fileAdapter.readBlob(item.blobSha),
      (error) => error.code === "invalid_response");
  }
});

test("oversize metadata and GitHub truncation cannot become verified text", async () => {
  const tooLarge = fixture();
  tooLarge.overrides.subtree = {
    sha: SUBTREE, truncated: false,
    tree: [{ path: "guide.md", mode: "100644", type: "blob",
      sha: tooLarge.blobSha, size: 64 * 1024 + 1 }],
  };
  assert.deepEqual(await verifyAmuxGitHubFileAtCommit(ID, COMMIT, PATH, tooLarge.reader.fileAdapter),
    { status: "reject", reason: "file_too_large" });
  assert(!tooLarge.calls.some(({ path }) => path.includes("/git/blobs/")));

  const truncated = fixture();
  truncated.overrides.root = {
    sha: ROOT, truncated: true,
    tree: [{ path: "docs", mode: "040000", type: "tree", sha: SUBTREE }],
  };
  assert.deepEqual(await verifyAmuxGitHubFileAtCommit(ID, COMMIT, PATH, truncated.reader.fileAdapter),
    { status: "hold", reason: "tree_unverified" });

  const largeBlob = fixture();
  largeBlob.overrides.blob = {
    sha: largeBlob.blobSha, encoding: "base64", size: 64 * 1024 + 1, content: "YQ==",
  };
  await assert.rejects(largeBlob.reader.fileAdapter.readBlob(largeBlob.blobSha),
    (error) => error.code === "invalid_response");

  const largeJson = fixture();
  largeJson.overrides.blob = {
    sha: largeJson.blobSha, encoding: "base64", size: 1,
    content: "x".repeat(300 * 1024),
  };
  await assert.rejects(largeJson.reader.fileAdapter.readBlob(largeJson.blobSha),
    (error) => error.code === "oversized_response");
});

test("a GitHub-shaped blob with altered bytes cannot bypass the Git hash", async () => {
  const item = fixture("genuine");
  const altered = Buffer.from("altered");
  item.overrides.blob = {
    sha: item.blobSha, encoding: "base64", size: altered.byteLength,
    content: altered.toString("base64"),
  };
  // Different size is already held before hashing. With same size, the core
  // must make the decisive content-addressed check.
  const result = await verifyAmuxGitHubFileAtCommit(ID, COMMIT, PATH, item.reader.fileAdapter);
  assert.deepEqual(result, { status: "hold", reason: "blob_digest_mismatch" });
});
