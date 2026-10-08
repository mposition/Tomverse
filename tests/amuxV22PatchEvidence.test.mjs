import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { decodeV22PatchEvidence, encodeV22PatchEvidence,
  v22PublishFilesSha256 } from
  "../lib/amux/v22PatchEvidence.ts";

const text = "diff --git a/components/chat/Safe.tsx b/components/chat/Safe.tsx\n";
const file = { path: "components/chat/Safe.tsx", mode: "100644",
  bytesBase64: Buffer.from("export const safe = true;\n").toString("base64") };

test("sparse file evidence is canonical and reversible without altering patch digest", () => {
  const bytes = encodeV22PatchEvidence(text, [file]);
  assert.deepEqual(decodeV22PatchEvidence(bytes), { text, files: [file] });
  assert.equal(createHash("sha256").update(text).digest("hex").length, 64);
  assert.deepEqual(decodeV22PatchEvidence(encodeV22PatchEvidence(text)),
    { text, files: null });
  assert.equal(v22PublishFilesSha256([file]), createHash("sha256")
    .update(JSON.stringify([file])).digest("hex"));
  assert.notEqual(v22PublishFilesSha256([file]),
    v22PublishFilesSha256([{ ...file, bytesBase64: "YQ==" }]));
});

test("invalid file evidence and secrets fail closed", () => {
  const bad = [
    [{ ...file, path: "../secret" }],
    [file, file],
    [{ ...file, bytesBase64: "YQ===" }],
    [{ ...file, bytesBase64: Buffer.from([0xff]).toString("base64") }],
    [{ ...file, bytesBase64: Buffer.from("a\0b").toString("base64") }],
    [{ ...file, bytesBase64: Buffer.from("ghp_" + "A".repeat(40)).toString("base64") }],
  ];
  for (const files of bad) assert.throws(() =>
    encodeV22PatchEvidence(text, files));
  assert.throws(() => encodeV22PatchEvidence(text + "ghp_" + "A".repeat(40)));
  assert.throws(() => encodeV22PatchEvidence(text, [file,
    { ...file, path: "components/chat/Other.tsx",
      bytesBase64: Buffer.alloc(49 * 1024, 65).toString("base64") }]));
});

test("decoding rejects tampered or noncanonical evidence", () => {
  const canonical = encodeV22PatchEvidence(text, [file]);
  const parsed = JSON.parse(canonical.toString("utf8"));
  parsed.files[0].mode = "100755";
  assert.throws(() => decodeV22PatchEvidence(Buffer.from(JSON.stringify(parsed))));
  parsed.files[0].mode = "100644";
  parsed.extra = true;
  assert.throws(() => decodeV22PatchEvidence(Buffer.from(JSON.stringify(parsed))));
});
