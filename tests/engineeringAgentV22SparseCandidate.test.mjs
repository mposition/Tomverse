import assert from "node:assert/strict";
import test from "node:test";

import { gitObjectId } from "../lib/engineeringAgentTreeVerify.ts";
import { verifyEngineeringAgentV22SparseCandidate } from
  "../lib/engineeringAgentV22SparseCandidate.ts";

const before = Buffer.from("export const value = 1;\n");
const after = Buffer.from("export const value = 2;\n");
const beforeOid = gitObjectId("blob", before);
const treeBody = Buffer.concat([Buffer.from("100644 file.ts\0"),
  Buffer.from(beforeOid, "hex")]);
const root = gitObjectId("tree", treeBody);
const base = [{ path: "file.ts", mode: "100644", type: "blob",
  oid: beforeOid }];
const file = { path: "file.ts", mode: "100644",
  bytesBase64: after.toString("base64") };
const input = { base, baseRootTreeId: root, baseGitattributes: null,
  files: [file], baseBlobs: new Map([[beforeOid, before]]) };

test("v22 sparse candidate yields only a verified change set, not T1 authority", () => {
  const result = verifyEngineeringAgentV22SparseCandidate(input);
  assert.equal(result.ok, true);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].path, "file.ts");
  assert.equal(result.changes[0].addedText, "export const value = 2;");
  assert.match(result.expectedTreeId, /^[0-9a-f]{40}$/);
});

test("v22 sparse candidate refuses missing base bytes and unsafe evidence", () => {
  assert.deepEqual(verifyEngineeringAgentV22SparseCandidate({ ...input,
    baseBlobs: new Map() }), { ok: false, reason: "base_blob_missing" });
  assert.deepEqual(verifyEngineeringAgentV22SparseCandidate({ ...input,
    files: [{ ...file, path: "../file.ts" }] }),
  { ok: false, reason: "files_invalid" });
});
