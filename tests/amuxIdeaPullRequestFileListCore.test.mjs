import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_V4_PR_FILE_LIST_MAX,
  amuxPullRequestSourceInFileList,
  inspectAmuxPullRequestFileList,
} from "../lib/amux/ideaPullRequestFileListCore.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const expectedRepository = { fullName: "mposition/Tomverse", id: 25 };
const snapshot = {
  repositoryId: 25, number: 42, baseRepositoryId: 25, headRepositoryId: 25,
  baseSha: BASE, headSha: HEAD, changedFiles: 3,
};
const page = {
  page: 1, perPage: AMUX_V4_PR_FILE_LIST_MAX, hasNext: false,
  files: [
    { filename: "docs/guide.md", status: "modified", previousFilename: null },
    { filename: "src/new.ts", status: "added", previousFilename: null },
    { filename: "docs/new-name.md", status: "renamed", previousFilename: "docs/old-name.md" },
  ],
};

test("stable complete PR observations produce side-aware changed paths", () => {
  const result = inspectAmuxPullRequestFileList(snapshot, page, { ...snapshot });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.basePaths, ["docs/guide.md", "docs/old-name.md"]);
  assert.deepEqual(result.headPaths, ["docs/guide.md", "docs/new-name.md", "src/new.ts"]);
  const source = { kind: "pull_request_file", repository: "mposition/Tomverse",
    number: 42, baseSha: BASE, headSha: HEAD, side: "head", path: "docs/new-name.md" };
  assert.equal(amuxPullRequestSourceInFileList(source, result, expectedRepository), true);
  assert.equal(amuxPullRequestSourceInFileList({ ...source, path: "docs/old-name.md" }, result,
    expectedRepository), false);
  assert.equal(amuxPullRequestSourceInFileList({ ...source, side: "base", path: "docs/old-name.md" },
    result, expectedRepository), true);
  assert.equal(amuxPullRequestSourceInFileList({ ...source, side: "base", path: "src/new.ts" },
    result, expectedRepository), false);
  for (const invalid of [
    { ...source, side: "other" }, { ...source, repository: "other/Repo" },
    { ...source, number: 43 }, { ...source, baseSha: "c".repeat(40) },
    { ...source, headSha: "c".repeat(40) },
  ]) assert.equal(amuxPullRequestSourceInFileList(invalid, result, expectedRepository), false);
  assert.equal(amuxPullRequestSourceInFileList(source, result,
    { ...expectedRepository, id: 26 }), false);
});

test("changed count, pagination and moving PR snapshots hold", () => {
  for (const [before, files, after, reason] of [
    [{ ...snapshot, changedFiles: 101 }, page, snapshot, "pr_snapshot_unverified"],
    [snapshot, { ...page, hasNext: true }, snapshot, "file_list_incomplete"],
    [snapshot, { ...page, files: page.files.slice(0, 2) }, snapshot, "file_list_incomplete"],
    [snapshot, { ...page, page: 2 }, snapshot, "file_list_incomplete"],
    [snapshot, { ...page, perPage: 30 }, snapshot, "file_list_incomplete"],
    [snapshot, page, { ...snapshot, headSha: "c".repeat(40) }, "pr_snapshot_unverified"],
    [snapshot, page, { ...snapshot, changedFiles: 2 }, "pr_snapshot_unverified"],
    [{ ...snapshot, headRepositoryId: 26 }, page, snapshot, "pr_snapshot_unverified"],
    [{ ...snapshot, headSha: "b".repeat(64) }, page, snapshot, "pr_snapshot_unverified"],
    [{ ...snapshot, changedFiles: 0 }, page, snapshot, "pr_snapshot_unverified"],
  ]) assert.deepEqual(inspectAmuxPullRequestFileList(before, files, after),
    { status: "hold", reason });
});

test("unsafe paths, duplicate entries and unknown statuses hold", () => {
  for (const [file, reason] of [
    [{ ...page.files[0], filename: "../escape" }, "file_list_invalid"],
    [{ ...page.files[0], filename: "docs\\escape" }, "file_list_invalid"],
    [{ ...page.files[0], status: "copied" }, "file_status_unverified"],
    [{ ...page.files[0], status: "renamed", previousFilename: null }, "file_list_invalid"],
    [{ ...page.files[0], status: "modified", previousFilename: "old.md" }, "file_list_invalid"],
    [{ ...page.files[0], filename: "docs/\u202eevil.md" }, "file_list_invalid"],
    [{ ...page.files[0], previousFilename: undefined }, "file_list_invalid"],
  ]) {
    const altered = { ...page, files: [file, ...page.files.slice(1)] };
    assert.deepEqual(inspectAmuxPullRequestFileList(snapshot, altered, snapshot),
      { status: "hold", reason });
  }
  const duplicate = { ...page, files: [page.files[0], page.files[0], page.files[2]] };
  assert.deepEqual(inspectAmuxPullRequestFileList(snapshot, duplicate, snapshot),
    { status: "hold", reason: "file_list_invalid" });
  const duplicateBase = { ...page, files: [
    { filename: "docs/old-name.md", status: "removed", previousFilename: null },
    page.files[1], page.files[2],
  ] };
  assert.deepEqual(inspectAmuxPullRequestFileList(snapshot, duplicateBase, snapshot),
    { status: "hold", reason: "file_list_invalid" });
  const validPathReuse = { ...page, files: [
    { filename: "docs/old-name.md", status: "added", previousFilename: null },
    page.files[1], page.files[2],
  ] };
  assert.equal(inspectAmuxPullRequestFileList(snapshot, validPathReuse, snapshot).status, "complete");
});

test("the one-page 100-file bound accepts only a complete page", () => {
  const files = Array.from({ length: 100 }, (_, index) => ({
    filename: `src/file-${index}.ts`, status: "modified", previousFilename: null,
  }));
  const hundred = { ...snapshot, changedFiles: 100 };
  const complete = inspectAmuxPullRequestFileList(hundred,
    { page: 1, perPage: 100, hasNext: false, files }, hundred);
  assert.equal(complete.status, "complete");
  assert.equal(complete.basePaths.length, 100);
  assert.equal(complete.headPaths.length, 100);
});
