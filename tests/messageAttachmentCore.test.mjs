import assert from "node:assert/strict";
import test from "node:test";

import {
  MESSAGE_ATTACHMENT_KINDS,
  PUBLIC_MESSAGE_ATTACHMENT_SELECT,
  isTurnAttachmentHandle,
  messageAttachmentReferenceSchema,
  toPublicMessageAttachment,
  turnAttachmentHandle,
} from "../lib/messageAttachmentCore.ts";

// docs/policy/user-attachment-persistence.md.
//
// The rule every test here serves: a client never names a storage location.
// It names an opaque id the server issued, and the server resolves the key
// itself. A key that arrived in a request body is a claim; a row the server
// wrote is a fact.

/* -------------------------------------------------------------------------- */
/* References                                                                   */
/* -------------------------------------------------------------------------- */

test("an attachment must be referenced by one of the two opaque ids", () => {
  assert.equal(
    messageAttachmentReferenceSchema.safeParse({ uploadId: "upl_1" }).success,
    true
  );
  assert.equal(
    messageAttachmentReferenceSchema.safeParse({ attachmentId: "att_1" }).success,
    true
  );
  assert.equal(
    messageAttachmentReferenceSchema.safeParse({ name: "a.pdf" }).success,
    false
  );
});

// The whole point of the change. A signed-in client used to send the storage
// key, and every route that read one had to decide whether to believe it.
test("a storage key is not an accepted reference field", () => {
  const parsed = messageAttachmentReferenceSchema.safeParse({
    uploadId: "upl_1",
    objectKey: "attachments/abcdef/2026-08-22/x.pdf",
  });
  assert.equal(parsed.success, false);
});

test("bytes, data URLs and extracted text are not accepted either", () => {
  for (const extra of [
    { data: "data:application/pdf;base64,AAAA" },
    { bytes: "AAAA" },
    { text: "extracted" },
    { path: "/tmp/x.pdf" },
  ]) {
    assert.equal(
      messageAttachmentReferenceSchema.safeParse({ uploadId: "upl_1", ...extra })
        .success,
      false,
      `${Object.keys(extra)[0]} was accepted`
    );
  }
});

// Allowed through because the card must render before the round trip -- and
// believed by nothing: every one of them is re-read from the resolved row.
test("the descriptive fields are optional and carry no authority", () => {
  const parsed = messageAttachmentReferenceSchema.safeParse({
    uploadId: "upl_1",
    name: "계약서.docx",
    mediaType: "text/plain",
    size: 1,
    kind: "text",
  });
  assert.equal(parsed.success, true);
});

/* -------------------------------------------------------------------------- */
/* Kinds                                                                        */
/* -------------------------------------------------------------------------- */

// Two kinds, and the derivation is NOT here: `lib/chatAttachmentFormats.ts`
// decides what a file is (by name first, then by declared type) and
// `attachmentKindForFormat` reads the kind off that decision. A second
// derivation from the media type alone would disagree with it for every format
// the table places by extension -- which is most of the code formats.
test("there are exactly two kinds", () => {
  assert.deepEqual([...MESSAGE_ATTACHMENT_KINDS], ["file", "text"]);
});

/* -------------------------------------------------------------------------- */
/* What leaves the server                                                       */
/* -------------------------------------------------------------------------- */

test("the public shape is an allowlist that cannot carry a storage key", () => {
  const row = {
    id: "ma_1",
    ordinal: 0,
    name: "계약서.docx",
    mediaType: "application/pdf",
    size: 1234,
    kind: "file",
    // Everything below is on the row and must not survive the narrowing.
    objectKey: "attachments/abcdef/2026-08-22/x.pdf",
    userId: "user-1",
    conversationId: "conversation-1",
    messageId: "message-1",
    uploadId: "upl_1",
  };
  const publicShape = toPublicMessageAttachment(row);
  // The availability fields are absent, not null: a row that has never been
  // checked and one that was checked and found are the same thing to a client
  // (tests/messageAttachmentAvailability.test.mjs covers the missing case).
  assert.deepEqual(Object.keys(publicShape).sort(), [
    "id",
    "kind",
    "mediaType",
    "name",
    "ordinal",
    "size",
  ]);
  assert.equal(JSON.stringify(publicShape).includes("attachments/"), false);
  assert.equal(JSON.stringify(publicShape).includes("user-1"), false);
});

// The narrowing and the database select have to describe the same fields, or
// a route selects a column the type says is not there.
test("the Prisma select and the public shape name the same fields", () => {
  assert.deepEqual(
    Object.keys(PUBLIC_MESSAGE_ATTACHMENT_SELECT).sort(),
    [
      "id",
      "kind",
      "mediaType",
      "name",
      "ordinal",
      "size",
      // The availability verdict, added so a card that lost its bytes still
      // says so after a reload. A verdict, never a location.
      "unavailableAt",
      "unavailableReason",
    ]
  );
  assert.equal(
    Object.values(PUBLIC_MESSAGE_ATTACHMENT_SELECT).every(
      (value) => value === true
    ),
    true
  );
  assert.equal("objectKey" in PUBLIC_MESSAGE_ATTACHMENT_SELECT, false);
});

test("an unrecognised stored kind narrows to file rather than leaking through", () => {
  assert.equal(
    toPublicMessageAttachment({
      id: "ma_1",
      ordinal: 0,
      name: "x",
      mediaType: "application/pdf",
      size: 1,
      kind: "something-else",
    }).kind,
    "file"
  );
});

/* -------------------------------------------------------------------------- */
/* Turn handles                                                                 */
/* -------------------------------------------------------------------------- */

// A model's handle can end up quoted in an answer, so it addresses a position
// in one request and nothing else -- not a row, not an object, not a route.
test("a turn handle names a position, one-based", () => {
  assert.equal(turnAttachmentHandle(0), "att_1");
  assert.equal(turnAttachmentHandle(2), "att_3");
});

test("only a well-formed handle is recognised", () => {
  assert.equal(isTurnAttachmentHandle("att_1"), true);
  assert.equal(isTurnAttachmentHandle("att_100"), true);
  for (const bad of [
    "att_0",
    "att_",
    "att_01",
    "attachments/abc/x.pdf",
    "../att_1",
    "ATT_1",
    1,
    null,
  ]) {
    assert.equal(isTurnAttachmentHandle(bad), false, `${bad} was accepted`);
  }
});
