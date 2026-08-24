import assert from "node:assert/strict";
import test from "node:test";

import {
  campaignRunRefusal,
  readLocales,
  readPinnedVersions,
  writePinnedVersions,
} from "../lib/emailCampaignCore.ts";

// Whether a campaign may send, and whether what was approved is still what
// would go out (EM-06).
//
// Contract: docs/policy/email-notifications.md §12.3,
// .github/audits/model-lifecycle-email-2026-08-22.md EM-06.

const pinned = (overrides = {}) => [
  { language: "en", templateVersionId: "tv_en", contentHash: "hash-en", ...overrides },
];

const approved = (overrides = {}) => ({
  status: "approved",
  locales: ["en"],
  pinned: pinned(),
  currentHashes: { en: "hash-en" },
  ...overrides,
});

test("an approved campaign whose copy is unchanged may send", () => {
  assert.equal(campaignRunRefusal(approved()), null);
});

test("a running campaign may keep sending", () => {
  // Waves are separate sends; the second one must not be refused for the first
  // having moved the campaign out of `approved`.
  assert.equal(campaignRunRefusal(approved({ status: "running" })), null);
});

test("an unapproved campaign is refused, and says what state it is in", () => {
  for (const status of ["draft", "pending_approval"]) {
    const refusal = campaignRunRefusal(approved({ status }));
    assert.equal(refusal?.refusal, "not_approved", status);
    assert.match(refusal.message, new RegExp(status));
  }
});

test("cancelled, halted and completed each say their own thing", () => {
  // Three different situations for the operator: one is over, one was stopped
  // on purpose, one is finished. A single "cannot send" would flatten them.
  assert.equal(campaignRunRefusal(approved({ status: "cancelled" }))?.refusal, "cancelled");
  assert.equal(campaignRunRefusal(approved({ status: "halted" }))?.refusal, "halted");
  assert.equal(
    campaignRunRefusal(approved({ status: "completed" }))?.refusal,
    "already_completed"
  );
});

test("copy changed after approval refuses the send", () => {
  // EM-06's acceptance criterion. A copy edit mints a new TemplateVersion with
  // nobody approving it, so without this the approval quietly comes to cover
  // text nobody saw.
  const refusal = campaignRunRefusal(
    approved({ currentHashes: { en: "hash-en-edited" } })
  );
  assert.equal(refusal?.refusal, "content_changed");
  assert.deepEqual(refusal.languages, ["en"]);
  assert.match(refusal.message, /Approve the new text/);
});

test("the refusal names every language that changed, not the first", () => {
  const refusal = campaignRunRefusal({
    status: "approved",
    locales: ["en", "ko", "ja"],
    pinned: [
      { language: "en", templateVersionId: "a", contentHash: "en-1" },
      { language: "ko", templateVersionId: "b", contentHash: "ko-1" },
      { language: "ja", templateVersionId: "c", contentHash: "ja-1" },
    ],
    currentHashes: { en: "en-1", ko: "ko-2", ja: "ja-2" },
  });
  assert.equal(refusal?.refusal, "content_changed");
  assert.deepEqual(refusal.languages, ["ko", "ja"]);
});

test("a template that stopped rendering a language counts as changed", () => {
  // The direction that matters most: the approved words are not merely
  // different, they are gone.
  const refusal = campaignRunRefusal(approved({ currentHashes: {} }));
  assert.equal(refusal?.refusal, "content_changed");
});

test("a locale added after approval is refused as unpinned", () => {
  // Reported separately from a changed hash because the fix differs: this one
  // needs an approval that covers the new language, not a re-read of the old
  // one.
  const refusal = campaignRunRefusal(
    approved({ locales: ["en", "ko"], currentHashes: { en: "hash-en", ko: "hash-ko" } })
  );
  assert.equal(refusal?.refusal, "locale_not_pinned");
  assert.deepEqual(refusal.languages, ["ko"]);
});

test("a pin for a language the campaign does not send in is ignored", () => {
  // Removing a locale after approval is narrowing, and narrowing is allowed.
  assert.equal(
    campaignRunRefusal(
      approved({
        pinned: [
          { language: "en", templateVersionId: "a", contentHash: "hash-en" },
          { language: "ko", templateVersionId: "b", contentHash: "hash-ko" },
        ],
      })
    ),
    null
  );
});

test("a half-readable pin is no pin, never a silent send", () => {
  // The one outcome this must never produce is sending an unpinned locale, so
  // anything unreadable drops out and surfaces as locale_not_pinned.
  assert.deepEqual(readPinnedVersions(null), []);
  assert.deepEqual(readPinnedVersions([1, 2]), []);
  assert.deepEqual(readPinnedVersions({ en: "just a string" }), []);
  assert.deepEqual(readPinnedVersions({ en: { templateVersionId: "a" } }), []);
  assert.deepEqual(
    readPinnedVersions({
      en: { templateVersionId: "a", contentHash: "h" },
      ko: { templateVersionId: 7, contentHash: "h" },
    }),
    [{ language: "en", templateVersionId: "a", contentHash: "h" }]
  );
});

test("pins survive a round trip", () => {
  const entries = [
    { language: "en", templateVersionId: "tv_en", contentHash: "h-en" },
    { language: "ko", templateVersionId: "tv_ko", contentHash: "h-ko" },
  ];
  assert.deepEqual(readPinnedVersions(writePinnedVersions(entries)), entries);
});

test("locales read defensively", () => {
  assert.deepEqual(readLocales(["en", 7, "ko", null]), ["en", "ko"]);
  assert.deepEqual(readLocales("en"), []);
  assert.deepEqual(readLocales(null), []);
});
