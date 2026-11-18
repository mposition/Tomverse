import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  PULL_DIGEST_PATTERN,
  pullChangeDigest,
  pullDiffDigest,
  pullDigestCurrent,
  pullDigestHolds,
  pullDigestVersion,
  readMergedPullChangeDigest,
  readPullChangeDigest,
} from "../lib/pullDiffDigestCore.ts";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const TREE = "3".repeat(40);
const MOVED_BASE = "4".repeat(40);
const MERGE = "5".repeat(40);

test("the v2 formula is pinned to one vector, stored with its v2: prefix", () => {
  // sha256("amux-pull-change-v2\nmerge-base 1…1\nhead 2…2\ntree 3…3\n"), checked with sha256sum.
  assert.equal(pullChangeDigest({ mergeBaseSha: BASE, headSha: HEAD, headTreeSha: TREE }),
    "v2:71c73a79688ebb65b1241e55d96a1928c33b00f5a764c0da39e79f3d06889814");
});

test("each id must be a lowercase 40 hex object id", () => {
  for (const bad of ["", "A".repeat(40), "1".repeat(39), "1".repeat(41), `${"1".repeat(39)}g`, null, 7]) {
    assert.throws(() => pullChangeDigest({ mergeBaseSha: bad, headSha: HEAD, headTreeSha: TREE }), /pull_change_id_invalid/);
    assert.throws(() => pullChangeDigest({ mergeBaseSha: BASE, headSha: bad, headTreeSha: TREE }), /pull_change_id_invalid/);
    assert.throws(() => pullChangeDigest({ mergeBaseSha: BASE, headSha: HEAD, headTreeSha: bad }), /pull_change_id_invalid/);
  }
});

test("a stored digest says its own version", () => {
  const v1 = pullDiffDigest("diff --git a/a b/a\n");
  const v2 = pullChangeDigest({ mergeBaseSha: BASE, headSha: HEAD, headTreeSha: TREE });
  assert.equal(pullDigestVersion(v1), 1);
  assert.equal(pullDigestVersion(v2), 2);
  for (const neither of [null, undefined, "", v1.toUpperCase(), `v1:${v1}`, `v2:${v1.slice(1)}`, `V2:${v1}`, v2.slice(3, 66)]) {
    assert.equal(pullDigestVersion(neither), null);
  }
  // The hex alone, without its prefix, is a v1 value: the prefix is what says v2.
  assert.equal(pullDigestVersion(v2.slice(3)), 1);
  assert.match(v1, PULL_DIGEST_PATTERN);
  assert.match(v2, PULL_DIGEST_PATTERN);
});

test("dual comparison: v1 against v1, v2 against v2, never across", () => {
  const v1 = pullDiffDigest("diff --git a/a b/a\n+x\n");
  const v2 = pullChangeDigest({ mergeBaseSha: BASE, headSha: HEAD, headTreeSha: TREE });
  // A v1 record, as stored before v2, still holds against the v1 diff read now.
  assert.equal(pullDigestHolds(v1, { changeDigest: v2, diffDigest: v1 }), true);
  assert.equal(pullDigestHolds(v1, { changeDigest: v2, diffDigest: pullDiffDigest("other") }), false);
  // It is not read as holding when only v2 was read: not read is null, not a match.
  assert.equal(pullDigestCurrent(v1, { changeDigest: v2 }), null);
  assert.equal(pullDigestHolds(v1, { changeDigest: v2 }), false);
  // A v2 record holds against v2 only.
  assert.equal(pullDigestHolds(v2, { changeDigest: v2, diffDigest: v1 }), true);
  assert.equal(pullDigestHolds(v2, { changeDigest: null, diffDigest: v1 }), false);
  assert.equal(pullDigestCurrent(v2, { diffDigest: v1 }), null);
  // A value of the other version in the wrong slot is never taken.
  assert.equal(pullDigestCurrent(v2, { changeDigest: v1 }), null);
  assert.equal(pullDigestCurrent(v1, { diffDigest: v2 }), null);
  // A stored value of neither version holds against nothing.
  assert.equal(pullDigestHolds("v3:abc", { changeDigest: v2, diffDigest: v1 }), false);
});

test("develop absorbing part of the branch moves the merge base: the same head no longer holds", () => {
  const approved = pullChangeDigest({ mergeBaseSha: BASE, headSha: HEAD, headTreeSha: TREE });
  const now = pullChangeDigest({ mergeBaseSha: MOVED_BASE, headSha: HEAD, headTreeSha: TREE });
  assert.notEqual(now, approved);
  assert.equal(pullDigestHolds(approved, { changeDigest: now }), false);
  // A new head or tree does not hold either.
  assert.equal(pullDigestHolds(approved, { changeDigest:
    pullChangeDigest({ mergeBaseSha: BASE, headSha: "6".repeat(40), headTreeSha: TREE }) }), false);
  assert.equal(pullDigestHolds(approved, { changeDigest:
    pullChangeDigest({ mergeBaseSha: BASE, headSha: HEAD, headTreeSha: "7".repeat(40) }) }), false);
});

