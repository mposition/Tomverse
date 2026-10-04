import assert from "node:assert/strict";
import test from "node:test";

import { scopedMessageId } from "../../lib/messageRequestIdentity.ts";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

test("a client request id deterministically maps inside its conversation namespace", () => {
  const first = scopedMessageId("conversation-a", REQUEST_ID);
  // This is a persistence contract, not merely same-process determinism. Pin
  // one known answer so a namespace, delimiter or hashing change cannot make
  // retries after a rolling deploy address a different Message row.
  assert.equal(first, "261122e7-9634-87c9-a6dd-1df1064b9960");
  assert.equal(first, scopedMessageId("conversation-a", REQUEST_ID));
  assert.notEqual(first, REQUEST_ID);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("the same external UUID cannot address a Message in another conversation", () => {
  assert.notEqual(
    scopedMessageId("conversation-a", REQUEST_ID),
    scopedMessageId("conversation-b", REQUEST_ID)
  );
});

test("different request ids in one conversation cannot share an internal Message id", () => {
  assert.notEqual(
    scopedMessageId("conversation-a", REQUEST_ID),
    scopedMessageId("conversation-a", "22222222-2222-4222-8222-222222222222")
  );
});
