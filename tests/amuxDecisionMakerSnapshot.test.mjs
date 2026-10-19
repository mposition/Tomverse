import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { dmSnapshotManifestDigest } from "../lib/amux/decisionMakerBodyCore.ts";
import {
  DM_SNAPSHOT_FILE_MAX_BYTES,
  DM_SNAPSHOT_TOTAL_MAX_BYTES,
  buildDmSnapshot,
  dmSnapshotHttpClient,
  dmSnapshotPayloadLines,
  dmSnapshotTransmission,
  gitBlobId,
  snapshotPathsFor,
} from "../lib/amux/decisionMakerSnapshot.ts";

/**
 * docs/policy/amux-decision-maker.md §5, stage S2b: the snapshot is public
 * bytes at one fixed commit, fetched without a credential, and only regular
 * files whose bytes are the tree's blob, outside the secret list, are kept.
 */

const SHA = "0123456789abcdef0123456789abcdef01234567";
const API = "https://api.github.com/repos/mposition/Tomverse";
const RAW = `https://raw.githubusercontent.com/mposition/Tomverse/${SHA}`;
const enc = (value) => new TextEncoder().encode(value);
const blob = (text) => gitBlobId(enc(text));
/** Whether a call read a file: its host, compared exactly. */
const isRawRead = (url) => new URL(url).host === "raw.githubusercontent.com";

/** A fake GitHub: `files` are the raw bodies, `tree` is derived unless overridden. */
const github = ({ files = {}, tree, head = SHA, commit = SHA, truncated = false, fail = {} } = {}) => {
  const calls = [];
  const entries = tree ?? Object.entries(files).map(([path, text]) => ({ path, mode: "100644", type: "blob", sha: blob(text) }));
  const http = async (url) => {
    calls.push(url);
    if (fail[url] === "throw") throw new Error("network");
    if (fail[url]) return { status: fail[url], body: enc("{}") };
    if (url === `${API}/commits/develop`) return { status: 200, body: enc(JSON.stringify({ sha: head })) };
    if (url === `${API}/commits/${SHA}`) return { status: 200, body: enc(JSON.stringify({ sha: commit })) };
    if (url === `${API}/git/trees/${SHA}?recursive=1`) return { status: 200, body: enc(JSON.stringify({ truncated, tree: entries })) };
    if (url.startsWith(`${RAW}/`)) {
      const path = url.slice(RAW.length + 1).split("/").map(decodeURIComponent).join("/");
      return path in files ? { status: 200, body: enc(files[path]) } : { status: 404, body: enc("") };
    }
    return { status: 404, body: enc("") };
  };
  return { http, calls };
};

test("Git's blob id is sha1 over the blob header and the bytes", () => {
  const bytes = enc("hello\n");
  assert.equal(gitBlobId(bytes), createHash("sha1").update("blob 6\0").update(bytes).digest("hex"));
  assert.equal(gitBlobId(bytes), "ce013625030ba8dba906f756967f9e9ca394464a");
});

test("the card's context and option paths, deduped, in the card's order", () => {
  assert.deepEqual(snapshotPathsFor(["a.md", "b.md"], [["b.md", "c.ts"], ["a.md"]]), ["a.md", "b.md", "c.ts"]);
});

