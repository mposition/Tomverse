// The one-time in-product notice: who is asked, and what each answer records.
//
// Contract: docs/policy/email-product-news-redesign-draft.md, sections 5.1,
// 5.4 and 5.5.

import assert from "node:assert/strict";
import test from "node:test";

import {
  NOTICE_EVENT_KINDS,
  canonicalCandidates,
  noticeJurisdiction,
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

// --- which country the column claims -------------------------------------

const candidate = (country, signal) => ({ country, signal });

test("a self-declared country settles it", () => {
  assert.deepEqual(
    noticeJurisdiction([candidate("AU", "self_declared")]),
    { country: "AU", source: "self_declared" }
  );
});

test("a billing or consent country settles it too", () => {
  // The approved contract's order is self-report, then billing, then the
  // jurisdiction recorded at the last consent.
  assert.deepEqual(noticeJurisdiction([candidate("SG", "billing")]), {
    country: "SG",
    source: "billing",
  });
  assert.deepEqual(noticeJurisdiction([candidate("KR", "consent")]), {
    country: "KR",
    source: "consent",
  });
});

test("two inferences that agree are still two inferences", () => {
  // This is the case the previous version got wrong. An IP and a browser
  // language both answering AU is not a settled jurisdiction: the approved
  // contract does not let an inference settle one, the row has no confidence
  // column, and it is append-only -- so sealing AU would be a permanent claim
  // nobody is entitled to make, and it would let section 5.6's override run on
  // an account whose display duties were never worked out.
  assert.deepEqual(
    noticeJurisdiction([candidate("AU", "inferred"), candidate("AU", "inferred")]),
    { country: "ZZ", source: "unresolved" }
  );
});

test("one inference alone does not settle a country either", () => {
  assert.deepEqual(noticeJurisdiction([candidate("AU", "inferred")]), {
    country: "ZZ",
    source: "unresolved",
  });
});

test("inferences that disagree are a conflict, not merely unresolved", () => {
  assert.deepEqual(
    noticeJurisdiction([candidate("KR", "inferred"), candidate("US", "inferred")]),
    { country: "ZZ", source: "conflict" }
  );
});

test("a self-declared country replaces the candidate list", () => {
  // Draft section 5.3 states it from the other end: self_declared replaces the
  // list, so an inference pointing elsewhere does not turn it into a conflict.
  assert.deepEqual(
    noticeJurisdiction([
      candidate("KR", "inferred"),
      candidate("AU", "self_declared"),
    ]),
    { country: "AU", source: "self_declared" }
  );
});

test("two determinative signals that disagree are a conflict", () => {
  assert.deepEqual(
    noticeJurisdiction([
      candidate("AU", "self_declared"),
      candidate("KR", "billing"),
    ]),
    { country: "ZZ", source: "conflict" }
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
  const a = [candidate("AU", "inferred"), candidate("KR", "inferred")];
  const b = [candidate("KR", "inferred"), candidate("AU", "inferred")];
  assert.notEqual(canonicalCandidates(a), canonicalCandidates(b));
});

test("a stored value that is not a list is never equal to one", () => {
  assert.notEqual(canonicalCandidates(null), canonicalCandidates([]));
  assert.notEqual(
    canonicalCandidates({ country: "AU" }),
    canonicalCandidates([{ country: "AU" }])
  );
});
