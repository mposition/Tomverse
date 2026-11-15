import assert from "node:assert/strict";
import test from "node:test";

import { gitObjectId } from "../lib/engineeringAgentTreeVerify.ts";
import { verifyEngineeringAgentV22SparseCandidate } from
  "../lib/engineeringAgentV22SparseCandidate.ts";
import { loadEngineeringAgentV22Candidate } from
  "../lib/engineeringAgentV22CandidateLoad.ts";

const before = Buffer.from("export const value = 1;\n");
const after = Buffer.from("export const value = 2;\n");
const beforeOid = gitObjectId("blob", before);
const treeBody = Buffer.concat([Buffer.from("100644 file.ts\0"),
  Buffer.from(beforeOid, "hex")]);
const root = gitObjectId("tree", treeBody);
const base = [{ path: "file.ts", mode: "100644", type: "blob",
  oid: beforeOid }];
const write = { kind: "write", path: "file.ts", mode: "100644",
  bytes: after, exists: true };
const input = { base, baseRootTreeId: root, baseGitattributes: null,
  changes: [write], baseBlobs: new Map([[beforeOid, before]]) };

test("v22 sparse candidate yields only a verified change set, not T1 authority", () => {
  const result = verifyEngineeringAgentV22SparseCandidate(input);
  assert.equal(result.ok, true);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].path, "file.ts");
  assert.equal(result.changes[0].addedText, "export const value = 2;");
  assert.match(result.expectedTreeId, /^[0-9a-f]{40}$/);
  assert.deepEqual(result.unsupported, []);
});

test("v22 sparse candidate refuses missing base bytes, an unsafe path and a secret", () => {
  assert.deepEqual(verifyEngineeringAgentV22SparseCandidate({ ...input,
    baseBlobs: new Map() }), { ok: false, reason: "base_mismatch" });
  assert.deepEqual(verifyEngineeringAgentV22SparseCandidate({ ...input,
    changes: [{ ...write, path: "../file.ts" }] }),
  { ok: false, reason: "base_mismatch" });
  // Built at run time, so no scanner reads a credential-shaped literal here.
  const token = ["gh", "p_", "Q".repeat(36)].join("");
  assert.deepEqual(verifyEngineeringAgentV22SparseCandidate({ ...input,
    changes: [{ ...write, bytes: Buffer.from(`export const t = "${token}";\n`) }] }),
  { ok: false, reason: "secret_detected" });
  // A binary file is read byte for byte, so a token inside it is still seen.
  assert.deepEqual(verifyEngineeringAgentV22SparseCandidate({ ...input,
    changes: [{ ...write, bytes: Buffer.concat([Buffer.from([0, 255, 254]),
      Buffer.from(token), Buffer.from([0])]) }] }),
  { ok: false, reason: "secret_detected" });
});

test("v22 sparse candidate creates and deletes files, and reports what it does not support", () => {
  const created = { kind: "write", path: "lib/new.ts", mode: "100755",
    bytes: Buffer.from("#!/usr/bin/env node\n"), exists: false };
  const result = verifyEngineeringAgentV22SparseCandidate({ ...input,
    baseGitattributes: "lib/** text\n", changes: [write, created] });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.changes.map((entry) => [entry.path, entry.status,
    entry.oldMode, entry.newMode]), [["file.ts", "modified", "100644",
    "100644"], ["lib/new.ts", "added", null, "100755"]]);
  // Unsupported is reported for the tier gate (T2), not refused here.
  assert.deepEqual(result.unsupported,
    [{ reason: "gitattributes_applies", path: "lib/new.ts" }]);
  const deleted = verifyEngineeringAgentV22SparseCandidate({ ...input,
    changes: [{ kind: "delete", path: "file.ts" }, created] });
  assert.equal(deleted.ok, true, deleted.reason);
  assert.deepEqual(deleted.changes.map((entry) => entry.status),
    ["deleted", "added"]);
  assert.deepEqual(verifyEngineeringAgentV22SparseCandidate({ ...input,
    changes: [{ ...created, path: "file.ts" }] }),
  { ok: false, reason: "path_conflict" });
});

test("the loader reads only the named old blobs and wipes their bytes", async () => {
  const fetched = Buffer.from(before);
  const reads = [];
  const patchText = "diff --git a/file.ts b/file.ts\n" +
    `index ${beforeOid}..${gitObjectId("blob", after)} 100644\n` +
    "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n" +
    "-export const value = 1;\n+export const value = 2;\n";
  const result = await loadEngineeringAgentV22Candidate({
    baseSha: "a".repeat(40), patchText,
  }, {
    readBase: async (sha) => {
      reads.push(`base:${sha}`);
      return { base, rootTreeId: root, baseGitattributes: null };
    },
    readBlob: async (oid) => { reads.push(`blob:${oid}`); return fetched; },
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.baseRootTreeId, root);
  assert.deepEqual(reads, [`base:${"a".repeat(40)}`, `blob:${beforeOid}`]);
  assert.deepEqual(fetched, Buffer.alloc(before.length));
});

test("invalid paths never reach GitHub", async () => {
  let reads = 0;
  const result = await loadEngineeringAgentV22Candidate({
    baseSha: "a".repeat(40), patchText: "diff --git a/../file.ts b/../file.ts\n" +
      "old mode 100644\nnew mode 100755\n",
  }, {
    readBase: async () => { reads++; throw new Error("unexpected read"); },
    readBlob: async () => { reads++; throw new Error("unexpected read"); },
  });
  assert.deepEqual(result, { ok: false, reason: "path_invalid" });
  assert.equal(reads, 0);
});
