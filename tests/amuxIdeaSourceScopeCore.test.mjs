import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_IDEA_SOURCE_SCOPE_MAX_FILES,
  inspectAmuxIdeaSourceScope,
} from "../lib/amux/ideaSourceScopeCore.ts";
import { openAmuxContent, sealAmuxContent } from "../lib/amux/ideaCrypto.ts";

const a = "a".repeat(40);
const b = "b".repeat(40);
const declared = {
  version: 1,
  idea: "Improve AMUX source analysis",
  repositories: ["mposition/Tomverse"],
  pullRequests: [{ repository: "mposition/Tomverse", number: 42 }],
};

const repoFile = (path = "lib/amux/ideaInputCore.ts") => ({
  kind: "repository_file", repository: "MPOSITION/Tomverse", commitSha: a, path,
});
const prFile = (path = "app/api/admin/amux/route.ts") => ({
  kind: "pull_request_file", repository: "mposition/Tomverse", number: 42,
  baseSha: a, headSha: b, side: "head", path,
});
const scope = (sources) => JSON.stringify({ version: 1, sources });

test("exact-file source proposal is canonical and remains unverified", () => {
  const first = inspectAmuxIdeaSourceScope(scope([prFile(), repoFile()]), declared);
  const second = inspectAmuxIdeaSourceScope(scope([repoFile(), prFile()]), declared);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.canonicalJson, second.canonicalJson);
  assert.equal(first.fileCount, 2);
  assert.equal(first.collectionVerified, false);
  const proposal = JSON.parse(first.canonicalJson);
  assert.equal(proposal.sources[0].repository, "mposition/Tomverse");
  assert.equal(first.canonicalJson.includes("MPOSITION/Tomverse"), false);
  assert.equal(proposal.sources.find((source) => source.kind === "pull_request_file").headSha, b);
  assert.equal(proposal.sources.find((source) => source.kind === "pull_request_file").side, "head");
  const baseSide = inspectAmuxIdeaSourceScope(scope([{ ...prFile(), side: "base" }]), declared);
  assert.equal(baseSide.ok, true);
  assert.notEqual(baseSide.canonicalJson, inspectAmuxIdeaSourceScope(scope([prFile()]), declared).canonicalJson);
});

test("scope refuses extra repositories, PRs, schema keys and duplicate files", () => {
  assert.deepEqual(inspectAmuxIdeaSourceScope(scope([repoFile()]), { ...declared, repositories: [] }),
    { ok: false, code: "outside_idea_sources" });
  assert.deepEqual(inspectAmuxIdeaSourceScope(scope([prFile()]), { ...declared, pullRequests: [] }),
    { ok: false, code: "outside_idea_sources" });
  assert.deepEqual(inspectAmuxIdeaSourceScope(scope([repoFile(), repoFile()]), declared),
    { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectAmuxIdeaSourceScope(scope([{ ...repoFile(), url: "https://example.invalid" }]), declared),
    { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectAmuxIdeaSourceScope(scope([{ ...prFile(), number: 43 }]), declared),
    { ok: false, code: "outside_idea_sources" });
  assert.deepEqual(inspectAmuxIdeaSourceScope(scope([{ ...prFile(), side: "diff" }]), declared),
    { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectAmuxIdeaSourceScope(scope([repoFile()]), {
    ...declared, repositories: ["mposition/Tomverse", "MPOSITION/tomverse"],
  }), { ok: false, code: "schema_rejected" });
});

test("scope refuses traversal, glob, mutable refs, ambiguous paths and unbounded lists", () => {
  for (const path of ["../secrets", "a/../b", "a//b", "/a", "a/", "a\\b", "*.ts", "a b", "a/%2e%2e/b", ".git/config"]) {
    assert.deepEqual(inspectAmuxIdeaSourceScope(scope([repoFile(path)]), declared),
      { ok: false, code: "schema_rejected" }, path);
  }
  assert.deepEqual(inspectAmuxIdeaSourceScope(scope([{ ...repoFile(), commitSha: "develop" }]), declared),
    { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectAmuxIdeaSourceScope(scope([{ ...prFile(), headSha: "main" }]), declared),
    { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectAmuxIdeaSourceScope(scope([{ ...prFile(), headSha: b.toUpperCase() }]), declared),
    { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectAmuxIdeaSourceScope(scope([{ ...prFile(), number: 42.5 }]), declared),
    { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectAmuxIdeaSourceScope(scope([{ ...prFile(), number: 0 }]), declared),
    { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectAmuxIdeaSourceScope(scope([]), declared),
    { ok: false, code: "metadata_incomplete" });
  const many = Array.from({ length: AMUX_IDEA_SOURCE_SCOPE_MAX_FILES + 1 }, (_, i) => repoFile(`lib/f${i}.ts`));
  assert.deepEqual(inspectAmuxIdeaSourceScope(scope(many), declared),
    { ok: false, code: "too_large" });
});

test("private source scope can only be decrypted under its own purpose and id", () => {
  const checked = inspectAmuxIdeaSourceScope(scope([repoFile()]), declared);
  assert.equal(checked.ok, true);
  const keys = {
    masterKeyId: "test", masterKeyVersion: 1, masterKey: Buffer.alloc(32, 3),
    digestKeyId: "digest", digestKey: Buffer.alloc(32, 4),
  };
  const canonicalBytes = Buffer.from(checked.canonicalJson, "utf8");
  const sealed = sealAmuxContent(canonicalBytes, "source_scope", "scope-test-1", keys);
  assert.deepEqual(openAmuxContent(sealed, "source_scope", "scope-test-1", keys), canonicalBytes);
  assert.throws(() => openAmuxContent(sealed, "idea_raw", "scope-test-1", keys));
  assert.throws(() => openAmuxContent(sealed, "source_scope", "scope-test-2", keys));
  assert.equal(sealed.ciphertext.includes(canonicalBytes), false);
});

test("claimed PR SHAs remain pending collector verification, never approved by syntax alone", () => {
  const unverified = inspectAmuxIdeaSourceScope(scope([{ ...prFile(), headSha: "c".repeat(40) }]), declared);
  assert.equal(unverified.ok, true);
  assert.equal(unverified.collectionVerified, false);
  assert.equal(JSON.parse(unverified.canonicalJson).sources[0].headSha, "c".repeat(40));
});
