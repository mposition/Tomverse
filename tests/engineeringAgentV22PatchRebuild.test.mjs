import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

// A real repository, so each case checks the rebuilt tree against the tree
// git itself writes for the same change (what the publisher pushes).
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "v22-rebuild-"));
  const gitWith = (env, ...args) => execFileSync("git", ["-c",
    "core.autocrlf=false", "-c", "user.name=t",
    "-c", "user.email=t@example.invalid",
    "-c", "commit.gpgsign=false", "-C", dir, ...args],
  { maxBuffer: 16 * 1024 * 1024, env, stdio: ["ignore", "pipe", "pipe"] });
  const git = (...args) => gitWith(process.env, ...args);
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
  // The publisher's own steps (scripts/engineering-agent-publisher.mjs,
  // `build`): a fresh index at the base, `git apply --cached`, `write-tree`.
  // Null when git refuses to apply the patch.
  const publisherTree = (patchText) => {
    const index = join(dir, ".git", "publisher-index");
    const patchFile = join(dir, ".git", "publisher.patch");
    writeFileSync(patchFile, patchText, "utf8");
    const env = { ...process.env, GIT_INDEX_FILE: index };
    try {
      gitWith(env, "read-tree", baseSha);
      try { gitWith(env, "apply", "--cached", patchFile); }
      catch { return null; }
      return gitWith(env, "write-tree").toString().trim();
    } finally { rmSync(index, { force: true }); rmSync(patchFile); }
  };
  // The diff the sidecar stores (new files marked intent-to-add first, as
  // the sidecar does), the tree git writes for the change, and the tree the
  // publisher writes from that diff.
  const change = (entries) => {
    write(entries);
    const untracked = git("ls-files", "--others", "--exclude-standard", "-z")
      .toString("utf8").split("\0").filter(Boolean);
    if (untracked.length) git("add", "-N", "--", ...untracked);
    const patchText = git("diff", "--binary", "--no-ext-diff",
      "--no-textconv", "--no-renames", "HEAD", "--").toString("utf8");
    git("add", "-A");
    const treeId = git("write-tree").toString().trim();
    return { patchText, treeId, publisherTreeId: publisherTree(patchText) };
  };
  return { dir, git, baseSha, ports, reads, change, publisherTree,
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The diff git writes for a new `100644` text file ending in a newline. */
const newFilePatch = (path, text) => {
  const lines = text.split("\n").slice(0, -1);
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n` +
    `index ${"0".repeat(40)}..${gitObjectId("blob", Buffer.from(text))}\n` +
    `--- /dev/null\n+++ b/${path}\n` +
    `@@ -0,0 +1${lines.length === 1 ? "" : `,${lines.length}`} @@\n` +
    lines.map((line) => `+${line}\n`).join("");
};

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

test("deleted, renamed-mode, binary and irregular new files are refused before any GitHub read", async () => {
  const files = { "lib/a.ts": "export const a = 1;\n",
    "lib/b.ts": "export const b = 1;\n", "lib/c.ts": "export const c = 1;\n" };
  const fixture = repo(files);
  try {
    let reads = 0;
    const ports = { readBase: async () => { reads++; throw new Error("read"); },
      readBlob: async () => { reads++; throw new Error("read"); } };
    const refused = async (patchText) => assert.deepEqual(
      await loadEngineeringAgentV22Candidate({ baseSha: fixture.baseSha,
        patchText }, ports), { ok: false, reason: "patch_unsupported" },
      patchText);
    const diff = (...args) => fixture.git("diff", "--binary", "--no-renames",
      ...args, "HEAD", "--").toString("utf8");
    rmSync(join(fixture.dir, "lib/b.ts"));
    await refused(diff());
    fixture.git("checkout", "--", "lib/b.ts");
    writeFileSync(join(fixture.dir, "lib/c.ts"), Buffer.from([0, 1, 2, 3]));
    await refused(diff());
    fixture.git("checkout", "--", "lib/c.ts");
    await refused("diff --git a/lib/a.ts b/lib/a.ts\nold mode 100644\n" +
      "new mode 100755\n");
    // A new binary file and a new empty file, as git writes them.
    for (const [path, content] of [["lib/new.bin", Buffer.from([0, 1, 2])],
      ["lib/empty.ts", Buffer.alloc(0)]]) {
      writeFileSync(join(fixture.dir, path), content);
      fixture.git("add", "-N", "--", path);
      await refused(diff());
      fixture.git("reset", "-q", "--", path);
      rmSync(join(fixture.dir, path));
    }
    const added = newFilePatch("lib/new.ts", "export const n = 1;\n");
    // A new executable, symlink or submodule; a mode on the index line.
    for (const mode of ["100755", "120000", "160000"])
      await refused(added.replace("new file mode 100644",
        `new file mode ${mode}`));
    await refused(added.replace(/^(index \S+)$/m, "$1 100644"));
    // A new file's hunk adds every line from nothing, and names a real blob.
    await refused(added.replace("@@ -0,0 +1 @@", "@@ -1,0 +1 @@"));
    await refused(added.replace("@@ -0,0 +1 @@", "@@ -0,0 +2 @@"));
    await refused(added.replace("@@ -0,0 +1 @@\n+", "@@ -0,1 +1 @@\n "));
    await refused(added.replace(/\.\.[0-9a-f]{40}$/m, `..${"0".repeat(40)}`));
    await refused(added.replace("--- /dev/null", "--- a/lib/new.ts"));
    await refused(`${added}@@ -0,0 +1 @@\n+again\n`);
    await refused("");
    assert.equal(reads, 0);
  } finally { fixture.cleanup(); }
});

// Operator, 2026-11-15: a v22 patch that adds regular text files (most test
// Tasks do) becomes a candidate for the tier gate, like a modification.
test("a patch that only adds a file becomes a candidate with git's and the publisher's tree", async () => {
  const fixture = repo({ "lib/a.ts": sourceFile("a", 10) });
  try {
    const { patchText, treeId, publisherTreeId } = fixture.change({
      "tests/aNew.test.mjs": sourceFile("t", 30) });
    assert.match(patchText, /^new file mode 100644$/m);
    assert.match(patchText, /^--- \/dev\/null$/m);
    const result = await loadEngineeringAgentV22Candidate({
      baseSha: fixture.baseSha, patchText }, fixture.ports);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.expectedTreeId, treeId);
    assert.equal(result.expectedTreeId, publisherTreeId);
    assert.deepEqual(result.changes.map(({ path, status, oldMode, newMode,
      isText, addedLines, removedLines }) => ({ path, status, oldMode,
      newMode, isText, addedLines, removedLines })), [{
      path: "tests/aNew.test.mjs", status: "added", oldMode: null,
      newMode: "100644", isText: true, addedLines: 30, removedLines: 0 }]);
    // A new file has no base blob to read.
    assert.deepEqual(fixture.reads, []);
  } finally { fixture.cleanup(); }
});

test("modified and new files, new directories, CRLF and a missing last newline rebuild git's tree", async () => {
  const files = { "lib/a.ts": sourceFile("a", 40), "tests/old.test.mjs": "x\n" };
  const fixture = repo(files);
  try {
    const { patchText, treeId, publisherTreeId } = fixture.change({
      "lib/a.ts": edited(files["lib/a.ts"], "a"),
      "lib/feature/y.ts": "export const y = 1;\nexport const z = 2;",
      "tests/new/deep/x.test.mjs": "line one\r\nline two\r\n",
      "docs/notes/fresh.md": "# Fresh\n",
      // The same bytes as an existing file: no new blob, still a new path.
      "tests/copy.test.mjs": "x\n",
    });
    const result = await loadEngineeringAgentV22Candidate({
      baseSha: fixture.baseSha, patchText }, fixture.ports);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.expectedTreeId, treeId);
    assert.equal(result.expectedTreeId, publisherTreeId);
    assert.deepEqual(result.changes.map((entry) =>
      [entry.path, entry.status]), [["docs/notes/fresh.md", "added"],
      ["lib/a.ts", "modified"], ["lib/feature/y.ts", "added"],
      ["tests/copy.test.mjs", "added"],
      ["tests/new/deep/x.test.mjs", "added"]]);
    // Only the modified file's base blob is read.
    assert.equal(fixture.reads.length, 1);
  } finally { fixture.cleanup(); }
});

test("stored file bytes may name a new file: no blob is read for it", async () => {
  const files = { "lib/a.ts": "export const a = 1;\n" };
  const fixture = repo(files);
  try {
    const next = { "lib/a.ts": "export const a = 2;\n",
      "lib/added/b.ts": "export const b = 1;\n" };
    const { treeId, publisherTreeId } = fixture.change(next);
    const stored = Object.entries(next).map(([path, text]) => ({ path,
      mode: "100644", bytesBase64: Buffer.from(text).toString("base64") }));
    const result = await loadEngineeringAgentV22Candidate({
      baseSha: fixture.baseSha, files: stored }, fixture.ports);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.expectedTreeId, treeId);
    assert.equal(result.expectedTreeId, publisherTreeId);
    assert.deepEqual(result.changes.map((entry) => entry.status),
      ["modified", "added"]);
    assert.equal(fixture.reads.length, 1);
  } finally { fixture.cleanup(); }
});

test("a new file over a taken path, under a file or beside a case twin is refused", async () => {
  const fixture = repo({ "lib/a.ts": "export const a = 1;\n",
    "lib/sub/b.ts": "export const b = 1;\n" });
  try {
    const text = "export const n = 1;\n";
    const load = (input) => loadEngineeringAgentV22Candidate({
      baseSha: fixture.baseSha, ...input }, fixture.ports);
    // The helper writes what git accepts for a free path.
    assert.ok(fixture.publisherTree(newFilePatch("lib/free.ts", text)));
    for (const path of ["lib/a.ts", "lib/sub", "lib/a.ts/x.ts",
      "lib/A.ts", "Lib/x.ts", "lib/Sub/x.ts"]) {
      const patchText = newFilePatch(path, text);
      assert.deepEqual(await load({ patchText }),
        { ok: false, reason: "path_conflict" }, path);
    }
    // git refuses the first three too, so the publisher never pushes them.
    for (const path of ["lib/a.ts", "lib/sub", "lib/a.ts/x.ts"])
      assert.equal(fixture.publisherTree(newFilePatch(path, text)), null, path);
    // A stored file list names no header: a file under a file is refused.
    assert.deepEqual(await load({ files: [{ path: "lib/a.ts/x.ts",
      mode: "100644", bytesBase64: Buffer.from(text).toString("base64") }] }),
    { ok: false, reason: "path_conflict" });
    assert.deepEqual(fixture.reads, []);
  } finally { fixture.cleanup(); }
});

test("new files face the same execution-path, count, size and secret checks", async () => {
  const fixture = repo({ "lib/a.ts": "export const a = 1;\n" });
  try {
    let reads = 0;
    const noRead = { readBase: async () => { reads++; throw new Error("read"); },
      readBlob: async () => { reads++; throw new Error("read"); } };
    const load = (input, ports = fixture.ports) =>
      loadEngineeringAgentV22Candidate({ baseSha: fixture.baseSha, ...input },
        ports);
    const b64 = (text) => Buffer.from(text).toString("base64");
    // A canonical name that no execution path may hold.
    assert.deepEqual(await load({ patchText: newFilePatch("lib/C:/x.ts",
      "x\n") }, noRead), { ok: false, reason: "patch_unsupported" });
    assert.deepEqual(await load({ files: [{ path: "lib/C:/x.ts",
      mode: "100644", bytesBase64: b64("x\n") }] }, noRead),
    { ok: false, reason: "patch_unsupported" });
    // Twenty-one new files are over the candidate's file limit.
    const many = Array.from({ length: 21 }, (_, i) =>
      newFilePatch(`tests/many${i}.test.mjs`, `export const m${i} = 1;\n`));
    assert.deepEqual(await load({ patchText: many.join("") }, noRead),
      { ok: false, reason: "patch_unsupported" });
    assert.deepEqual(await load({ patchText: many.slice(0, 20).join("") })
      .then((result) => result.ok), true);
    assert.equal(reads, 0);
    // Over 200 KiB, whether rebuilt or stored.
    const big = `${"x".repeat(200 * 1024)}\n`;
    assert.deepEqual(await load({ patchText: newFilePatch("lib/big.ts", big) }),
      { ok: false, reason: "files_invalid" });
    assert.deepEqual(await load({ files: [{ path: "lib/big.ts",
      mode: "100644", bytesBase64: b64(big) }] }),
    { ok: false, reason: "files_invalid" });
    // Built at run time, so no scanner reads a credential-shaped literal here.
    const token = ["gh", "p_", "Q".repeat(36)].join("");
    assert.deepEqual(await load({ patchText: newFilePatch("lib/leak.ts",
      `export const leaked = "${token}";\n`) }),
    { ok: false, reason: "files_invalid" });
    // A hunk whose bytes are not the blob the index line names.
    assert.deepEqual(await load({ patchText: newFilePatch("lib/n.ts", "a\n")
      .replace("+a\n", "+b\n") }), { ok: false, reason: "patch_does_not_apply" });
  } finally { fixture.cleanup(); }
});

const neutralTierInput = (changes, over = {}) => ({ changes,
  policyNamedTests: new Set(), installedVersions: { ...CONVENTION_VERSIONS },
  credential: { status: "analysed", forbidsAll: false,
    forbiddenPaths: new Set() },
  slice: { status: "analysed", slicePaths: new Set() }, ...over });

test("a new file on a contract path is a candidate the existing tier gate sends to T2", async () => {
  const fixture = repo({ "lib/a.ts": "export const a = 1;\n" });
  try {
    const contract = ["prisma/migrations/20261115000000_new/migration.sql",
      "docs/release-gates/new.md", ".github/workflows/new.yml",
      "scripts/new.mjs", "tests/newPolicy.test.mjs"];
    const { patchText } = fixture.change(Object.fromEntries(
      contract.map((path) => [path, "-- new\n"])));
    const result = await loadEngineeringAgentV22Candidate({
      baseSha: fixture.baseSha, patchText }, fixture.ports);
    assert.equal(result.ok, true, result.reason);
    const verdict = decideTier(neutralTierInput(result.changes));
    assert.equal(verdict.tier, "T2");
    for (const path of contract)
      assert.ok(verdict.findings.some((finding) => finding.path === path),
        `${path} has a finding`);
  } finally { fixture.cleanup(); }
});

test("an ordinary new file is judged, not passed: credential and slice findings still apply", async () => {
  const fixture = repo({ "lib/a.ts": "export const a = 1;\n" });
  try {
    const path = "tests/ordinaryNew.test.mjs";
    const { patchText } = fixture.change({ [path]: sourceFile("o", 5) });
    const result = await loadEngineeringAgentV22Candidate({
      baseSha: fixture.baseSha, patchText }, fixture.ports);
    assert.equal(result.ok, true, result.reason);
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