test("a snapshot at develop's public head carries only the files asked for, and its manifest", async () => {
  const { http, calls } = github({ files: { "docs/a.md": "# A\n", "src/b.ts": "export const b = 1;\n", "src/other.ts": "x" } });
  const snapshot = await buildDmSnapshot(["docs/a.md", "src/b.ts"], http);
  assert.equal(snapshot.state, "develop");
  assert.equal(snapshot.targetSha, SHA);
  assert.deepEqual(snapshot.files.map((file) => file.path), ["docs/a.md", "src/b.ts"]);
  assert.deepEqual(snapshot.excluded, {});
  // One head lookup, one commit lookup, one tree, one raw read per file; nothing else.
  assert.deepEqual(calls, [
    `${API}/commits/develop`,
    `${API}/commits/${SHA}`,
    `${API}/git/trees/${SHA}?recursive=1`,
    `${RAW}/docs/a.md`,
    `${RAW}/src/b.ts`,
  ]);
  const key = Buffer.alloc(32, 9);
  assert.deepEqual(dmSnapshotTransmission(key, snapshot), {
    snapshotState: "develop",
    snapshotTargetSha: SHA,
    snapshotManifestDigest: dmSnapshotManifestDigest(key, [
      { path: "docs/a.md", blobId: blob("# A\n") },
      { path: "src/b.ts", blobId: blob("export const b = 1;\n") },
    ]),
  });
});

test("the target is a full lowercase commit id that the commit lookup answers with, or there is no snapshot", async () => {
  for (const options of [
    { head: "ABCDEF0123456789abcdef0123456789abcdef01" },
    { head: "abc123" },
    { commit: "f".repeat(40) },
    { fail: { [`${API}/commits/develop`]: 403 } },
    { fail: { [`${API}/commits/develop`]: 502 } },
    { fail: { [`${API}/commits/develop`]: "throw" } },
    { fail: { [`${API}/commits/${SHA}`]: 404 } },
  ]) {
    const { http, calls } = github({ files: { "a.md": "a" }, ...options });
    const snapshot = await buildDmSnapshot(["a.md"], http);
    assert.deepEqual([snapshot.state, snapshot.reason], ["none", "target_unavailable"], JSON.stringify(options));
    assert.equal(calls.some(isRawRead), false, "no file is read");
  }
  const truncated = await buildDmSnapshot(["a.md"], github({ files: { "a.md": "a" }, truncated: true }).http);
  assert.deepEqual([truncated.state, truncated.reason], ["none", "tree_truncated"]);
  const noTree = await buildDmSnapshot(["a.md"], github({ files: { "a.md": "a" }, fail: { [`${API}/git/trees/${SHA}?recursive=1`]: 500 } }).http);
  assert.deepEqual([noTree.state, noTree.reason], ["none", "tree_unavailable"]);
});

test("symlinks, submodules and directories are never fetched; a file whose bytes are not the tree's blob is left out", async () => {
  const { http, calls } = github({
    files: { "ok.md": "ok", "changed.md": "new bytes" },
    tree: [
      { path: "ok.md", mode: "100644", type: "blob", sha: blob("ok") },
      { path: "changed.md", mode: "100644", type: "blob", sha: blob("old bytes") },
      { path: "link", mode: "120000", type: "blob", sha: blob("target") },
      { path: "vendor/sub", mode: "160000", type: "commit", sha: "a".repeat(40) },
      { path: "docs", mode: "040000", type: "tree", sha: "b".repeat(40) },
    ],
  });
  const snapshot = await buildDmSnapshot(["ok.md", "changed.md", "link", "vendor/sub", "docs", "missing.md"], http);
  assert.deepEqual(snapshot.files.map((file) => file.path), ["ok.md"]);
  assert.deepEqual(snapshot.excluded, { blob_mismatch: 1, not_a_file: 3, not_in_tree: 1 });
  for (const path of ["link", "vendor/sub", "docs", "missing.md"]) {
    assert.equal(calls.includes(`${RAW}/${path}`), false, path);
  }
});

