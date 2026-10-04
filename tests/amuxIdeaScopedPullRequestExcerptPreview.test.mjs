import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { prepareAmuxScopedPullRequestExcerptPreview } from "../lib/amux/ideaScopedExcerptPreviewCore.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const SECRET = "s".repeat(32);
const PATH = "docs/guide.md";
const IDENTITY = { fullName: "mposition/Tomverse", id: 25 };
const declared = {
  version: 1, idea: "Review the PR file", repositories: [],
  pullRequests: [{ repository: IDENTITY.fullName, number: 42 }],
};
const source = {
  kind: "pull_request_file", repository: IDENTITY.fullName,
  number: 42, baseSha: BASE, headSha: HEAD, side: "head", path: PATH,
};
const scopeJson = JSON.stringify({ version: 1, sources: [source] });
const identities = new Map([[IDENTITY.fullName.toLowerCase(), IDENTITY]]);
const fileList = {
  status: "complete", repositoryId: 25, number: 42,
  baseSha: BASE, headSha: HEAD, mergeBaseSha: BASE,
  basePaths: [PATH], headPaths: [PATH],
};
const bytes = Buffer.from("alpha\n한국어 beta\n", "utf8");
function candidate(commitSha = HEAD, path = PATH) {
  return {
    status: "unscanned_candidate", inspectedRefs: 1,
    witness: { repositoryId: 25, name: "refs/heads/pr", protected: null,
      refObjectSha: commitSha, refCommitSha: commitSha },
    file: { status: "verified_file", repositoryId: 25, commitSha, path,
      size: bytes.byteLength, text: bytes.toString("utf8"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      blobSha: createHash("sha1").update(`blob ${bytes.byteLength}\0`, "utf8")
        .update(bytes).digest("hex") },
  };
}
const selection = { sourceIndex: 0, candidate: candidate(), fileList,
  startByte: 0, endByte: bytes.byteLength };
const prepare = (overrides = {}) => prepareAmuxScopedPullRequestExcerptPreview(
  overrides.declared ?? declared,
  overrides.scopeJson ?? scopeJson,
  overrides.identities ?? identities,
  "gpt-6-astra", overrides.selections ?? [selection], SECRET,
);

test("PR scope guard binds same-side path, current SHA and exact file bytes", () => {
  const result = prepare();
  assert.equal(result.status, "preview_candidate");
  assert.equal(result.sources[0].path, PATH);
  assert.equal(result.sources[0].excerptText, bytes.toString("utf8"));

  const baseSource = { ...source, side: "base" };
  const base = prepare({ scopeJson: JSON.stringify({ version: 1, sources: [baseSource] }),
    selections: [{ ...selection, candidate: candidate(BASE) }] });
  assert.equal(base.status, "preview_candidate");
});

test("renamed PR file uses old base path and new head path", () => {
  const renamed = { ...fileList,
    basePaths: ["docs/old.md"], headPaths: ["docs/new.md"] };
  const oldSource = { ...source, side: "base", path: "docs/old.md" };
  const old = prepare({ scopeJson: JSON.stringify({ version: 1, sources: [oldSource] }),
    selections: [{ ...selection, fileList: renamed,
      candidate: candidate(BASE, "docs/old.md") }] });
  assert.equal(old.status, "preview_candidate");
  const newSource = { ...source, path: "docs/new.md" };
  const next = prepare({ scopeJson: JSON.stringify({ version: 1, sources: [newSource] }),
    selections: [{ ...selection, fileList: renamed,
      candidate: candidate(HEAD, "docs/new.md") }] });
  assert.equal(next.status, "preview_candidate");
  assert.deepEqual(prepare({ scopeJson: JSON.stringify({ version: 1, sources: [oldSource] }),
    selections: [{ ...selection, fileList: renamed,
      candidate: candidate(BASE, "docs/new.md") }] }),
  { status: "hold", reason: "pr_source_scope_mismatch" });
});

test("PR scope guard holds mismatched witness, source side, SHA and repository", () => {
  for (const changed of [
    { selections: [{ ...selection, fileList: { ...fileList, status: "hold" } }] },
    { selections: [{ ...selection, fileList: undefined }] },
    { selections: [{ ...selection, fileList: { ...fileList, headSha: "c".repeat(40) } }] },
    { selections: [{ ...selection, fileList: { ...fileList, baseSha: "c".repeat(40) } }] },
    { selections: [{ ...selection, fileList: { ...fileList, repositoryId: 26 } }] },
    { selections: [{ ...selection, fileList: { ...fileList,
      mergeBaseSha: "c".repeat(40) } }] },
    { selections: [{ ...selection, fileList: { ...fileList, number: 43 } }] },
    { selections: [{ ...selection, fileList: { ...fileList, headPaths: [] } }] },
    { selections: [{ ...selection, candidate: candidate(BASE) }] },
    { selections: [{ ...selection, candidate: { ...candidate(), witness: {
      ...candidate().witness, repositoryId: 26 } } }] },
    { selections: [{ ...selection, candidate: { status: "hold" } }] },
    { selections: [{ ...selection, candidate: candidate(HEAD, "docs/other.md") }] },
    { identities: new Map([[IDENTITY.fullName.toLowerCase(), { ...IDENTITY, id: 26 }]]) },
    { identities: new Map([[IDENTITY.fullName.toLowerCase(), {
      ...IDENTITY, fullName: "other/Repo" }]]) },
  ]) assert.deepEqual(prepare(changed), { status: "hold", reason: "pr_source_scope_mismatch" });

  const removedHead = { ...fileList, headPaths: [], basePaths: [PATH] };
  const baseSource = { ...source, side: "base" };
  assert.equal(prepare({ scopeJson: JSON.stringify({ version: 1, sources: [baseSource] }),
    selections: [{ ...selection, fileList: removedHead, candidate: candidate(BASE) }] }).status,
  "preview_candidate");
  assert.deepEqual(prepare({ scopeJson: JSON.stringify({ version: 1, sources: [baseSource] }),
    selections: [{ ...selection, fileList: { ...fileList, basePaths: [] },
      candidate: candidate(BASE) }] }),
  { status: "hold", reason: "pr_source_scope_mismatch" });
});

test("PR scope guard holds undeclared source and non-PR selection", () => {
  assert.deepEqual(prepare({ selections: [{ ...selection, sourceIndex: 1 }] }),
    { status: "hold", reason: "scope_selection_unverified" });
  assert.deepEqual(prepare({ identities: {} }),
    { status: "hold", reason: "collector_unverified" });
  assert.equal(prepare({ selections: [] }).status, "reject");
  assert.equal(prepare({ selections: [selection, selection] }).status, "reject");
  assert.equal(prepare({ selections: [
    { ...selection, startByte: 0, endByte: 5 },
    { ...selection, startByte: 6, endByte: bytes.byteLength },
  ] }).status, "preview_candidate");
  const repositorySource = { kind: "repository_file", repository: IDENTITY.fullName,
    commitSha: HEAD, path: PATH };
  const repositoryIdea = { ...declared, repositories: [IDENTITY.fullName] };
  assert.deepEqual(prepare({ declared: repositoryIdea,
    scopeJson: JSON.stringify({ version: 1, sources: [repositorySource] }) }),
  { status: "hold", reason: "not_pr_source" });
});
