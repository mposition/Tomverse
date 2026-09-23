// The one-time in-product notice: who is asked, and what each answer records.
//
// Contract: docs/policy/email-product-news-redesign-draft.md, sections 5.1,
// 5.4 and 5.5.

import assert from "node:assert/strict";
import test from "node:test";

import {
  NOTICE_EVENT_KINDS,
  canonicalCandidates,
  noticeJurisdictionColumns,
  inProductNoticeOffer,
  noticePurposes,
  noticeObjectionSourceEventKey,
  noticeRecordFor,
  noticeShownSourceEventKey,
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
    noticeShownSourceEventKey("u1"),
    noticeShownSourceEventKey("u1")
  );
  assert.notEqual(
    noticeShownSourceEventKey("u1"),
    noticeShownSourceEventKey("u2")
  );
});

test("a render is keyed by the account, so moving address does not re-ask", () => {
  // The notice happened to a person in a session. Changing address later does
  // not make it unhappen.
  assert.ok(noticeShownSourceEventKey("u1").endsWith("u1"));
  assert.ok(!noticeShownSourceEventKey("u1").includes("@"));
});

test("a refusal is keyed by the account and the address it was about", () => {
  // The opposite scoping, and the reason is that a refusal attaches to the
  // mailbox. Keying it by the account alone made the second refusal collide
  // with the first: the write returned the old row and reported success, and
  // the new address ended up with no refusal on it at all.
  assert.notEqual(
    noticeObjectionSourceEventKey("u1", "digest-a"),
    noticeObjectionSourceEventKey("u1", "digest-b")
  );
  assert.equal(
    noticeObjectionSourceEventKey("u1", "digest-a"),
    noticeObjectionSourceEventKey("u1", "digest-a")
  );
  assert.notEqual(
    noticeObjectionSourceEventKey("u1", "digest-a"),
    noticeObjectionSourceEventKey("u2", "digest-a")
  );
});

test("the two keys can never collide with each other", () => {
  assert.notEqual(
    noticeShownSourceEventKey("u1"),
    noticeObjectionSourceEventKey("u1", "digest-a")
  );
});

// --- how the resolver's answer fits two columns --------------------------
//
// This function does not decide a jurisdiction. Two earlier versions did and
// both were wrong; the note in the module records how. These cases are about
// what the column can honestly hold.

const resolved = (patch) => ({
  countryCode: "AU",
  profileKey: "AU",
  confidence: "high",
  source: "self_declared",
  ...patch,
});

test("a high-confidence country with a reviewed profile is written down", () => {
  assert.deepEqual(noticeJurisdictionColumns(resolved()), {
    country: "AU",
    source: "self_declared",
  });
  assert.deepEqual(
    noticeJurisdictionColumns(
      resolved({ countryCode: "DE", profileKey: "EU", source: "billing" })
    ),
    { country: "DE", source: "billing" }
  );
});

test("a country with no reviewed profile is ZZ, however it was declared", () => {
  // `normalizeCountry()` accepts any two letters, so `JP` and `XX` reach here
  // and `profileForCountry()` answers `ZZ` for both. Section 5.6's override
  // only refuses the literal string `ZZ`, so writing `JP` would let it run on
  // an account whose display duties were never worked out -- permanently,
  // because the row is append-only.
  for (const countryCode of ["JP", "XX"]) {
    assert.deepEqual(
      noticeJurisdictionColumns(resolved({ countryCode, profileKey: "ZZ" })),
      { country: "ZZ", source: "unresolved" }
    );
  }
});

test("a low-confidence resolution is ZZ even with a real profile", () => {
  assert.deepEqual(
    noticeJurisdictionColumns(
      resolved({
        countryCode: "KR",
        profileKey: "KR",
        confidence: "low",
        source: "inferred",
      })
    ),
    { country: "ZZ", source: "unresolved" }
  );
});

test("the resolver's conflict keeps its own name", () => {
  // `conflict` means two high-confidence signals disagreeing. Everything else
  // that failed to settle is `unresolved`, which is a different fact and reads
  // as one.
  assert.deepEqual(
    noticeJurisdictionColumns(
      resolved({
        countryCode: "ZZ",
        profileKey: "ZZ",
        confidence: "conflict",
        source: "conflict",
      })
    ),
    { country: "ZZ", source: "conflict" }
  );
});

test("nothing resolved at all is unresolved", () => {
  assert.deepEqual(
    noticeJurisdictionColumns(
      resolved({
        countryCode: "ZZ",
        profileKey: "ZZ",
        confidence: "unknown",
        source: "unresolved",
      })
    ),
    { country: "ZZ", source: "unresolved" }
  );
});

// --- the bytes two candidate lists are compared by ------------------------

test("key order does not make two identical lists different", () => {
  // The stored copy comes back from `jsonb`, which does not keep object key
  // order -- it stores short keys first. Comparing raw JSON.stringify said
  // "different" for an identical retry, so a double click threw instead of
  // returning the row it had already written.
  const written = [
    { country: "AU", signal: "self_declared", ruleVersion: 1, copyHash: "h" },
  ];
  const readBack = [
    { signal: "self_declared", country: "AU", copyHash: "h", ruleVersion: 1 },
  ];
  assert.notEqual(JSON.stringify(written), JSON.stringify(readBack));
  assert.equal(canonicalCandidates(written), canonicalCandidates(readBack));
});

test("array order still matters", () => {
  // `jsonb` preserves it, and two lists holding the same candidates in a
  // different order came from different screens.
  const a = [{ country: "AU", signal: "inferred" }, { country: "KR", signal: "inferred" }];
  const b = [{ country: "KR", signal: "inferred" }, { country: "AU", signal: "inferred" }];
  assert.notEqual(canonicalCandidates(a), canonicalCandidates(b));
});

test("a stored value that is not a list is never equal to one", () => {
  assert.notEqual(canonicalCandidates(null), canonicalCandidates([]));
  assert.notEqual(
    canonicalCandidates({ country: "AU" }),
    canonicalCandidates([{ country: "AU" }])
  );
});
