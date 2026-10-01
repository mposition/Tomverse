import assert from "node:assert/strict";
import test from "node:test";

import { searchAmuxOwnedRefWitness } from "../lib/amux/ideaOwnedRefSearchCore.ts";

const sha = (letter) => letter.repeat(40);
const target = sha("a");
const head = sha("b");
const tagSha = sha("c");
const limits = { maxPages: 4, maxRefs: 8, maxComparisons: 8, maxTagDepth: 3 };
const page = (refs, hasNextPage = false, endCursor = null) =>
  ({ repositoryId: 25, refs, hasNextPage, endCursor });
const ref = (name, objectSha = head, objectType = "commit") =>
  ({ name, objectSha, objectType, protected: false });
const comparison = (baseSha, headSha, status = "ahead", aheadBy = 1, behindBy = 0) =>
  ({ repositoryId: 25, baseSha, headSha, mergeBaseSha: baseSha, status, aheadBy, behindBy });
const adapter = (overrides = {}) => ({
  listRefs: async (namespace) => page(namespace === "refs/heads/" ? [ref("refs/heads/main")] : []),
  readTag: async () => { throw new Error("unexpected tag"); },
  compareCommits: async (baseSha, headSha) => comparison(baseSha, headSha),
  readRef: async (name) => ({ repositoryId: 25, ...ref(name) }),
  ...overrides,
});

test("finds a repository-owned head witness and re-reads its exact object", async () => {
  const calls = [];
  const result = await searchAmuxOwnedRefWitness(25, target, limits, adapter({
    listRefs: async (namespace, cursor) => {
      calls.push([namespace, cursor]);
      return page([ref("refs/heads/main")]);
    },
  }));
  assert.deepEqual(calls, [["refs/heads/", null]]);
  assert.deepEqual(result, {
    status: "verified_witness",
    witness: {
      repositoryId: 25, name: "refs/heads/main", protected: false,
      refObjectSha: head, refCommitSha: head,
    },
    inspectedRefs: 1,
  });
});

test("searches tags after heads and peels an annotated tag chain", async () => {
  const calls = [];
  const result = await searchAmuxOwnedRefWitness(25, target, limits, adapter({
    listRefs: async (namespace) => {
      calls.push(namespace);
      return page(namespace === "refs/heads/"
        ? [ref("refs/heads/old", head)]
        : [ref("refs/tags/release", tagSha, "tag")]);
    },
    readTag: async (objectSha) => objectSha === tagSha
      ? { repositoryId: 25, sha: tagSha, targetType: "tag", targetSha: sha("d") }
      : { repositoryId: 25, sha: sha("d"), targetType: "commit", targetSha: sha("e") },
    compareCommits: async (baseSha, headSha) => headSha === head
      ? comparison(baseSha, headSha, "behind", 0, 1)
      : comparison(baseSha, headSha, "identical", 0, 0),
    readRef: async (name) => ({ repositoryId: 25, ...ref(name, tagSha, "tag"), protected: null }),
  }));
  assert.deepEqual(calls, ["refs/heads/", "refs/tags/"]);
  assert.equal(result.status, "verified_witness");
  assert.equal(result.witness.refCommitSha, sha("e"));
  assert.equal(result.witness.protected, null);
});

test("no witness or a tag pointing to a tree always holds the excerpt", async () => {
  const noWitness = await searchAmuxOwnedRefWitness(25, target, limits, adapter({
    compareCommits: async (baseSha, headSha) => comparison(baseSha, headSha, "diverged", 3, 4),
  }));
  assert.deepEqual(noWitness, { status: "hold", reason: "no_verified_witness", inspectedRefs: 1 });
  const treeTag = await searchAmuxOwnedRefWitness(25, target, limits, adapter({
    listRefs: async (namespace) => page(namespace === "refs/tags/"
      ? [ref("refs/tags/tree", tagSha, "tag")] : []),
    readTag: async () => ({ repositoryId: 25, sha: tagSha, targetType: "tree", targetSha: sha("e") }),
  }));
  assert.deepEqual(treeTag, { status: "hold", reason: "no_verified_witness", inspectedRefs: 1 });
});

