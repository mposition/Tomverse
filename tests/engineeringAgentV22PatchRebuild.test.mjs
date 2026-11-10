import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { loadEngineeringAgentV22Candidate } from
  "../lib/engineeringAgentV22CandidateLoad.ts";
import { applyV22FileDiff, parseV22GitDiff } from
  "../lib/engineeringAgentV22PatchApply.ts";
import { loadEngineeringAgentV22StoredCandidate } from
  "../lib/engineeringAgentV22StoredCandidate.ts";

// A real repository, so each case checks the rebuilt tree against the tree
// git itself writes for the same change (what the publisher pushes).
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "v22-rebuild-"));
  const git = (...args) => execFileSync("git", ["-c", "core.autocrlf=false",
    "-c", "user.name=t", "-c", "user.email=t@example.invalid",
    "-c", "commit.gpgsign=false", "-C", dir, ...args],
  { maxBuffer: 16 * 1024 * 1024 });
  const write = (entries) => {
    for (const [path, content] of Object.entries(entries)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  };
  git("init", "-q");
  write(files);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const baseSha = git("rev-parse", "HEAD").toString().trim();
  const rootTreeId = git("rev-parse", "HEAD^{tree}").toString().trim();
  const base = git("ls-tree", "-r", "-t", "-z", "HEAD").toString()
    .split("\0").filter(Boolean).map((line) => {
      const [meta, path] = line.split("\t");
      const [mode, type, oid] = meta.split(" ");
      return { path, mode, type, oid };
    });
  const reads = [];
  const ports = {
    readBase: async (sha) => {
      assert.equal(sha, baseSha);
      return { base, rootTreeId, baseGitattributes: null,
        baseCommitterDate: "1791336934 +1000" };
    },
    readBlob: async (oid) => {
      reads.push(oid);
      return new Uint8Array(git("cat-file", "blob", oid));
    },
  };
  // The diff the sidecar stores, and the tree git writes for the change.
  const change = (entries) => {
    write(entries);
    const patchText = git("diff", "--binary", "--no-ext-diff",
      "--no-textconv", "--no-renames", "HEAD", "--").toString("utf8");
    git("add", "-A");
    const treeId = git("write-tree").toString().trim();
    return { patchText, treeId };
  };
  return { dir, git, baseSha, ports, reads, change,
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const sourceFile = (name, lines) => Array.from({ length: lines }, (_, i) =>
  `export const ${name}Value${i} = "${name}-${i}-${"x".repeat(18)}";\n`)
  .join("");

const edited = (text, name) => text
  .replace(`${name}Value3 = `, `${name}Value3 = /* changed */ `)
  .replace(`${name}Value120 = `, `${name}Value120 = /* changed */ `)
  .concat(`export const ${name}Added = true;\n`);

// AMUX-FILEGEN-003 (2026-11-10): three sources and their tests, about 75 KB
// of original bytes. The sidecar stored only the diff text for it.
const filegenPaths = [
  "lib/chatStreamConsumer.ts", "lib/generatedArtifactToolPolicy.ts",
  "lib/webSearchStreamTrailer.ts", "tests/chatStreamConsumer.test.mjs",
  "tests/generatedArtifactToolPolicy.test.mjs",
  "tests/webSearchStreamTrailer.test.mjs",
];

test("a six-file, 75 KB patch with no stored file bytes becomes a candidate with git's own tree", async () => {
  const files = Object.fromEntries(filegenPaths.map((path, index) =>
    [path, sourceFile(`f${index}`, 240)]));
  const total = Object.values(files).reduce((sum, text) =>
    sum + Buffer.byteLength(text), 0);
  assert.ok(total > 74 * 1024 && total < 80 * 1024, `fixture is ${total} bytes`);
  const fixture = repo(files);
  try {
    const { patchText, treeId } = fixture.change(Object.fromEntries(
      filegenPaths.map((path, index) =>
        [path, edited(files[path], `f${index}`)])));
    assert.ok(Buffer.byteLength(patchText) < 64 * 1024);
    const result = await loadEngineeringAgentV22Candidate({
      baseSha: fixture.baseSha, patchText }, fixture.ports);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.expectedTreeId, treeId);
    assert.deepEqual(result.changes.map((entry) => entry.path).sort(),
      [...filegenPaths].sort());
    assert.equal(fixture.reads.length, 6);
  } finally { fixture.cleanup(); }
});

test("the stored candidate hands a file-less patch to the loader as text", async () => {
  const snapshot = { runId: "123456789012", taskId: "task-1",
    baseSha: "a".repeat(40) };
  const text = "diff --git a/file.ts b/file.ts\n";
  let seen = null;
  const result = await loadEngineeringAgentV22StoredCandidate(
    "29cf907f-2741-4dd1-b6d4-d85c881eb357", {
      readSnapshot: async () => snapshot,
      readPatch: async () => ({ text, files: null, sha256: "b".repeat(64),
        baseSha: snapshot.baseSha }),
      readConsent: async () => true, readSwitch: async () => true,
      publicationEnabled: () => true,
      loadCandidate: async (input) => { seen = input;
        return { ok: false, reason: "patch_does_not_apply" }; },
    });
  assert.deepEqual(seen, { baseSha: snapshot.baseSha, patchText: text });
  assert.deepEqual(result, { ok: false, reason: "patch_does_not_apply" });
});

test("a last line without a newline, CRLF lines and a byte order mark survive exactly", async () => {
  const files = {
    "lib/noEol.ts": "export const a = 1;\nexport const b = 2;",
    "lib/crlf.ts": "export const c = 1;\r\nexport const d = 2;\r\n",
    "lib/bom.ts": "﻿export const e = 1;\nexport const f = 2;\n",
  };
  const fixture = repo(files);
  try {
    const { patchText, treeId } = fixture.change({
      "lib/noEol.ts": "export const a = 1;\nexport const b = 3;\n",
      "lib/crlf.ts": "export const c = 1;\r\nexport const d = 3;\r\n",
      "lib/bom.ts": "﻿export const e = 2;\nexport const f = 2;",
    });
    const result = await loadEngineeringAgentV22Candidate({
      baseSha: fixture.baseSha, patchText }, fixture.ports);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.expectedTreeId, treeId);
  } finally { fixture.cleanup(); }
});

