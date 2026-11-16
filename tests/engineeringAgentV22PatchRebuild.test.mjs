import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { CONVENTION_VERSIONS } from "../lib/agentAuthorityFiles.ts";
import { decideTier } from "../lib/agentPushPolicy.ts";
import { loadEngineeringAgentV22Candidate } from
  "../lib/engineeringAgentV22CandidateLoad.ts";
import { applyV22FileDiff, parseV22GitDiff } from
  "../lib/engineeringAgentV22PatchApply.ts";
import { loadEngineeringAgentV22StoredCandidate } from
  "../lib/engineeringAgentV22StoredCandidate.ts";
import { gitObjectId } from "../lib/engineeringAgentTreeVerify.ts";

// Owner decision 2026-11-15: whatever change a worker's CLI makes, git's own
// diff of it becomes a candidate, and the candidate's tree is the one the
// publisher's `git apply --cached` writes. Every case here checks the rebuilt
// tree against both, in a real repository.

const GIT = ["-c", "core.autocrlf=false", "-c", "core.ignorecase=false",
  "-c", "user.name=t", "-c", "user.email=t@example.invalid",
  "-c", "commit.gpgsign=false"];

/** A repository whose base is built through the index, so modes Windows
 * cannot make in a checkout (executables, symlinks) are still git's own. */
