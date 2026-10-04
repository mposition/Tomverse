import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { openAmuxIdeaKey, sealAmuxIdeaKey } from
  "../lib/amux/ideaKeyStore.ts";

const ideaId = "1e5f6f12-4281-4879-ae75-8ab0d2a57b44";
const otherIdeaId = "ed543d85-b0cb-4ffc-ace1-4cc4142f0d86";

test("idea content key is opaque and bound to its one idea", () => {
  const wrapping = randomBytes(32);
  const content = randomBytes(32);
  const stored = sealAmuxIdeaKey(ideaId, content, wrapping);
  assert.equal(stored.includes(content), false);
  assert.deepEqual(openAmuxIdeaKey(ideaId, stored, wrapping), content);
  assert.throws(() => openAmuxIdeaKey(otherIdeaId, stored, wrapping),
    { code: "integrity_unavailable" });
  stored[stored.length - 1] ^= 1;
  assert.throws(() => openAmuxIdeaKey(ideaId, stored, wrapping),
    { code: "integrity_unavailable" });
});

test("idea key envelope refuses invalid IDs and wrong key sizes", () => {
  assert.throws(() => sealAmuxIdeaKey("../other", randomBytes(32), randomBytes(32)),
    { code: "integrity_unavailable" });
  assert.throws(() => sealAmuxIdeaKey(ideaId, randomBytes(31), randomBytes(32)),
    { code: "integrity_unavailable" });
  assert.throws(() => openAmuxIdeaKey(ideaId, Buffer.alloc(0), randomBytes(32)),
    { code: "integrity_unavailable" });
});
