import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

import { amuxContentKeyRing, openAmuxContentUnitKey, sealAmuxContentUnitKey } from
  "../lib/amux/ideaKeyStore.ts";
import { openAmuxContent, sealAmuxContent } from "../lib/amux/ideaCrypto.ts";

const ideaId = "1e5f6f12-4281-4879-ae75-8ab0d2a57b44";
const raw = { ideaId, purpose: "idea_raw", subjectId: ideaId };
const draft1 = { ideaId, purpose: "analysis_draft", subjectId: "1f8c9c77-2e86-483e-8fbb-2d5e2c32ad78" };
const draft2 = { ideaId, purpose: "analysis_draft", subjectId: "fd2d8283-4ca7-40ba-8e94-131625732e53" };

test("each content unit has a separately bound key", () => {
  const wrapping = randomBytes(32);
  const content = randomBytes(32);
  const stored = sealAmuxContentUnitKey(draft1, content, wrapping);
  assert.equal(stored.includes(content), false);
  assert.deepEqual(openAmuxContentUnitKey(draft1, stored, wrapping), content);
  for (const other of [draft2, raw, { ...draft1, ideaId: "ed543d85-b0cb-4ffc-ace1-4cc4142f0d86" }]) {
    assert.throws(() => openAmuxContentUnitKey(other, stored, wrapping),
      { code: "integrity_unavailable" });
  }
  stored[stored.length - 1] ^= 1;
  assert.throws(() => openAmuxContentUnitKey(draft1, stored, wrapping),
    { code: "integrity_unavailable" });
});

test("key envelope refuses invalid coordinates and key sizes", () => {
  assert.throws(() => sealAmuxContentUnitKey({ ...raw, subjectId: "../other" },
    randomBytes(32), randomBytes(32)), { code: "integrity_unavailable" });
  assert.throws(() => sealAmuxContentUnitKey(raw, randomBytes(31), randomBytes(32)),
    { code: "integrity_unavailable" });
  assert.throws(() => openAmuxContentUnitKey(raw, Buffer.alloc(0), randomBytes(32)),
    { code: "integrity_unavailable" });
});

test("preloaded unit ring seals only the exact content coordinate", () => {
  const global = { masterKeyId: "app-master", masterKeyVersion: 1,
    masterKey: randomBytes(32), digestKeyId: "digest", digestKey: randomBytes(32) };
  const digest = createHash("sha256").update(Buffer.from(
    `amux-v4-content-key\0${draft1.ideaId}\0${draft1.purpose}\0${draft1.subjectId}`,
    "utf8")).digest("base64url");
  const unit = { ...global, masterKeyId: `amux2-${digest}`, masterKey: randomBytes(32) };
  const ring = amuxContentKeyRing(global, [{ identity: draft1, keys: unit }]);
  const sealed = sealAmuxContent(Buffer.from("draft"), draft1.purpose,
    draft1.subjectId, ring);
  assert.equal(sealed.keyId, unit.masterKeyId);
  assert.equal(openAmuxContent(sealed, draft1.purpose, draft1.subjectId,
    ring).toString("utf8"), "draft");
  assert.throws(() => sealAmuxContent(Buffer.from("other"), draft2.purpose,
    draft2.subjectId, ring), /content unit key is unavailable/);
  assert.throws(() => openAmuxContent(sealed, draft1.purpose, draft1.subjectId,
    global), /content envelope is invalid/);
  assert.throws(() => amuxContentKeyRing(global, [
    { identity: draft1, keys: unit }, { identity: draft1, keys: unit },
  ]), { code: "conflict" });
});