/** A GitHub answered from a table of paths; unknown paths fail the read. */
const fakeGitHub = (answers) => {
  const calls = [];
  return {
    calls,
    getJson: async (path) => {
      calls.push(path);
      if (!(path in answers)) throw new Error(`unexpected ${path}`);
      return answers[path];
    },
  };
};

/** A compare answer the size of a large change: many files, binary ones without a patch. */
const bigComparison = (mergeBaseSha) => ({
  status: "ahead",
  merge_base_commit: { sha: mergeBaseSha },
  files: Array.from({ length: 300 }, (_, index) => index % 2 === 0
    ? { filename: `assets/blob-${index}.png`, status: "added" }
    : { filename: `src/file-${index}.ts`, status: "modified", patch: `@@ -1 +1 @@\n-${"a".repeat(40_000)}\n+${"b".repeat(40_000)}` }),
});

test("readPullChangeDigest binds a large, binary change: no size or binary refusal", async () => {
  const github = fakeGitHub({
    [`/compare/develop...${HEAD}?per_page=1&page=1`]: bigComparison(BASE),
    [`/git/commits/${HEAD}`]: { sha: HEAD, tree: { sha: TREE }, parents: [{ sha: BASE }] },
  });
  const change = await readPullChangeDigest(github.getJson, { base: "develop", headSha: HEAD });
  assert.deepEqual(change, { mergeBaseSha: BASE, headSha: HEAD, headTreeSha: TREE,
    digest: pullChangeDigest({ mergeBaseSha: BASE, headSha: HEAD, headTreeSha: TREE }) });
  assert.ok(JSON.stringify(bigComparison(BASE)).length > 1024 * 1024, "the change is past the v1 1 MiB diff limit");
  assert.deepEqual(github.calls, [`/compare/develop...${HEAD}?per_page=1&page=1`, `/git/commits/${HEAD}`]);
});

test("readPullChangeDigest refuses what is not of the expected shape, and never takes a URL or revision syntax", async () => {
  const good = {
    [`/compare/develop...${HEAD}?per_page=1&page=1`]: { status: "ahead", merge_base_commit: { sha: BASE } },
    [`/git/commits/${HEAD}`]: { sha: HEAD, tree: { sha: TREE } },
  };
  const variants = [
    { ...good, [`/compare/develop...${HEAD}?per_page=1&page=1`]: { status: "ahead", merge_base_commit: { sha: "x" } } },
    { ...good, [`/compare/develop...${HEAD}?per_page=1&page=1`]: { status: "weird", merge_base_commit: { sha: BASE } } },
    { ...good, [`/git/commits/${HEAD}`]: { sha: MERGE, tree: { sha: TREE } } },
    { ...good, [`/git/commits/${HEAD}`]: { sha: HEAD, tree: null } },
  ];
  for (const answers of variants) {
    await assert.rejects(readPullChangeDigest(fakeGitHub(answers).getJson, { base: "develop", headSha: HEAD }),
      /pull_change_unreadable/);
  }
  for (const base of ["feature/x", "develop~1", "a..b", "https://evil.test", "", "develop^"]) {
    const github = fakeGitHub(good);
    await assert.rejects(readPullChangeDigest(github.getJson, { base, headSha: HEAD }), /pull_change_unreadable/);
    assert.equal(github.calls.length, 0);
  }
  await assert.rejects(readPullChangeDigest(fakeGitHub(good).getJson, { base: "develop", headSha: "nope" }),
    /pull_change_unreadable/);
});

test("a merged pull request is read against its merge commit's first parent", async () => {
  const github = fakeGitHub({
    [`/git/commits/${MERGE}`]: { sha: MERGE, parents: [{ sha: MOVED_BASE }, { sha: HEAD }] },
    [`/compare/${MOVED_BASE}...${HEAD}?per_page=1&page=1`]: { status: "diverged", merge_base_commit: { sha: BASE } },
    [`/git/commits/${HEAD}`]: { sha: HEAD, tree: { sha: TREE } },
  });
  const change = await readMergedPullChangeDigest(github.getJson, { mergeCommitSha: MERGE, headSha: HEAD });
  // The same digest the open pull request was approved at: develop containing the head does not move it.
  assert.equal(change.digest, pullChangeDigest({ mergeBaseSha: BASE, headSha: HEAD, headTreeSha: TREE }));
  await assert.rejects(readMergedPullChangeDigest(fakeGitHub({ [`/git/commits/${MERGE}`]: { sha: MERGE, parents: [] } }).getJson,
    { mergeCommitSha: MERGE, headSha: HEAD }), /pull_change_unreadable/);
});

test("v1 stays the sha256 of the diff bytes, for records written before v2", () => {
  const bytes = new Uint8Array([0x64, 0x69, 0x66, 0x66, 0xff]);
  assert.equal(pullDiffDigest(bytes), createHash("sha256").update(bytes).digest("hex"));
  assert.equal(pullDiffDigest("abc"), createHash("sha256").update("abc", "utf8").digest("hex"));
});
