import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { loadCurrentAmuxContentKeys } from "../lib/amux/ideaKeyConfig.ts";

const validEnv = () => ({
  AMUX_V4_CONTENT_MASTER_KEY_ID: "master-test-1",
  AMUX_V4_CONTENT_MASTER_KEY_VERSION: "1",
  AMUX_V4_CONTENT_MASTER_KEY_B64: randomBytes(32).toString("base64"),
  AMUX_V4_CONTENT_DIGEST_KEY_ID: "digest-test-1",
  AMUX_V4_CONTENT_DIGEST_KEY_B64: randomBytes(32).toString("base64"),
});

test("AMUX v4 app-only key loader requires exact 256-bit independent keys", () => {
  const env = validEnv();
  const loaded = loadCurrentAmuxContentKeys(env);
  assert.equal(loaded.masterKey.length, 32);
  assert.equal(loaded.digestKey.length, 32);
  assert.notDeepEqual(loaded.masterKey, loaded.digestKey);
  assert.equal(loaded.masterKeyVersion, 1);
  assert.throws(() => loadCurrentAmuxContentKeys({ ...env, AMUX_V4_CONTENT_MASTER_KEY_B64: randomBytes(31).toString("base64") }));
  assert.throws(() => loadCurrentAmuxContentKeys({ ...env, AMUX_V4_CONTENT_MASTER_KEY_B64: `${env.AMUX_V4_CONTENT_MASTER_KEY_B64}\n` }));
  assert.throws(() => loadCurrentAmuxContentKeys({ ...env, AMUX_V4_CONTENT_MASTER_KEY_VERSION: "0" }));
  assert.throws(() => loadCurrentAmuxContentKeys({ ...env, AMUX_V4_CONTENT_MASTER_KEY_VERSION: "4294967296" }));
  assert.throws(() => loadCurrentAmuxContentKeys({ ...env, AMUX_V4_CONTENT_DIGEST_KEY_ID: "../digest" }));
  assert.throws(() => loadCurrentAmuxContentKeys({ ...env, AMUX_V4_CONTENT_DIGEST_KEY_B64: env.AMUX_V4_CONTENT_MASTER_KEY_B64 }));
});
