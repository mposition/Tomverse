import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { prepareAmuxScopedRepositoryExcerptPreview } from "../lib/amux/ideaScopedExcerptPreviewCore.ts";

const COMMIT = "a".repeat(40);
const REF = "b".repeat(40);
const SECRET = "s".repeat(32);
const declared = { version: 1, idea: "Review this file", repositories: ["mposition/Tomverse"], pullRequests: [] };
const source = { kind: "repository_file", repository: "mposition/Tomverse",
  commitSha: COMMIT, path: "docs/guide.md" };
const scopeJson = JSON.stringify({ version: 1, sources: [source] });
const repositoryIds = new Map([["mposition/tomverse", 25]]);
const bytes = Buffer.from("alpha\n한국어 beta\n", "utf8");
const candidate = {
  status: "unscanned_candidate", inspectedRefs: 1,
  witness: { repositoryId: 25, name: "refs/heads/main", protected: null,
    refObjectSha: REF, refCommitSha: REF },
  file: { status: "verified_file", repositoryId: 25, commitSha: COMMIT,
    path: "docs/guide.md", size: bytes.byteLength, text: bytes.toString("utf8"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    blobSha: createHash("sha1").update(`blob ${bytes.byteLength}\0`, "utf8")
      .update(bytes).digest("hex") },
};
const selection = { sourceIndex: 0, candidate, startByte: 0, endByte: bytes.byteLength };
const prepare = (overrides = {}) => prepareAmuxScopedRepositoryExcerptPreview(
  Object.hasOwn(overrides, "declared") ? overrides.declared : declared,
  overrides.scopeJson ?? scopeJson,
  overrides.repositoryIds ?? repositoryIds, "gpt-6-astra",
  overrides.selections ?? [selection], SECRET,
);

test("scope guard binds a verified repository file candidate before preview", () => {
  const result = prepare();
  assert.equal(result.status, "preview_candidate");
  assert.equal(result.sources[0].path, source.path);
  assert.equal(result.sources[0].excerptText, candidate.file.text);
});

test("scope guard refuses mismatched file, commit, repository identity and undeclared source", () => {
  for (const [changed, reason] of [
    [{ selections: [{ ...selection, candidate: { ...candidate, file: { ...candidate.file,
      path: "docs/other.md" } } }] }, "source_scope_mismatch"],
    [{ selections: [{ ...selection, candidate: { ...candidate, file: { ...candidate.file,
      commitSha: "c".repeat(40) } } }] }, "source_scope_mismatch"],
    [{ repositoryIds: new Map([["mposition/tomverse", 26]]) }, "source_scope_mismatch"],
    [{ repositoryIds: new Map([["mposition/Tomverse", 25]]) }, "source_scope_mismatch"],
    [{ selections: [{ ...selection, candidate: { ...candidate, witness: {
      ...candidate.witness, repositoryId: 26,
    } } }] }, "source_scope_mismatch"],
    [{ selections: [{ ...selection, candidate: undefined }] }, "source_scope_mismatch"],
    [{ selections: [{ ...selection, candidate: { status: "hold" } }] }, "source_scope_mismatch"],
    [{ scopeJson: JSON.stringify({ version: 1, sources: [{ ...source,
      repository: "other/Repo" }] }) }, "scope_unverified"],
  ]) assert.deepEqual(prepare(changed), { status: "hold", reason });
});

test("scope guard holds unverified index, PR source and forged idea", () => {
  assert.deepEqual(prepare({ selections: [{ ...selection, sourceIndex: 1 }] }),
    { status: "hold", reason: "scope_selection_unverified" });
  for (const sourceIndex of [-1, 0.5, NaN]) {
    assert.deepEqual(prepare({ selections: [{ ...selection, sourceIndex }] }),
      { status: "hold", reason: "scope_selection_unverified" });
  }
  assert.deepEqual(prepare({ repositoryIds: {} }),
    { status: "hold", reason: "collector_unverified" });
  assert.deepEqual(prepare({ selections: {} }),
    { status: "hold", reason: "collector_unverified" });
  assert.deepEqual(prepare({ declared: undefined }),
    { status: "hold", reason: "idea_unverified" });
  assert.equal(prepare({ selections: [] }).status, "reject");
  const prIdea = { ...declared, pullRequests: [{ repository: "mposition/Tomverse", number: 1 }] };
  const prScope = JSON.stringify({ version: 1, sources: [{
    kind: "pull_request_file", repository: "mposition/Tomverse", number: 1,
    baseSha: COMMIT, headSha: REF, side: "head", path: "docs/guide.md",
  }] });
  assert.deepEqual(prepare({ declared: prIdea, scopeJson: prScope }),
    { status: "hold", reason: "pr_collection_unavailable" });
  assert.deepEqual(prepare({ declared: { ...declared, idea: "" } }),
    { status: "hold", reason: "idea_unverified" });
});
