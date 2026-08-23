import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_ATTACHMENT_ERROR_COPY_KEYS,
  chatAttachmentErrorCopyKey,
} from "../lib/chatAttachmentErrorCopy.ts";
import { CHAT_ARCHIVE_ERROR_CODES } from "../lib/chatArchiveLimits.ts";
import { de } from "../locales/de.ts";
import { en } from "../locales/en.ts";
import { es } from "../locales/es.ts";
import { fr } from "../locales/fr.ts";
import { ko } from "../locales/ko.ts";
import { pt } from "../locales/pt.ts";
import { zh } from "../locales/zh.ts";

/**
 * The signed-in upload path used to discard every reason the server gave and
 * show "Couldn't upload the file. Please try again." for all of them. These
 * assertions are what stops a refusal code shipping without a sentence, in
 * any locale.
 */

const locales = { en, ko, zh, fr, de, es, pt };

const lookup = (dictionary, key) =>
  key.split(".").reduce((node, part) => (node ? node[part] : undefined), dictionary);

test("every mapped code resolves to a key every locale answers", () => {
  for (const [code, key] of Object.entries(CHAT_ATTACHMENT_ERROR_COPY_KEYS)) {
    for (const [language, dictionary] of Object.entries(locales)) {
      const value = lookup(dictionary, key);
      assert.equal(
        typeof value,
        "string",
        `${language} has no string for ${key} (code ${code})`
      );
      assert.ok(value.trim().length > 0, `${language}.${key} is empty`);
    }
  }
});

test("every archive refusal the server can raise has copy", () => {
  // The one direction that matters: a code the server can produce and the
  // client cannot explain falls back to "try again", which is the exact
  // failure this map exists to end.
  for (const code of Object.values(CHAT_ARCHIVE_ERROR_CODES)) {
    assert.ok(
      chatAttachmentErrorCopyKey(code),
      `${code} has no copy key`
    );
  }
});

test("an unknown or absent code resolves to nothing, so the caller can fall back", () => {
  assert.equal(chatAttachmentErrorCopyKey(undefined), null);
  assert.equal(chatAttachmentErrorCopyKey(null), null);
  assert.equal(chatAttachmentErrorCopyKey(""), null);
  assert.equal(chatAttachmentErrorCopyKey("SOMETHING_NEW"), null);
});

test("the archive exclusion notice carries a count placeholder in every locale", () => {
  for (const [language, dictionary] of Object.entries(locales)) {
    const copy = lookup(dictionary, "chat.archiveExcludedNotice");
    assert.ok(copy.includes("{count}"), `${language} lost the count placeholder`);
  }
});

test("guest and account codes for the same cause do not answer differently by accident", () => {
  // Where a guest code exists it is deliberately its own sentence (a guest is
  // told what signing in would change); where it does not, both paths share
  // one.
  assert.equal(
    chatAttachmentErrorCopyKey("ATTACHMENT_TYPE_MISMATCH"),
    chatAttachmentErrorCopyKey("GUEST_ATTACHMENT_TYPE_MISMATCH")
  );
  assert.notEqual(
    chatAttachmentErrorCopyKey("ATTACHMENT_NO_TEXT"),
    chatAttachmentErrorCopyKey("GUEST_ATTACHMENT_NO_TEXT")
  );
});