test("pagination gaps, repeated cursors and bounds fail closed", async () => {
  const incomplete = await searchAmuxOwnedRefWitness(25, target, limits, adapter({
    listRefs: async () => page([], true, null),
  }));
  assert.deepEqual(incomplete, { status: "hold", reason: "page_unverified", inspectedRefs: 0 });
  const repeatCursor = await searchAmuxOwnedRefWitness(25, target, limits, adapter({
    listRefs: async () => page([], true, "cursor-one"),
  }));
  assert.deepEqual(repeatCursor, { status: "hold", reason: "page_unverified", inspectedRefs: 0 });
  const capped = await searchAmuxOwnedRefWitness(25, target,
    { ...limits, maxRefs: 1 }, adapter({
      listRefs: async () => page([ref("refs/heads/old"), ref("refs/heads/main")]),
      compareCommits: async (baseSha, headSha) => comparison(baseSha, headSha, "behind", 0, 1),
    }));
  assert.deepEqual(capped, { status: "hold", reason: "search_limit", inspectedRefs: 1 });
});

test("changed refs, mismatched comparisons and API errors cannot become witnesses", async () => {
  const changed = await searchAmuxOwnedRefWitness(25, target, limits, adapter({
    readRef: async (name) => ({ repositoryId: 25, ...ref(name, sha("f")) }),
  }));
  assert.deepEqual(changed, { status: "hold", reason: "ref_changed", inspectedRefs: 1 });
  const mismatch = await searchAmuxOwnedRefWitness(25, target, limits, adapter({
    compareCommits: async () => comparison(sha("f"), head),
  }));
  assert.deepEqual(mismatch, { status: "hold", reason: "comparison_unverified", inspectedRefs: 1 });
  const unavailable = await searchAmuxOwnedRefWitness(25, target, limits, adapter({
    compareCommits: async () => { throw new Error("rate limit"); },
  }));
  assert.deepEqual(unavailable, { status: "hold", reason: "collector_unavailable", inspectedRefs: 1 });
});

test("unowned refs, wrong repository, malformed target and impossible status hold", async () => {
  const unowned = await searchAmuxOwnedRefWitness(25, target, limits, adapter({
    listRefs: async () => page([ref("refs/pull/1/merge")]),
  }));
  assert.deepEqual(unowned, { status: "hold", reason: "page_unverified", inspectedRefs: 0 });
  const wrongRepo = await searchAmuxOwnedRefWitness(25, target, limits, adapter({
    listRefs: async () => ({ ...page([]), repositoryId: 26 }),
  }));
  assert.deepEqual(wrongRepo, { status: "hold", reason: "page_unverified", inspectedRefs: 0 });
  const badTarget = await searchAmuxOwnedRefWitness(25, "deadbeef", limits, adapter());
  assert.deepEqual(badTarget, { status: "hold", reason: "invalid_search_contract", inspectedRefs: 0 });
  const impossible = await searchAmuxOwnedRefWitness(25, target, limits, adapter({
    compareCommits: async (baseSha, headSha) => comparison(baseSha, headSha, "ahead", 0, 0),
  }));
  assert.deepEqual(impossible, { status: "hold", reason: "no_verified_witness", inspectedRefs: 1 });
});

test("a later page can prove reachability but an incomplete later page cannot", async () => {
  const cursors = [];
  const result = await searchAmuxOwnedRefWitness(25, target, limits, adapter({
    listRefs: async (namespace, after) => {
      cursors.push([namespace, after]);
      return after === null
        ? page([ref("refs/heads/old")], true, "next")
        : page([ref("refs/heads/main")]);
    },
    compareCommits: async (baseSha, headSha) => comparison(baseSha, headSha,
      cursors.length === 1 ? "behind" : "ahead", cursors.length === 1 ? 0 : 1,
      cursors.length === 1 ? 1 : 0),
  }));
  assert.equal(result.status, "verified_witness");
  assert.deepEqual(cursors, [["refs/heads/", null], ["refs/heads/", "next"]]);
  const maxPage = await searchAmuxOwnedRefWitness(25, target,
    { ...limits, maxPages: 1 }, adapter({ listRefs: async () => page([], true, "next") }));
  assert.deepEqual(maxPage, { status: "hold", reason: "search_limit", inspectedRefs: 0 });
});

