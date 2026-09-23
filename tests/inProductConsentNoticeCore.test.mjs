// The one-time in-product notice: who is asked, and what each answer records.
//
// Contract: docs/policy/email-product-news-redesign-draft.md, sections 5.1,
// 5.4 and 5.5.

import assert from "node:assert/strict";
import test from "node:test";

import {
  NOTICE_EVENT_KINDS,
  inProductNoticeOffer,
  noticePurposes,
  noticeRecordFor,
  noticeSourceEventKey,
} from "../lib/inProductConsentNoticeCore.ts";
import {
  CONSENT_REQUIRED_PURPOSES,
  isEmailPurpose,
} from "../lib/emailPreferenceCore.ts";
import { EMAIL_PERMISSION_EVENT_KINDS } from "../lib/emailPermissionLedgerCore.ts";

const untouched = {
  emailAddress: "someone@example.com",
  hasExpressConsent: false,
  noticeAlreadyShown: false,
  hasObjected: false,
  suppressed: false,
};

test("an existing account with no answer yet is asked", () => {
  assert.deepEqual(inProductNoticeOffer(untouched), {
    offered: true,
    purposes: noticePurposes(),
  });
});

test("the notice asks about exactly the consent-based purposes", () => {
  // Derived rather than listed: a purpose that becomes consent-based later is
  // one this notice should ask about, and a second list would have to be
  // remembered.
  assert.deepEqual(
    noticePurposes(),
    [...CONSENT_REQUIRED_PURPOSES].filter(isEmailPurpose).sort()
  );
  assert.ok(noticePurposes().length > 0);
});

test("each answer stops the notice, and says which answer it was", () => {
  const cases = [
    [{ hasObjected: true }, "objected"],
    [{ hasExpressConsent: true }, "already_consented"],
    [{ suppressed: true }, "suppressed"],
    [{ noticeAlreadyShown: true }, "already_shown"],
    [{ emailAddress: null }, "no_address"],
    [{ emailAddress: "   " }, "no_address"],
  ];
  for (const [patch, refusal] of cases) {
    assert.deepEqual(inProductNoticeOffer({ ...untouched, ...patch }), {
      offered: false,
      refusal,
    });
  }
});

test("a decision is reported ahead of the render that carried it", () => {
  // Both stop the notice. A reader asking why wants "they refused", not "we
  // already asked".
  assert.deepEqual(
    inProductNoticeOffer({
      ...untouched,
      hasObjected: true,
      noticeAlreadyShown: true,
    }),
    { offered: false, refusal: "objected" }
  );
});

test("dismissing records that we asked, not that they refused", () => {
  // Section 5.4's rule, and the whole reason there are three states rather
  // than two. Somebody closing a dialog on the way to what they came for has
  // decided nothing, and writing `objected` there invents a decision exactly
  // as an inferred consent does -- only in the direction that looks safe.
  assert.deepEqual(noticeRecordFor("shown"), {
    kind: "notice_shown",
    scopeKey: "marketing",
  });
  assert.notEqual(noticeRecordFor("shown").kind, "objected");
});

test("refusing records a decision", () => {
  assert.deepEqual(noticeRecordFor("object"), {
    kind: "objected",
    scopeKey: "marketing",
  });
});

test("ticking the box is a consent, not a ledger event", () => {
  const record = noticeRecordFor("opt_in");
  assert.equal(record.kind, "consent");
  assert.deepEqual(record.purposes, noticePurposes());
  // It goes to the double opt-in like any other consent, so it is not one of
  // the ledger's event kinds.
  assert.ok(!EMAIL_PERMISSION_EVENT_KINDS.includes(record.kind));
});

test("the two recorded kinds are kinds the ledger knows", () => {
  for (const kind of Object.values(NOTICE_EVENT_KINDS)) {
    assert.ok(
      EMAIL_PERMISSION_EVENT_KINDS.includes(kind),
      `${kind} is not an EmailPermissionEvent kind`
    );
  }
});

test("a re-render or a double click adds nothing", () => {
  assert.equal(
    noticeSourceEventKey("shown", "u1"),
    noticeSourceEventKey("shown", "u1")
  );
  assert.notEqual(
    noticeSourceEventKey("shown", "u1"),
    noticeSourceEventKey("object", "u1")
  );
  assert.notEqual(
    noticeSourceEventKey("shown", "u1"),
    noticeSourceEventKey("shown", "u2")
  );
});

test("the key follows the account, not the address", () => {
  // The notice happened to a person in a session. Changing address later does
  // not make it unhappen, and keying on the address would show it again.
  assert.ok(noticeSourceEventKey("shown", "u1").endsWith("u1"));
  assert.ok(!noticeSourceEventKey("shown", "u1").includes("@"));
});
