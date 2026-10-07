import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { openAmuxContent, sealAmuxContent, verifyAmuxContentDigest } from
  "../lib/amux/ideaCrypto.ts";
import { v22TaskResultIdeaId, v22TaskResultSha256 } from
  "../lib/amux/v22TaskResultStore.ts";

const attemptId = "00000000-0000-4000-8000-000000000001";
const ideaId = "00000000-0000-4000-8000-000000000002";

test("task result envelope binds one attempt and cannot be opened as another", () => {
  const keys = { masterKeyId: "amux2-synthetic", masterKeyVersion: 1,
    masterKey: Buffer.alloc(32, 3), digestKeyId: "synthetic",
    digestKey: Buffer.alloc(32, 4) };
  const body = Buffer.from("Synthetic private review result", "utf8");
  const sealed = sealAmuxContent(body, "task_result", attemptId, keys);
  assert.equal(sealed.ciphertext.includes(body), false);
  const opened = openAmuxContent(sealed, "task_result", attemptId, keys);
  assert.equal(opened.toString("utf8"), body.toString("utf8"));
  assert.equal(verifyAmuxContentDigest(opened, "task_result", attemptId,
    sealed.digest, sealed.digestKeyId, keys), true);
  assert.throws(() => openAmuxContent(sealed, "task_result", ideaId, keys));
  assert.equal(v22TaskResultSha256(body.toString("utf8")),
    createHash("sha256").update(body).digest("hex"));
  assert.equal(v22TaskResultIdeaId({ schemaVersion: "amux-v4", ideaId }), ideaId);
  assert.equal(v22TaskResultIdeaId({ schemaVersion: "amux-v3", ideaId }), null);
  opened.fill(0); body.fill(0); keys.masterKey.fill(0); keys.digestKey.fill(0);
});