test("a patch that does not apply exactly, or names another result, is refused", async () => {
  const files = { "lib/a.ts": sourceFile("a", 40) };
  const fixture = repo(files);
  try {
    const { patchText } = fixture.change({ "lib/a.ts": edited(files["lib/a.ts"], "a") });
    const load = (text) => loadEngineeringAgentV22Candidate({
      baseSha: fixture.baseSha, patchText: text }, fixture.ports);
    // A context line the base does not have.
    assert.deepEqual(await load(patchText.replace(" export const aValue1 =",
      " export const aValueX =")), { ok: false, reason: "patch_does_not_apply" });
    // A hunk moved by one line: no offset, no fuzz.
    assert.deepEqual(await load(patchText.replace(/@@ -(\d+)/, (_, n) =>
      `@@ -${Number(n) + 1}`)), { ok: false, reason: "patch_does_not_apply" });
    // An added line changed after the diff named its result blob.
    assert.deepEqual(await load(patchText.replace("+export const aAdded = true;",
      "+export const aAdded = false;")), { ok: false,
      reason: "patch_does_not_apply" });
    // A diff of some other base blob.
    assert.deepEqual(await load(patchText.replace(/^index [0-9a-f]+/m,
      "index 1111111")), { ok: false, reason: "base_blob_missing" });
    // Trailing text after the last hunk.
    assert.deepEqual(await load(`${patchText}+export const extra = 1;\n`),
      { ok: false, reason: "patch_unsupported" });
  } finally { fixture.cleanup(); }
});

test("rebuilt bytes go through the same secret check as stored bytes", async () => {
  const files = { "lib/config.ts": sourceFile("c", 20) };
  const fixture = repo(files);
  try {
    // Built at run time, so no scanner reads a credential-shaped literal here.
    const token = ["gh", "p_", "Q".repeat(36)].join("");
    const { patchText } = fixture.change({ "lib/config.ts":
      `${files["lib/config.ts"]}export const leaked = "${token}";\n` });
    assert.deepEqual(await loadEngineeringAgentV22Candidate({
      baseSha: fixture.baseSha, patchText }, fixture.ports),
    { ok: false, reason: "files_invalid" });
  } finally { fixture.cleanup(); }
});

test("new, deleted, renamed-mode and binary files are refused before any GitHub read", async () => {
  const files = { "lib/a.ts": "export const a = 1;\n",
    "lib/b.ts": "export const b = 1;\n", "lib/c.ts": "export const c = 1;\n" };
  const fixture = repo(files);
  try {
    let reads = 0;
    const ports = { readBase: async () => { reads++; throw new Error("read"); },
      readBlob: async () => { reads++; throw new Error("read"); } };
    const refused = async (patchText) => assert.deepEqual(
      await loadEngineeringAgentV22Candidate({ baseSha: fixture.baseSha,
        patchText }, ports), { ok: false, reason: "patch_unsupported" });
    writeFileSync(join(fixture.dir, "lib/new.ts"), "export const n = 1;\n");
    fixture.git("add", "-N", "lib/new.ts");
    const diff = (...args) => fixture.git("diff", "--binary", "--no-renames",
      ...args, "HEAD", "--").toString("utf8");
    await refused(diff());
    fixture.git("reset", "-q", "--", "lib/new.ts");
    rmSync(join(fixture.dir, "lib/new.ts"));
    rmSync(join(fixture.dir, "lib/b.ts"));
    await refused(diff());
    fixture.git("checkout", "--", "lib/b.ts");
    writeFileSync(join(fixture.dir, "lib/c.ts"), Buffer.from([0, 1, 2, 3]));
    await refused(diff());
    fixture.git("checkout", "--", "lib/c.ts");
    await refused("diff --git a/lib/a.ts b/lib/a.ts\nold mode 100644\n" +
      "new mode 100755\n");
    await refused("");
    assert.equal(reads, 0);
  } finally { fixture.cleanup(); }
});

test("the parser and applier refuse unsafe paths and shapes", () => {
  const oid = (c) => c.repeat(40);
  const header = (path) => `diff --git a/${path} b/${path}\n` +
    `index ${oid("1")}..${oid("2")} 100644\n--- a/${path}\n+++ b/${path}\n`;
  assert.equal(parseV22GitDiff(`${header("../x.ts")}@@ -1 +1 @@\n-a\n+b\n`).ok,
    false);
  assert.equal(parseV22GitDiff(`${header("x.ts")}@@ -1 +1 @@\n-a\n+b\n` +
    `${header("x.ts")}@@ -1 +1 @@\n-a\n+b\n`).ok, false);
  assert.equal(parseV22GitDiff(`${header("x.ts")}@@ -1 +1 @@\n-a\n`).ok, false);
  assert.equal(parseV22GitDiff(`${header("x.ts")}@@ -1 +1 @@\n-a\n\n`).ok,
    false);
  const parsed = parseV22GitDiff(`${header("x.ts")}@@ -1 +1 @@\n-a\n+b\n`);
  assert.equal(parsed.ok, true);
  // The base blob is not the one the diff names.
  assert.equal(applyV22FileDiff(Buffer.from("a\n"), parsed.files[0]), null);
});