function repo(entries) {
  const dir = mkdtempSync(join(tmpdir(), "v22-rebuild-"));
  const run = (env, args, input) => execFileSync("git", [...GIT, "-C", dir,
    ...args], { env, input, maxBuffer: 512 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  const git = (...args) => run(process.env, args);
  git("init", "-q");
  const put = (path, content, mode = "100644") => {
    const oid = run(process.env, ["hash-object", "-w", "--stdin"],
      Buffer.from(content)).toString().trim();
    git("update-index", "--add", "--cacheinfo", `${mode},${oid},${path}`);
  };
  const remove = (path) => git("update-index", "--force-remove", "--", path);
  for (const [path, value] of Object.entries(entries)) {
    if (Array.isArray(value)) put(path, value[0], value[1]);
    else put(path, value);
  }
  const rootTreeId = git("write-tree").toString().trim();
  const baseSha = git("commit-tree", rootTreeId, "-m", "base").toString().trim();
  git("update-ref", "HEAD", baseSha);
  git("checkout", "-q", "-f", baseSha);
  const base = git("ls-tree", "-r", "-t", "-z", baseSha).toString()
    .split("\0").filter(Boolean).map((line) => {
      const [meta, path] = line.split("\t");
      const [mode, type, oid] = meta.split(" ");
      return { path, mode, type, oid };
    });
  const attributes = base.find((entry) => entry.path === ".gitattributes");
  const reads = [];
  const ports = {
    readBase: async (sha) => {
      assert.equal(sha, baseSha);
      return { base, rootTreeId, baseCommitterDate: "1791336934 +1000",
        baseGitattributes: attributes ? git("cat-file", "blob",
          attributes.oid).toString("utf8") : null };
    },
    // A fresh copy each read: the loader wipes what it read when done.
    readBlob: async (oid) => {
      reads.push(oid);
      return new Uint8Array(git("cat-file", "blob", oid));
    },
  };
  // The publisher's own steps (scripts/engineering-agent-publisher.mjs,
  // `build`): a fresh index at the base, `git apply --cached`, `write-tree`.
  // Null when git refuses the patch.
  const publisherTree = (patchText) => {
    const index = join(dir, ".git", "publisher-index");
    const patchFile = join(dir, ".git", "publisher.patch");
    writeFileSync(patchFile, patchText, "utf8");
    const env = { ...process.env, GIT_INDEX_FILE: index };
    try {
      run(env, ["read-tree", baseSha]);
      try { run(env, ["apply", "--cached", patchFile]); }
      catch { return null; }
      return run(env, ["write-tree"]).toString().trim();
    } finally { rmSync(index, { force: true }); rmSync(patchFile); }
  };
  // The diff the sidecar stores for a checkout change: new files marked
  // intent-to-add first, `git diff --binary --no-renames HEAD`.
  const changeFiles = (files, removed = []) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    for (const path of removed) rmSync(join(dir, path));
    const untracked = git("ls-files", "--others", "--exclude-standard", "-z")
      .toString("utf8").split("\0").filter(Boolean);
    if (untracked.length) git("add", "-N", "--", ...untracked);
    const patchText = git("diff", "--binary", "--no-ext-diff",
      "--no-textconv", "--no-renames", "HEAD", "--").toString("utf8");
    git("add", "-A");
    const treeId = git("write-tree").toString().trim();
    git("reset", "-q", "--hard", baseSha);
    git("clean", "-qfd");
    return { patchText, treeId, publisherTreeId: publisherTree(patchText) };
  };
  // The same diff of a change made through the index, for modes and
  // symlinks; `renames` lets git detect renames and copies as `-M -C` would.
  const changeIndex = (mutate, { renames = false } = {}) => {
    git("read-tree", baseSha);
    mutate({ put, remove });
    const treeId = git("write-tree").toString().trim();
    git("read-tree", baseSha);
    const patchText = git("diff", "--binary", "--no-ext-diff", "--no-textconv",
      ...(renames ? ["-M", "-C", "--find-copies-harder"] : ["--no-renames"]),
      rootTreeId, treeId, "--").toString("utf8");
    return { patchText, treeId, publisherTreeId: publisherTree(patchText) };
  };
  const load = (patchText) => loadEngineeringAgentV22Candidate(
    { baseSha, patchText }, ports);
  return { dir, git, baseSha, ports, reads, changeFiles, changeIndex,
    publisherTree, load,
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The candidate equals the tree git writes and the tree the publisher writes. */
const sameTree = async (fixture, change) => {
  const result = await fixture.load(change.patchText);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.expectedTreeId, change.treeId, "git's own tree");
  assert.equal(result.expectedTreeId, change.publisherTreeId,
    "the publisher's git apply --cached tree");
  return result;
};

const statuses = (result) => result.changes.map((entry) =>
  [entry.path, entry.status, entry.oldMode, entry.newMode]);

const sourceFile = (name, lines) => Array.from({ length: lines }, (_, i) =>
  `export const ${name}Value${i} = "${name}-${i}-${"x".repeat(18)}";\n`)
  .join("");

const edited = (text, name) => text
  .replace(`${name}Value3 = `, `${name}Value3 = /* changed */ `)
  .replace(`${name}Value120 = `, `${name}Value120 = /* changed */ `)
  .concat(`export const ${name}Added = true;\n`);

/** Deterministic bytes git takes as binary. */
const binary = (seed, length) => {
  const out = Buffer.alloc(length);
  let block = Buffer.alloc(0);
  for (let i = 0; i < length; i++) {
    if (i % 32 === 0) block = createHash("sha256").update(`${seed}:${i}`).digest();
    out[i] = block[i % 32];
  }
  out[0] = 0;
  return out;
};

/** The diff git writes for a new `100644` text file ending in a newline. */
const newFilePatch = (path, text) => {
  const lines = text.split("\n").slice(0, -1);
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n` +
    `index ${"0".repeat(40)}..${gitObjectId("blob", Buffer.from(text))}\n` +
    `--- /dev/null\n+++ b/${path}\n` +
    `@@ -0,0 +1${lines.length === 1 ? "" : `,${lines.length}`} @@\n` +
    lines.map((line) => `+${line}\n`).join("");
};

const neutralTierInput = (changes, over = {}) => ({ changes,
  policyNamedTests: new Set(), installedVersions: { ...CONVENTION_VERSIONS },
  credential: { status: "analysed", forbidsAll: false,
    forbiddenPaths: new Set() },
  slice: { status: "analysed", slicePaths: new Set() }, ...over });

// AMUX-FILEGEN-003 (2026-11-10): three sources and their tests, about 75 KB.
const filegenPaths = [
  "lib/chatStreamConsumer.ts", "lib/generatedArtifactToolPolicy.ts",
  "lib/webSearchStreamTrailer.ts", "tests/chatStreamConsumer.test.mjs",
  "tests/generatedArtifactToolPolicy.test.mjs",
  "tests/webSearchStreamTrailer.test.mjs",
];

test("a six-file, 75 KB patch becomes a candidate with git's and the publisher's tree", async () => {
  const files = Object.fromEntries(filegenPaths.map((path, index) =>
    [path, sourceFile(`f${index}`, 240)]));
  const fixture = repo(files);
  try {
    const change = fixture.changeFiles(Object.fromEntries(
      filegenPaths.map((path, index) =>
        [path, edited(files[path], `f${index}`)])));
    const result = await sameTree(fixture, change);
    assert.deepEqual(result.changes.map((entry) => entry.path).sort(),
      [...filegenPaths].sort());
    assert.equal(fixture.reads.length, 6);
  } finally { fixture.cleanup(); }
});

test("the stored candidate hands the loader the patch text, never stored file bytes", async () => {
  const snapshot = { runId: "123456789012", taskId: "task-1",
    baseSha: "a".repeat(40) };
  const text = "diff --git a/file.ts b/file.ts\n";
  let seen = null;
  const result = await loadEngineeringAgentV22StoredCandidate(
    "29cf907f-2741-4dd1-b6d4-d85c881eb357", {
      readSnapshot: async () => snapshot,
      readPatch: async () => ({ text, sha256: "b".repeat(64),
        baseSha: snapshot.baseSha, files: [{ path: "file.ts",
          mode: "100644", bytesBase64: "YQ==" }] }),
      readConsent: async () => true, readSwitch: async () => true,
      publicationEnabled: () => true,
      loadCandidate: async (input) => { seen = input;
        return { ok: false, reason: "patch_mismatch" }; },
    });
  assert.deepEqual(seen, { baseSha: snapshot.baseSha, patchText: text });
  assert.deepEqual(result, { ok: false, reason: "patch_mismatch" });
});

test("a missing last newline, CRLF lines and a byte order mark survive exactly", async () => {
  const fixture = repo({
    "lib/noEol.ts": "export const a = 1;\nexport const b = 2;",
    "lib/crlf.ts": "export const c = 1;\r\nexport const d = 2;\r\n",
    "lib/bom.ts": "\ufeffexport const e = 1;\nexport const f = 2;\n",
  });
  try {
    await sameTree(fixture, fixture.changeFiles({
      "lib/noEol.ts": "export const a = 1;\nexport const b = 3;\n",
      "lib/crlf.ts": "export const c = 1;\r\nexport const d = 3;\r\n",
      "lib/bom.ts": "\ufeffexport const e = 2;\nexport const f = 2;",
    }));
  } finally { fixture.cleanup(); }
});

test("new, deleted and renamed files, new and emptied directories rebuild git's tree", async () => {
  const fixture = repo({ "lib/a.ts": sourceFile("a", 40),
    "lib/gone/only.ts": "export const only = 1;\n",
    "lib/move/from.ts": sourceFile("m", 20), "tests/old.test.mjs": "x\n" });
  try {
    const change = fixture.changeFiles({
      "lib/a.ts": edited(sourceFile("a", 40), "a"),
      "lib/feature/y.ts": "export const y = 1;\nexport const z = 2;",
      "tests/new/deep/x.test.mjs": "line one\r\nline two\r\n",
      "tests/copy.test.mjs": "x\n",
      // A rename, as the sidecar writes it (--no-renames): a delete and a new file.
      "lib/move/to.ts": sourceFile("m", 20),
    }, ["lib/gone/only.ts", "lib/move/from.ts"]);
    assert.match(change.patchText, /^deleted file mode 100644$/m);
    const result = await sameTree(fixture, change);
    assert.deepEqual(statuses(result), [
      ["lib/a.ts", "modified", "100644", "100644"],
      ["lib/feature/y.ts", "added", null, "100644"],
      ["lib/gone/only.ts", "deleted", "100644", null],
      ["lib/move/from.ts", "deleted", "100644", null],
      ["lib/move/to.ts", "added", null, "100644"],
      ["tests/copy.test.mjs", "added", null, "100644"],
      ["tests/new/deep/x.test.mjs", "added", null, "100644"]]);
    // Each old side is read once; a new file reads nothing.
    assert.equal(fixture.reads.length, 3);
  } finally { fixture.cleanup(); }
});

test("renames and copies as git detects them rebuild git's tree", async () => {
  const fixture = repo({ "lib/old.ts": sourceFile("o", 60),
    "lib/edit.ts": sourceFile("e", 60), "lib/src.ts": sourceFile("s", 60) });
  try {
    const change = fixture.changeIndex(({ put, remove }) => {
      remove("lib/old.ts");
      put("lib/renamed.ts", sourceFile("o", 60));
      remove("lib/edit.ts");
      put("lib/edited.ts", edited(sourceFile("e", 60), "e"));
      put("lib/copied.ts", sourceFile("s", 60));
    }, { renames: true });
    assert.match(change.patchText, /^similarity index 100%$/m);
    assert.match(change.patchText, /^rename from lib\/edit\.ts$/m);
    assert.match(change.patchText, /^copy from lib\/src\.ts$/m);
    const result = await sameTree(fixture, change);
    assert.deepEqual(result.changes.map((entry) => [entry.path, entry.status]), [
      ["lib/copied.ts", "added"], ["lib/edit.ts", "deleted"],
      ["lib/edited.ts", "added"], ["lib/old.ts", "deleted"],
      ["lib/renamed.ts", "added"]]);
  } finally { fixture.cleanup(); }
});

test("mode changes, executables and symlinks rebuild git's tree", async () => {
  const fixture = repo({ "bin/run.sh": "#!/bin/sh\necho run\n",
    "bin/tool.sh": ["#!/bin/sh\necho tool\n", "100755"],
    "lib/link": ["lib/a.ts", "120000"], "lib/a.ts": "export const a = 1;\n",
    "lib/swap.ts": "export const swap = 1;\n",
    "lib/dead": ["lib/a.ts", "120000"] });
  try {
    const change = fixture.changeIndex(({ put, remove }) => {
      put("bin/run.sh", "#!/bin/sh\necho run\n", "100755"); // mode only
      put("bin/tool.sh", "#!/bin/sh\necho changed\n", "100644"); // mode and bytes
      put("bin/new.sh", "#!/bin/sh\necho new\n", "100755"); // a new executable
      put("lib/link", "lib/swap.ts", "120000"); // a symlink retargeted
      put("lib/newlink", "lib/a.ts", "120000"); // a new symlink
      remove("lib/dead"); // a deleted symlink
      put("lib/swap.ts", "lib/a.ts", "120000"); // a file becomes a symlink
    });
    assert.match(change.patchText, /^old mode 100644\nnew mode 100755$/m);
    const result = await sameTree(fixture, change);
    assert.deepEqual(statuses(result), [
      ["bin/new.sh", "added", null, "100755"],
      ["bin/run.sh", "modified", "100644", "100755"],
      ["bin/tool.sh", "modified", "100755", "100644"],
      ["lib/dead", "deleted", "120000", null],
      ["lib/link", "modified", "120000", "120000"],
      ["lib/newlink", "added", null, "120000"],
      ["lib/swap.ts", "modified", "100644", "120000"]]);
    // A person reads these: the tier gate sends each to T2 by its mode.
    const reasons = decideTier(neutralTierInput(result.changes)).findings
      .map((finding) => finding.reason);
    assert.ok(reasons.includes("executable_bit"));
    assert.ok(reasons.includes("symlink"));
  } finally { fixture.cleanup(); }
});

test("binary files, as literals and deltas, rebuild git's tree and are T2", async () => {
  const image = binary("image", 64 * 1024);
  const tweaked = Buffer.from(image);
  tweaked[1000] ^= 0xff;
  tweaked[40_000] ^= 0xff;
  const fixture = repo({ "public/image.bin": image,
    "public/old.bin": binary("old", 2000), "lib/a.ts": "export const a = 1;\n" });
  try {
    const change = fixture.changeFiles({ "public/image.bin": tweaked,
      "public/new.bin": binary("new", 3000) }, ["public/old.bin"]);
    assert.match(change.patchText, /^GIT binary patch$/m);
    assert.match(change.patchText, /^delta \d+$/m, "a small edit is a delta");
    assert.match(change.patchText, /^literal \d+$/m);
    const result = await sameTree(fixture, change);
    assert.deepEqual(result.changes.map((entry) => [entry.path, entry.status,
      entry.isText]), [["public/image.bin", "modified", false],
      ["public/new.bin", "added", false], ["public/old.bin", "deleted", false]]);
    assert.ok(decideTier(neutralTierInput(result.changes)).findings
      .some((finding) => finding.reason === "not_text"));
  } finally { fixture.cleanup(); }
});

test("empty files, created and deleted, rebuild git's tree", async () => {
  const fixture = repo({ "lib/empty.ts": "", "lib/fill.ts": "",
    "lib/a.ts": "export const a = 1;\n" });
  try {
    const change = fixture.changeFiles({ "lib/new-empty.ts": "",
      "lib/fill.ts": "export const filled = 1;\n" }, ["lib/empty.ts"]);
    const result = await sameTree(fixture, change);
    assert.deepEqual(result.changes.map((entry) => [entry.path, entry.status]),
      [["lib/empty.ts", "deleted"], ["lib/fill.ts", "modified"],
        ["lib/new-empty.ts", "added"]]);
  } finally { fixture.cleanup(); }
});

test("a file becomes a directory and a directory becomes a file", async () => {
  const fixture = repo({ "lib/thing": "a file\n", "lib/dir/inner.ts": "inner\n",
    "lib/keep.ts": "keep\n" });
  try {
    const change = fixture.changeIndex(({ put, remove }) => {
      remove("lib/thing");
      put("lib/thing/inside.ts", "now a directory\n");
      remove("lib/dir/inner.ts");
      put("lib/dir", "now a file\n");
    });
    await sameTree(fixture, change);
  } finally { fixture.cleanup(); }
});

test("a small edit to a 534 KB file and 300 new files rebuild git's tree", async () => {
  // ChatPageClient.tsx is about 534 KB: past the 200 KiB that kept it out.
  const big = sourceFile("big", 10_000);
  assert.ok(Buffer.byteLength(big) > 500 * 1024);
  const fixture = repo({ "app/ChatPageClient.tsx": big });
  try {
    const files = { "app/ChatPageClient.tsx": edited(big, "big") };
    for (let i = 0; i < 300; i++)
      files[`tests/many/f${i}.test.mjs`] = `export const v${i} = ${i};\n`;
    const change = fixture.changeFiles(files);
    const result = await sameTree(fixture, change);
    assert.equal(result.changes.length, 301);
  } finally { fixture.cleanup(); }
});

test("a path .gitattributes applies to is a candidate the tier gate sends to T2", async () => {
  const fixture = repo({ ".gitattributes": "*.dat binary\n",
    "lib/table.dat": "1,2\n", "lib/a.ts": "export const a = 1;\n" });
  try {
    const result = await sameTree(fixture,
      fixture.changeFiles({ "lib/table.dat": "1,2,3\n" }));
    assert.deepEqual(result.unsupported,
      [{ reason: "gitattributes_applies", path: "lib/table.dat" }]);
    const verdict = decideTier(neutralTierInput(result.changes,
      { unsupported: result.unsupported }));
    assert.equal(verdict.tier, "T2");
    assert.ok(verdict.findings.some((finding) =>
      finding.reason === "unsupported_tree_change"));
  } finally { fixture.cleanup(); }
});

test("a new file on a contract path is a candidate the existing tier gate sends to T2", async () => {
  const fixture = repo({ "lib/a.ts": "export const a = 1;\n",
    ".github/workflows/ci.yml": "name: ci\n" });
  try {
    const contract = ["prisma/migrations/20261115000000_new/migration.sql",
      "docs/release-gates/new.md", ".github/workflows/new.yml",
      "scripts/new.mjs", "tests/newPolicy.test.mjs", "lib/modelPricingNew.ts"];
    const change = fixture.changeFiles(Object.fromEntries(
      contract.map((path) => [path, "-- new\n"])), [".github/workflows/ci.yml"]);
    const result = await sameTree(fixture, change);
    const verdict = decideTier(neutralTierInput(result.changes));
    assert.equal(verdict.tier, "T2");
    for (const path of [...contract.slice(0, 5), ".github/workflows/ci.yml"])
      assert.ok(verdict.findings.some((finding) => finding.path === path),
        `${path} has a finding`);
  } finally { fixture.cleanup(); }
});

test("an ordinary new file is judged, not passed: credential and slice findings still apply", async () => {
  const fixture = repo({ "lib/a.ts": "export const a = 1;\n" });
  try {
    const path = "tests/ordinaryNew.test.mjs";
    const result = await sameTree(fixture,
      fixture.changeFiles({ [path]: sourceFile("o", 5) }));
    assert.deepEqual(decideTier(neutralTierInput(result.changes)),
      { tier: "T1", findings: [] });
    assert.deepEqual(decideTier(neutralTierInput(result.changes, {
      credential: { status: "analysed", forbidsAll: false,
        forbiddenPaths: new Set([path]) } })).findings,
    [{ reason: "credential_reachable", path }]);
    assert.deepEqual(decideTier(neutralTierInput(result.changes, {
      slice: { status: "analysed", slicePaths: new Set([path]) } })).findings,
    [{ reason: "control_plane_slice", path }]);
  } finally { fixture.cleanup(); }
});

test("a patch that does not apply exactly, or names another result, is refused", async () => {
  const fixture = repo({ "lib/a.ts": sourceFile("a", 40) });
  try {
    const { patchText } = fixture.changeFiles({
      "lib/a.ts": edited(sourceFile("a", 40), "a") });
    // A context line the base does not have.
    assert.deepEqual(await fixture.load(patchText.replace(" export const aValue1 =",
      " export const aValueX =")), { ok: false, reason: "patch_mismatch" });
    // A hunk moved by one line: no offset, no fuzz.
    assert.deepEqual(await fixture.load(patchText.replace(/@@ -(\d+)/, (_, n) =>
      `@@ -${Number(n) + 1}`)), { ok: false, reason: "patch_mismatch" });
    // An added line changed after the diff named its result blob.
    assert.deepEqual(await fixture.load(patchText.replace(
      "+export const aAdded = true;", "+export const aAdded = false;")),
    { ok: false, reason: "patch_mismatch" });
    // A diff of some other base blob.
    assert.deepEqual(await fixture.load(patchText.replace(/^index [0-9a-f]+/m,
      `index ${"1".repeat(40)}`)), { ok: false, reason: "base_mismatch" });
    // Trailing text after the last hunk.
    assert.deepEqual(await fixture.load(`${patchText}+export const extra = 1;\n`),
      { ok: false, reason: "patch_unreadable" });
  } finally { fixture.cleanup(); }
});

test("a new file over a taken path, under a file or beside a case twin is refused", async () => {
  const fixture = repo({ "lib/a.ts": "export const a = 1;\n",
    "lib/sub/b.ts": "export const b = 1;\n" });
  try {
    const text = "export const n = 1;\n";
    assert.ok(fixture.publisherTree(newFilePatch("lib/free.ts", text)));
    for (const path of ["lib/a.ts", "lib/sub", "lib/a.ts/x.ts",
      "lib/A.ts", "Lib/x.ts", "lib/Sub/x.ts"])
      assert.deepEqual(await fixture.load(newFilePatch(path, text)),
        { ok: false, reason: "path_conflict" }, path);
    // git refuses the first three too, so the publisher never pushes them.
    for (const path of ["lib/a.ts", "lib/sub", "lib/a.ts/x.ts"])
      assert.equal(fixture.publisherTree(newFilePatch(path, text)), null, path);
  } finally { fixture.cleanup(); }
});

test("what cannot be rebuilt is refused before any GitHub read", async () => {
  const fixture = repo({ "lib/a.ts": "export const a = 1;\n" });
  try {
    let reads = 0;
    const ports = { readBase: async () => { reads++; throw new Error("read"); },
      readBlob: async () => { reads++; throw new Error("read"); } };
    const load = (patchText) => loadEngineeringAgentV22Candidate(
      { baseSha: fixture.baseSha, patchText }, ports);
    const added = newFilePatch("lib/new.ts", "export const n = 1;\n");
    for (const [patchText, reason] of [
      // A submodule; a binary file written without its data; not a diff.
      [`diff --git a/vendor/x b/vendor/x\nnew file mode 160000\nindex ${"0".repeat(40)}..${"1".repeat(40)}\n--- /dev/null\n+++ b/vendor/x\n@@ -0,0 +1 @@\n+Subproject commit ${"1".repeat(40)}\n`, "patch_unreadable"],
      ["diff --git a/lib/a.bin b/lib/a.bin\nindex 1111111..2222222 100644\nBinary files a/lib/a.bin and b/lib/a.bin differ\n", "patch_unreadable"],
      ["", "patch_unreadable"], ["not a diff\n", "patch_unreadable"],
      // A new executable written with a mode on its index line.
      [added.replace(/^(index \S+)$/m, "$1 100644"), "patch_unreadable"],
      // Paths no execution path may hold.
      [newFilePatch("../x.ts", "x\n"), "path_invalid"],
      [newFilePatch("lib/C:/x.ts", "x\n"), "path_invalid"],
      // A copy of a path the same patch changes: git would read it as changed.
      ["diff --git a/lib/a.ts b/lib/b.ts\nsimilarity index 100%\ncopy from lib/a.ts\ncopy to lib/b.ts\n" +
        `diff --git a/lib/a.ts b/lib/a.ts\ndeleted file mode 100644\nindex ${"1".repeat(7)}..0000000\n--- a/lib/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const a = 1;\n`, "patch_unreadable"],
    ]) {
      assert.deepEqual(await load(patchText), { ok: false, reason }, patchText);
    }
    assert.deepEqual(await load(`diff --git a/x b/x\n+${"x".repeat(4 * 1024 * 1024)}\n`),
      { ok: false, reason: "patch_over_limit" });
    assert.equal(reads, 0);
  } finally { fixture.cleanup(); }
});

test("a hand-written multi-hunk new file is refused: git would apply it otherwise", async () => {
  const fixture = repo({ "lib/a.ts": "export const a = 1;\n" });
  try {
    const content = "a\nb\n";
    const patchText = `diff --git a/lib/multi.ts b/lib/multi.ts\nnew file mode 100644\n` +
      `index ${"0".repeat(40)}..${gitObjectId("blob", Buffer.from(content))}\n` +
      `--- /dev/null\n+++ b/lib/multi.ts\n@@ -0,0 +1 @@\n+a\n@@ -0,0 +2 @@\n+b\n`;
    assert.deepEqual(await fixture.load(patchText),
      { ok: false, reason: "patch_mismatch" });
    // git puts the second hunk at the start, not where its header says.
    const published = fixture.publisherTree(patchText);
    if (published !== null) {
      const listing = fixture.git("ls-tree", "-r", published).toString();
      assert.doesNotMatch(listing, new RegExp(gitObjectId("blob", Buffer.from(content))));
    }
  } finally { fixture.cleanup(); }
});

test("rebuilt bytes, text or binary, go through the secret check", async () => {
  const fixture = repo({ "lib/config.ts": sourceFile("c", 20) });
  try {
    // Built at run time, so no scanner reads a credential-shaped literal here.
    const token = ["gh", "p_", "Q".repeat(36)].join("");
    assert.deepEqual(await fixture.load(fixture.changeFiles({ "lib/config.ts":
      `${sourceFile("c", 20)}export const leaked = "${token}";\n` }).patchText),
    { ok: false, reason: "secret_detected" });
    const carrier = Buffer.concat([binary("carrier", 500), Buffer.from(token),
      binary("tail", 500)]);
    const { patchText } = fixture.changeFiles({ "public/blob.bin": carrier });
    assert.match(patchText, /^GIT binary patch$/m);
    assert.doesNotMatch(patchText, new RegExp(token), "base85 hides it from a text scan");
    assert.deepEqual(await fixture.load(patchText),
      { ok: false, reason: "secret_detected" });
  } finally { fixture.cleanup(); }
});

test("the parser and applier refuse unsafe paths and shapes", () => {
  const oid = (c) => c.repeat(40);
  const header = (path) => `diff --git a/${path} b/${path}\n` +
    `index ${oid("1")}..${oid("2")} 100644\n--- a/${path}\n+++ b/${path}\n`;
  assert.equal(parseV22GitDiff(`${header("x.ts")}@@ -1 +1 @@\n-a\n+b\n` +
    `${header("x.ts")}@@ -1 +1 @@\n-a\n+b\n`).ok, false);
  assert.equal(parseV22GitDiff(`${header("x.ts")}@@ -1 +1 @@\n-a\n`).ok, false);
  assert.equal(parseV22GitDiff(`${header("x.ts")}@@ -1 +1 @@\n-a\n\n`).ok,
    false);
  const parsed = parseV22GitDiff(`${header("x.ts")}@@ -1 +1 @@\n-a\n+b\n`);
  assert.equal(parsed.ok, true);
  // The base blob is not the one the diff names.
  assert.equal(applyV22FileDiff(Buffer.from("a\n"), parsed.files[0]), null);
  // A quoted path git writes for a name it escapes reads as that name.
  const quoted = parseV22GitDiff(newFilePatch("lib/a b.ts", "x\n")
    .replace("diff --git a/lib/a b.ts b/lib/a b.ts", 'diff --git "a/lib/a b.ts" "b/lib/a b.ts"')
    .replace("+++ b/lib/a b.ts", '+++ "b/lib/a b.ts"'));
  assert.equal(quoted.ok, true);
  assert.equal(quoted.files[0].newPath, "lib/a b.ts");
});
