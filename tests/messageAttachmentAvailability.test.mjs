import assert from "node:assert/strict";
import test from "node:test";

import {
  MESSAGE_ATTACHMENT_UNAVAILABLE_REASONS,
  PUBLIC_MESSAGE_ATTACHMENT_SELECT,
  acknowledgedUnavailableAttachmentsSchema,
  isMessageAttachmentUnavailableReason,
  toPublicMessageAttachment,
} from "../lib/messageAttachmentCore.ts";
import { CHAT_ATTACHMENT_ERROR_COPY_KEYS } from "../lib/chatAttachmentErrorCopy.ts";
import { en } from "../locales/en.ts";
import { ko } from "../locales/ko.ts";
import { de } from "../locales/de.ts";
import { es } from "../locales/es.ts";
import { fr } from "../locales/fr.ts";
import { pt } from "../locales/pt.ts";
import { zh } from "../locales/zh.ts";

const LOCALES = { en, ko, de, es, fr, pt, zh };

/** Every string in a locale, wherever it is nested. */
const stringsUnder = (value, key) => {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    for (const [name, child] of Object.entries(node)) {
      if (name === key && typeof child === "string") found.push(child);
      else walk(child);
    }
  };
  walk(value);
  return found;
};

const row = (overrides = {}) => ({
  id: "att_1",
  ordinal: 0,
  name: "contract.pdf",
  mediaType: "application/pdf",
  size: 1234,
  kind: "file",
  objectKey: "attachments/9f2caa/contract.pdf",
  ...overrides,
});

test("an ordinary attachment carries no availability fields at all", () => {
  const publicShape = toPublicMessageAttachment(row());
  // Absent, not `null`: a card that has never been checked and one that was
  // checked and found are the same thing to a client, and a null would invite
  // it to distinguish them.
  assert.equal("unavailableAt" in publicShape, false);
  assert.equal("unavailableReason" in publicShape, false);
});

test("a missing attachment carries a verdict and never a location", () => {
  const publicShape = toPublicMessageAttachment(
    row({
      unavailableAt: new Date("2026-08-27T10:00:00.000Z"),
      unavailableReason: "storage_object_missing",
    })
  );
  assert.equal(publicShape.unavailableAt, "2026-08-27T10:00:00.000Z");
  assert.equal(publicShape.unavailableReason, "storage_object_missing");
  const serialised = JSON.stringify(publicShape);
  assert.ok(!serialised.includes("objectKey"));
  assert.ok(!serialised.includes("attachments/"));
});

test("the name and the size survive, because the card must", () => {
  // docs/policy/user-attachment-persistence.md §11: the row is never deleted
  // and the card is never hidden. A person who cannot see which file was lost
  // cannot re-attach it.
  const publicShape = toPublicMessageAttachment(
    row({ unavailableAt: new Date(), unavailableReason: "storage_object_missing" })
  );
  assert.equal(publicShape.name, "contract.pdf");
  assert.equal(publicShape.size, 1234);
});

test("an unrecognised reason is dropped rather than passed through", () => {
  const publicShape = toPublicMessageAttachment(
    row({ unavailableAt: new Date(), unavailableReason: "eaten_by_a_dog" })
  );
  assert.equal(publicShape.unavailableAt !== undefined, true);
  assert.equal("unavailableReason" in publicShape, false);
  assert.equal(isMessageAttachmentUnavailableReason("eaten_by_a_dog"), false);
});

test("the public select never names the object key", () => {
  assert.equal("objectKey" in PUBLIC_MESSAGE_ATTACHMENT_SELECT, false);
  assert.equal(PUBLIC_MESSAGE_ATTACHMENT_SELECT.unavailableAt, true);
  assert.equal(PUBLIC_MESSAGE_ATTACHMENT_SELECT.unavailableReason, true);
});

test("acknowledgements are a bounded list of ids, not a flag", () => {
  assert.equal(acknowledgedUnavailableAttachmentsSchema.safeParse(undefined).success, true);
  assert.equal(acknowledgedUnavailableAttachmentsSchema.safeParse(["a", "b"]).success, true);
  assert.equal(acknowledgedUnavailableAttachmentsSchema.safeParse(true).success, false);
  assert.equal(
    acknowledgedUnavailableAttachmentsSchema.safeParse(new Array(51).fill("a")).success,
    false
  );
});

test("every unavailable reason is one somebody wrote copy for", () => {
  assert.deepEqual([...MESSAGE_ATTACHMENT_UNAVAILABLE_REASONS], [
    "storage_object_missing",
  ]);
});

/*
  The two codes must not share a sentence.

  One says the bytes are gone and re-reading changes nothing; the other says
  storage did not answer and trying again is exactly right. Collapsing them
  would give one of the two the wrong advice, which is the failure the copy
  table in lib/chatAttachmentErrorCopy.ts was written to end.
*/
test("missing and unreachable get different copy keys in every locale", () => {
  const missing = CHAT_ATTACHMENT_ERROR_COPY_KEYS.ATTACHMENT_UNAVAILABLE;
  const unreachable = CHAT_ATTACHMENT_ERROR_COPY_KEYS.ATTACHMENT_STORAGE_UNAVAILABLE;
  assert.notEqual(missing, unreachable);
  for (const [name, locale] of Object.entries(LOCALES)) {
    for (const key of [
      "attachmentUnavailable",
      "attachmentStorageUnavailable",
      "guestAttachmentExpired",
      "attachmentUnavailableBadge",
      "attachmentContinueWithout",
    ]) {
      const value = locale.chat?.[key];
      assert.equal(typeof value, "string", `${name}.chat.${key}`);
      assert.ok(value.trim().length > 0, `${name}.chat.${key}`);
    }
    assert.notEqual(
      locale.chat.attachmentUnavailable,
      locale.chat.attachmentStorageUnavailable,
      name
    );
  }
});

/*
  The retention sentence and the retention contract have to agree.

  Before this change the settings screen and the privacy text said attachments
  were removed by a lifecycle rule after about a day, while the approved policy
  said they are kept until the conversation or the account is deleted. Both
  sentences were shipped, and the one the bucket believed is the one that
  deleted a user's file.
*/
test("no locale still promises a one-day attachment lifecycle", () => {
  const banned = [
    /approximately one day/i,
    /about one day/i,
    /약 하루/,
    /einem Tag/,
    /un día/i,
    /un jour/i,
    /une journée/i,
    /um dia/i,
    /一天/,
  ];
  for (const [name, locale] of Object.entries(LOCALES)) {
    const retention = [
      ...stringsUnder(locale, "dataRetentionDescription"),
      ...stringsUnder(locale, "attachmentRetentionNotice"),
    ];
    assert.ok(retention.length >= 2, `${name} has retention copy`);
    for (const sentence of retention) {
      for (const pattern of banned) {
        assert.ok(!pattern.test(sentence), `${name}: ${pattern} in "${sentence}"`);
      }
    }
  }
});
