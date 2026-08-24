import { strict as assert } from "node:assert";
import test from "node:test";

import { admitTranscriptAttachmentObjects } from "../lib/messageAttachmentCore.ts";

/**
 * The refusal a retry could not get past.
 *
 * `/api/chat` deduplicated attachment references across the *whole*
 * transcript. A failed turn stays on screen with its file cards -- that is
 * deliberate, it is where the draft lives -- so pressing retry sent a
 * transcript in which one upload id appeared twice, and the request was
 * refused with `DUPLICATE_ATTACHMENT_OBJECT` before it reached a model. Every
 * press produced the same refusal, and the only other button on the card was
 * the same button.
 *
 * Both halves are fixed here, so neither can be lost to the other: the turn
 * still may not name one object twice, and the transcript still may.
 */

const admit = (turn, history = [], maxDistinctObjects = 30) =>
  admitTranscriptAttachmentObjects({ turn, history, maxDistinctObjects });

test("a turn naming one object twice is refused", () => {
  // The abuse this rule exists for: five reference slots, one file, read five
  // times against an allowance that counted five different files.
  const result = admit(["a:1", "a:1"]);
  assert.equal(result.admitted, false);
  assert.equal(result.code, "DUPLICATE_ATTACHMENT_OBJECT");
});

test("the same object in an earlier turn is not a duplicate", () => {
  // The retry. `a:1` was sent, refused, and is being sent again -- and the
  // failed turn has not left the transcript yet on an older client.
  const result = admit(["a:1"], ["a:1"]);
  assert.equal(result.admitted, true);
  assert.equal(result.distinctObjectCount, 1);
});

test("a repeat inside the history is not a duplicate either", () => {
  // Nothing in a stored transcript is this request's decision to refuse, and
  // the route already re-reads every message's attachments on every turn -- a
  // repeat costs what the second message always cost.
  const result = admit([], ["u:7", "u:7", "a:2"]);
  assert.equal(result.admitted, true);
  assert.equal(result.distinctObjectCount, 2);
});

test("the conversation cap counts objects, not mentions", () => {
  // Three mentions of two files is two files. Counting mentions would let a
  // long conversation hit an object cap it never reached.
  const history = ["a:1", "a:1", "a:2"];
  assert.deepEqual(admit([], history, 2), {
    admitted: true,
    distinctObjectCount: 2,
  });
  const overflow = admit(["a:3"], history, 2);
  assert.equal(overflow.admitted, false);
  assert.equal(overflow.code, "TOO_MANY_ATTACHMENT_OBJECTS");
});

test("the turn's own duplicate is refused before the cap is measured", () => {
  // Order matters for which sentence the user reads: "the same file twice" is
  // actionable, "this conversation is full" is not, and only one of them is
  // true.
  const result = admit(["a:1", "a:1"], [], 0);
  assert.equal(result.admitted, false);
  assert.equal(result.code, "DUPLICATE_ATTACHMENT_OBJECT");
});

test("entries that name no object are skipped rather than compared", () => {
  // A guest reference resolves to its own key; anything else contributes no
  // identity, and two of them are not two mentions of one file.
  const result = admit([null, null], [null]);
  assert.equal(result.admitted, true);
  assert.equal(result.distinctObjectCount, 0);
});

test("a turn with no attachments is admitted", () => {
  const result = admit([]);
  assert.equal(result.admitted, true);
  assert.equal(result.distinctObjectCount, 0);
});

test("guest keys and resolved references share one identity space", () => {
  // The identity is whatever the caller minted. A guest object's key is the
  // only name it has, and it must still be refused twice in one turn.
  const result = admit(["k:guest/abc", "k:guest/abc"]);
  assert.equal(result.admitted, false);
  assert.equal(result.code, "DUPLICATE_ATTACHMENT_OBJECT");
});
