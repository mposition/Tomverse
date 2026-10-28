import assert from "node:assert/strict";
import test from "node:test";

import { CHAT_UNIFIED_OPTIMIZER_AMUX_SOURCE_PIN_ENV as key,
  readChatUnifiedOptimizerAmuxSourcePin } from
  "../lib/chatUnifiedOptimizerAmuxSourcePin.ts";

const pin = { repositoryId: 123, commitSha: "a".repeat(40),
  blobSha: "b".repeat(40), sha256: "c".repeat(64) };

test("only an exact server-pinned public source is accepted", () => {
  assert.deepEqual(readChatUnifiedOptimizerAmuxSourcePin(
    { [key]: JSON.stringify(pin) }), pin);
  for (const value of [undefined, "{}", JSON.stringify({ ...pin, extra: true }),
    JSON.stringify({ ...pin, commitSha: "main" }),
    JSON.stringify({ ...pin, sha256: "C".repeat(64) }),
    " ".repeat(2_049)]) {
    assert.throws(() => readChatUnifiedOptimizerAmuxSourcePin(
      { [key]: value }), /optimizer_amux_source_pin_unavailable/);
  }
});
