import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { openAmuxContentUnitKey, sealAmuxContentUnitKey } from
  "../lib/amux/ideaKeyStore.ts";

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