test("tag cycles, excessive depth and mismatched tag observations hold", async () => {
  const tagAdapter = (readTag) => adapter({
    listRefs: async (namespace) => page(namespace === "refs/tags/"
      ? [ref("refs/tags/candidate", tagSha, "tag")] : []),
    readTag,
    readRef: async (name) => ({ repositoryId: 25, ...ref(name, tagSha, "tag") }),
  });
  for (const observation of [
    { repositoryId: 26, sha: tagSha, targetType: "commit", targetSha: head },
    { repositoryId: 25, sha: sha("f"), targetType: "commit", targetSha: head },
    { repositoryId: 25, sha: tagSha, targetType: "commit", targetSha: sha("a") + "f" },
  ]) {
    const result = await searchAmuxOwnedRefWitness(25, target, limits,
      tagAdapter(async () => observation));
    assert.equal(result.status, "hold");
    assert.equal(result.reason, "tag_unverified");
  }
  const cycle = await searchAmuxOwnedRefWitness(25, target, limits,
    tagAdapter(async (objectSha) => ({
      repositoryId: 25, sha: objectSha, targetType: "tag", targetSha: objectSha,
    })));
  assert.deepEqual(cycle, { status: "hold", reason: "tag_unverified", inspectedRefs: 1 });
  const deep = await searchAmuxOwnedRefWitness(25, target,
    { ...limits, maxTagDepth: 1 }, tagAdapter(async (objectSha) => ({
      repositoryId: 25, sha: objectSha, targetType: "tag", targetSha: sha("d"),
    })));
  assert.deepEqual(deep, { status: "hold", reason: "tag_unverified", inspectedRefs: 1 });
});

test("comparison must report resolved target and ref commits", async () => {
  for (const invalid of [
    comparison(sha("f"), head),
    comparison(target, sha("f")),
    { ...comparison(target, head), repositoryId: 26 },
    { ...comparison(target, head), mergeBaseSha: sha("f") },
    comparison(target, head, "ahead", -1, 0),
    comparison(target, head, "unknown", 1, 0),
    comparison(target, head, "ahead", 1, 1),
    comparison(target, head, "identical", 1, 0),
  ]) {
    const result = await searchAmuxOwnedRefWitness(25, target, limits,
      adapter({ compareCommits: async () => invalid }));
    assert.equal(result.status, "hold");
  }
});

test("re-read, list shape and contract anomalies fail closed", async () => {
  for (const refreshed of [
    { repositoryId: 26, ...ref("refs/heads/main") },
    { repositoryId: 25, ...ref("refs/heads/other") },
    { repositoryId: 25, ...ref("refs/heads/main", head, "tag") },
    { repositoryId: 25, ...ref("refs/heads/main"), protected: "unknown" },
  ]) {
    const result = await searchAmuxOwnedRefWitness(25, target, limits,
      adapter({ readRef: async () => refreshed }));
    assert.deepEqual(result, { status: "hold", reason: "ref_changed", inspectedRefs: 1 });
  }
  for (const malformed of [
    page([ref("refs/heads/main", head, "tag")]),
    page([ref("refs/tags/wrong-namespace")]),
    page([ref("refs/heads/main"), ref("refs/heads/main")]),
    { ...page([]), hasNextPage: "yes" },
    { ...page([]), endCursor: "" },
  ]) {
    const result = await searchAmuxOwnedRefWitness(25, target, limits,
      adapter({
        listRefs: async () => malformed,
        compareCommits: async (baseSha, headSha) => comparison(baseSha, headSha, "behind", 0, 1),
      }));
    assert.equal(result.status, "hold");
  }
  for (const invalid of [0, -1, 1.5]) {
    const result = await searchAmuxOwnedRefWitness(25, target,
      { ...limits, maxRefs: invalid }, adapter());
    assert.deepEqual(result, { status: "hold", reason: "invalid_search_contract", inspectedRefs: 0 });
  }
  assert.equal((await searchAmuxOwnedRefWitness(0, target, limits, adapter())).status, "hold");
  assert.equal((await searchAmuxOwnedRefWitness(25, target, limits,
    { ...adapter(), readRef: undefined })).status, "hold");
});

test("SHA-256 witnesses work, but mixed hash lengths do not", async () => {
  const target256 = sha("a") + sha("a").slice(0, 24);
  const head256 = sha("b") + sha("b").slice(0, 24);
  const result = await searchAmuxOwnedRefWitness(25, target256, limits, adapter({
    listRefs: async (namespace) => page(namespace === "refs/heads/"
      ? [ref("refs/heads/sha256", head256)] : []),
    readRef: async (name) => ({ repositoryId: 25, ...ref(name, head256) }),
  }));
  assert.equal(result.status, "verified_witness");
  const mixed = await searchAmuxOwnedRefWitness(25, target256, limits, adapter());
  assert.deepEqual(mixed, { status: "hold", reason: "ref_unverified", inspectedRefs: 1 });
});
