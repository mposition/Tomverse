import { strict as assert } from "node:assert";
import test from "node:test";

import {
  ATTACHMENT_CHAT_ERROR_CODES,
  classifyChatError,
} from "../lib/chatErrorCategory.ts";
import { CHAT_ATTACHMENT_ERROR_COPY_KEYS } from "../lib/chatAttachmentErrorCopy.ts";
import { en } from "../locales/en.ts";
import { ko } from "../locales/ko.ts";

/**
 * Which recovery a failed turn is offered, decided by the code the server
 * sent rather than by reading its sentence.
 *
 * The old rule was `errorHadAttachments && /pdf|office|unsupported|invalid/`
 * over the rendered message. "Duplicate attachment objects are not allowed."
 * contains none of those words, so the refusal was classified `generic`, the
 * card offered only "try again", and trying again re-sent the transcript that
 * had just been refused. The sentence is translated and rewritable; the code
 * is neither.
 */

test("a duplicate-attachment refusal offers the attachment recovery", () => {
  assert.equal(
    classifyChatError({
      errorCode: "DUPLICATE_ATTACHMENT_OBJECT",
      content: "Duplicate attachment objects are not allowed.",
      errorHadAttachments: true,
    }),
    "attachment"
  );
});

test("the sentence no longer decides anything a code can decide", () => {
  // Same words the old heuristic keyed on, and a code that says otherwise.
  assert.equal(
    classifyChatError({
      errorCode: "CHAT_QUOTA_EXCEEDED",
      content: "The attached PDF is invalid.",
      errorHadAttachments: true,
    }),
    "quota"
  );
  // And the reverse: an attachment code whose sentence contains none of them.
  assert.equal(
    classifyChatError({
      errorCode: "ARCHIVE_TOO_MANY_ENTRIES",
      content: "압축파일에 너무 많은 파일이 들어 있습니다.",
      errorHadAttachments: true,
    }),
    "attachment"
  );
});

test("a retired model keeps its own category", () => {
  assert.equal(
    classifyChatError({ errorCode: "MODEL_RETIRED", content: "" }),
    "model_retired"
  );
});

test("an unknown code is generic rather than guessed at", () => {
  // A code this build does not know is a gap in this table, and reading the
  // sentence to fill it is what the table replaced.
  assert.equal(
    classifyChatError({
      errorCode: "SOMETHING_NEW",
      content: "The attached PDF is invalid.",
      errorHadAttachments: true,
    }),
    "generic"
  );
});

test("a message with no code at all still falls back to its sentence", () => {
  // Persisted before `errorCode` travelled with the message. Dropping the
  // fallback would silently downgrade every one of those cards.
  assert.equal(
    classifyChatError({
      content: "The attached PDF is invalid.",
      errorHadAttachments: true,
    }),
    "attachment"
  );
  assert.equal(
    classifyChatError({
      content: "The attached PDF is invalid.",
      errorHadAttachments: false,
    }),
    "generic",
    "a turn that carried no files cannot be recovered by dropping files"
  );
});

test("every attachment refusal has a sentence in every locale", () => {
  // The defect this pair of tables fixes is a refusal reaching the panel as
  // the server's English. A code that is classified as an attachment failure
  // but has no copy key does exactly that.
  const missingKey = [...ATTACHMENT_CHAT_ERROR_CODES].filter(
    (code) => !CHAT_ATTACHMENT_ERROR_COPY_KEYS[code]
  );
  assert.deepEqual(missingKey, []);

  const read = (dictionary, key) =>
    key.split(".").reduce((node, part) => node?.[part], dictionary);
  const missingCopy = [...ATTACHMENT_CHAT_ERROR_CODES].filter((code) => {
    const key = CHAT_ATTACHMENT_ERROR_COPY_KEYS[code];
    return !read(en, key) || !read(ko, key);
  });
  assert.deepEqual(missingCopy, []);
});

test("the new send-path sentences are not the English ones", () => {
  // `locales/ko.ts` carrying the English string would render exactly the
  // symptom that started this: an English sentence in a Korean conversation.
  for (const key of [
    "duplicateAttachmentObject",
    "conversationAttachmentLimit",
    "guestConversationAttachmentLimit",
  ]) {
    assert.ok(en.chat[key], `en is missing chat.${key}`);
    assert.ok(ko.chat[key], `ko is missing chat.${key}`);
    assert.notEqual(ko.chat[key], en.chat[key]);
  }
});
