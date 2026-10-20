import assert from "node:assert/strict";
import test from "node:test";

import { readChatImageTurnRef } from "../lib/chatImageTurnCore.ts";

test("an image turn ref carries its group and the models the header names", () => {
  assert.deepEqual(
    readChatImageTurnRef({ groupId: "g1", modelIds: ["gpt-image-2", "", 7, "grok"] }),
    { groupId: "g1", modelIds: ["gpt-image-2", "grok"] }
  );
  assert.deepEqual(readChatImageTurnRef({ groupId: "g1" }), { groupId: "g1", modelIds: [] });
});

test("anything without a group id is no image turn", () => {
  for (const value of [null, undefined, "g1", {}, { groupId: "" }, { groupId: 3 }]) {
    assert.equal(readChatImageTurnRef(value), null);
  }
});