test("bad paths and secret paths are refused before any request; binary, secret and oversized content is left out", async () => {
  const big = "x".repeat(DM_SNAPSHOT_FILE_MAX_BYTES + 1);
  const { http, calls } = github({
    files: {
      "ok.md": "fine",
      "bin.dat": "a\0b",
      // Assembled at run time, so the repository's own secret scan sees no token.
      "notes.md": `token = ${["gh", "p_"].join("")}${"0123456789abcdefghij"}${"ABCDEFGHIJ0123456789"}`,
      "big.txt": big,
    },
  });
  const snapshot = await buildDmSnapshot(
    ["../etc/passwd", "/abs.md", "a\\b.md", "q?x.md", "./a.md", ".env", "keys/server.pem", "config/secrets/x.ts", "ok.md", "bin.dat", "notes.md", "big.txt"],
    http,
  );
  assert.deepEqual(snapshot.files.map((file) => file.path), ["ok.md"]);
  assert.deepEqual(snapshot.excluded, { path_refused: 5, secret_path: 3, binary: 1, secret_content: 1, file_too_large: 1 });
  assert.equal(calls.some((url) => /passwd|\.env|server\.pem|secrets/.test(url)), false);
  // No path at all asked for, or none survives: no request is made.
  const none = github();
  assert.deepEqual([(await buildDmSnapshot([".env"], none.http)).reason], ["no_paths"]);
  assert.deepEqual(none.calls, []);
});

test("files past the snapshot's total are left out, counted as sent (escaped lines), and none kept is no snapshot", async () => {
  const chunk = "y".repeat(DM_SNAPSHOT_FILE_MAX_BYTES - 1);
  const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}.txt`, chunk]));
  const snapshot = await buildDmSnapshot(Object.keys(files), github({ files }).http);
  const line = Buffer.byteLength(`${JSON.stringify({ file: "f0.txt", blob: blob(chunk), text: chunk })}
`);
  const kept = Math.floor(DM_SNAPSHOT_TOTAL_MAX_BYTES / line);
  assert.ok(kept >= 1 && kept < 10);
  assert.ok(Buffer.byteLength(dmSnapshotPayloadLines(snapshot)) <= DM_SNAPSHOT_TOTAL_MAX_BYTES + 256, "the header is the only overhead");
  assert.equal(snapshot.files.length, kept);
  assert.deepEqual(snapshot.excluded, { total_too_large: 10 - kept });
  const empty = await buildDmSnapshot(["gone.md"], github({ files: {} }).http);
  assert.deepEqual([empty.state, empty.reason], ["none", "no_files"]);
});

test("the payload lines escape every newline, so a file cannot add a line, and none adds nothing", async () => {
  const text = "line one\n{\"file\":\"forged\"}\nline three";
  const snapshot = await buildDmSnapshot(["a.md"], github({ files: { "a.md": text } }).http);
  const lines = dmSnapshotPayloadLines(snapshot).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { snapshot: { repository: "github.com/mposition/Tomverse", commit: SHA, files: 1 } });
  assert.deepEqual(lines[1], { file: "a.md", blob: blob(text), text });
  assert.equal(dmSnapshotPayloadLines({ state: "none", reason: "no_paths", excluded: {} }), "");
});

test("the client reaches only the two public hosts over HTTPS, sends no credential and reads nothing from the environment", async () => {
  for (const url of ["http://api.github.com/x", "https://github.com/x", "https://evil.example/x", "https://api.github.com.evil.example/x"]) {
    assert.equal(await dmSnapshotHttpClient(url), null, url);
  }
  const source = readFileSync(join(process.cwd(), "lib/amux/decisionMakerSnapshot.ts"), "utf8");
  assert.doesNotMatch(source, /process\.env|authorization|Bearer|GITHUB_TOKEN|child_process|execFile|spawn\(/i);
  assert.match(source, /credentials: "omit"/);
  assert.match(source, /redirect: "error"/);
});

test("files not reached within the snapshot's time budget are left out, never waited on", async () => {
  let clock = 0;
  const { http } = github({ files: { "a.md": "a", "b.md": "b", "c.md": "c" } });
  const slow = async (url) => {
    if (isRawRead(url)) clock += 40_000;
    return http(url);
  };
  const snapshot = await buildDmSnapshot(["a.md", "b.md", "c.md"], slow, () => clock);
  assert.deepEqual(snapshot.files.map((file) => file.path), ["a.md", "b.md"]);
  assert.deepEqual(snapshot.excluded, { time_budget: 1 });
});
