import assert from "node:assert/strict";
import test from "node:test";

import {
  AU_RELATIONSHIP_DORMANCY_MONTHS,
  RELATIONSHIP_DISCLOSING_SIGNUP_COPY_VERSIONS,
  addUtcMonths,
  auRelationshipStanding,
  relationshipDisclosedBy,
} from "../lib/auRelationshipCore.ts";
import {
  CONSENT_COPY_VERSIONS,
  MAKES_NO_SEND_PROMISE_VERSIONS,
  PROMISE_NO_UNREQUESTED_SEND_VERSIONS,
} from "../lib/emailConsentCopy.ts";
import {
  auSenderAuthority,
  recipientAuthority,
} from "../lib/releaseNotesCountryRuleCore.ts";

// The Australian relationship (docs/policy/email-product-news-redesign-draft.md
// section 4.4, R4 decided 2026-09-29).

const NOW = new Date("2028-03-15T10:00:00.000Z");
const base = {
  started: { id: "evt_1", emailAddress: "a@example.com", occurredAt: new Date("2027-01-01T00:00:00Z") },
  ended: false,
  deliveryAddress: "a@example.com",
  lastLoginAt: new Date("2027-06-01T00:00:00Z"),
  accountDeletionRequestedAt: null,
  consentWithdrawn: false,
  amendmentInForce: true,
  now: NOW,
};

test("R4: the relationship lasts 24 months from the last sign-in", () => {
  assert.equal(AU_RELATIONSHIP_DORMANCY_MONTHS, 24);
  assert.deepEqual(auRelationshipStanding(base), { active: true, eventId: "evt_1" });
  const lastLoginAt = new Date("2026-03-15T10:00:00.000Z");
  // Exactly 24 months is dormant; a millisecond inside is not.
  assert.deepEqual(auRelationshipStanding({ ...base, lastLoginAt }), { active: false, reason: "dormant" });
  assert.equal(
    auRelationshipStanding({ ...base, lastLoginAt: new Date(lastLoginAt.getTime() + 1) }).active,
    true
  );
  assert.deepEqual(auRelationshipStanding({ ...base, lastLoginAt: null }), { active: false, reason: "dormant" });
});

test("calendar months clamp to the month's last day", () => {
  assert.equal(addUtcMonths(new Date("2026-02-28T00:00:00Z"), 24).toISOString(), "2028-02-28T00:00:00.000Z");
  assert.equal(addUtcMonths(new Date("2024-02-29T12:00:00Z"), 24).toISOString(), "2026-02-28T12:00:00.000Z");
  assert.equal(addUtcMonths(new Date("2026-08-31T00:00:00Z"), 1).toISOString(), "2026-09-30T00:00:00.000Z");
});

test("every end is final, and each is named", () => {
  const cases = [
    [{ started: null }, "no_relationship"],
    [{ amendmentInForce: false }, "amendment_not_in_force"],
    [{ ended: true }, "relationship_ended"],
    [{ accountDeletionRequestedAt: new Date("2028-01-01T00:00:00Z") }, "deletion_requested"],
    [{ deliveryAddress: "b@example.com" }, "address_changed"],
    [{ consentWithdrawn: true }, "consent_withdrawn"],
    [{ started: { ...base.started, occurredAt: new Date("2029-01-01T00:00:00Z") } }, "no_relationship"],
  ];
  for (const [change, reason] of cases) {
    assert.deepEqual(auRelationshipStanding({ ...base, ...change }), { active: false, reason }, reason);
  }
  // Case alone is not a different mailbox.
  assert.equal(auRelationshipStanding({ ...base, deliveryAddress: "A@example.com" }).active, true);
});

test("no approved sign-up notice discloses relationship sending, so none starts today", () => {
  // Decision B (2026-09-29) kept the promise that product updates follow a
  // yes. A version joins this list only once its wording says otherwise.
  assert.deepEqual([...RELATIONSHIP_DISCLOSING_SIGNUP_COPY_VERSIONS], []);
  const versions = CONSENT_COPY_VERSIONS.map((entry) => entry.version);
  for (const version of PROMISE_NO_UNREQUESTED_SEND_VERSIONS) {
    assert.equal(relationshipDisclosedBy(version), false, version);
  }
  // A disclosing version is an approved one that makes no send promise; one
  // that promises "not unless you ask" can never start a relationship.
  for (const version of RELATIONSHIP_DISCLOSING_SIGNUP_COPY_VERSIONS) {
    assert.ok(versions.includes(version), `${version} is not a consent copy version`);
    assert.ok(!PROMISE_NO_UNREQUESTED_SEND_VERSIONS.has(version), `${version} promises no unrequested send`);
    assert.ok(MAKES_NO_SEND_PROMISE_VERSIONS.has(version), `${version} is not recorded as making no promise`);
  }
  assert.equal(relationshipDisclosedBy("2026-09-29"), false);
});

test("an inferred consent passes the Australian sender and an inferred_consent rule, and cites its event", () => {
  const consent = { express: false, evidenceIds: [], inferred: { eventIds: ["evt_1"] } };
  const sender = auSenderAuthority({ consent });
  assert.equal(sender.verdict, "allow");
  assert.equal(sender.basis, "inferred_consent");
  assert.deepEqual(sender.eventEvidenceIds, ["evt_1"]);
  assert.throws(() =>
    auSenderAuthority({ consent: { express: false, evidenceIds: [], inferred: { eventIds: [] } } })
  );
  const refused = auSenderAuthority({ consent: { express: false, evidenceIds: [] } });
  assert.equal(refused.reason, "no_au_sender_consent");
  assert.equal(typeof recipientAuthority, "function");
});
