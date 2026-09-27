// The display contract, and what moves its hash.
//
// Contract: docs/policy/email-product-news-redesign-draft.md section 7.6 (C16,
// C33), section 5.3.
//
// The hash is a comparison between what a queued message was rendered to and
// what the duties require now, and the remedy for a difference is to skip the
// message and re-enqueue it. So the two things worth testing are the two ways
// that goes wrong: a change that should move the hash and does not, and a hash
// that moves when nothing changed.

import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalJson,
  composeDisplayContract,
  displayContractHash,
  displayIdempotencyKey,
} from "../lib/releaseNotesDisplayContractCore.ts";

const requirement = (overrides = {}) => ({
  countryCode: "KR",
  ruleKey: "release-notes:KR",
  ruleVersion: 1,
  subjectPrefix: null,
  footerBlocks: ["legal_name", "postal_address", "contact_email", "contact_phone"],
  unsubscribeSlaBusinessDays: 14,
  unsubscribeLanguages: ["ko", "en"],
  displayObligations: [
    { obligationKey: "body_disclosures", state: "implemented", waiverApprovalId: null },
    {
      obligationKey: "advertising_subject_label",
      state: "waived",
      waiverApprovalId: "approval-1",
    },
  ],
  ...overrides,
});

const compose = (requirements, templateVersionId = "template-1") =>
  composeDisplayContract({ requirements, templateVersionId });

const hashOf = (requirements, templateVersionId) => {
  const result = compose(requirements, templateVersionId);
  assert.ok("contract" in result, "expected a contract");
  return displayContractHash(result.contract);
};

test("one country composes to what that country requires", () => {
  const result = compose([requirement()]);
  assert.ok("contract" in result);
  assert.deepEqual(result.contract.ruleVersions, [
    { ruleKey: "release-notes:KR", ruleVersion: 1 },
  ]);
  assert.deepEqual(result.contract.waiverApprovalIds, ["approval-1"]);
  assert.equal(result.contract.unsubscribeSlaBusinessDays, 14);
  assert.deepEqual(result.contract.unsubscribeLanguages, ["en", "ko"]);
  assert.equal(result.contract.templateVersionId, "template-1");
});

test("two countries compose to the union, and to the stricter deadline", () => {
  const result = compose([
    requirement(),
    requirement({
      countryCode: "US",
      ruleKey: "release-notes:US",
      footerBlocks: ["legal_name", "postal_address"],
      unsubscribeSlaBusinessDays: 10,
      unsubscribeLanguages: ["en"],
      displayObligations: [
        { obligationKey: "postal_address", state: "implemented", waiverApprovalId: null },
      ],
    }),
  ]);
  assert.ok("contract" in result);
  // Every block either asks for, because the message has one footer.
  assert.deepEqual(result.contract.footerBlocks, [
    "contact_email",
    "contact_phone",
    "legal_name",
    "postal_address",
  ]);
  // The shortest deadline: meeting the longest does not meet the shortest.
  assert.equal(result.contract.unsubscribeSlaBusinessDays, 10);
  assert.deepEqual(result.contract.unsubscribeLanguages, ["en", "ko"]);
  assert.equal(result.contract.displayObligations.length, 3);
});

test("two statutory subject prefixes cannot both be at the front", () => {
  // The case section 5.3 has in mind. Sending with one of them and recording
  // both as satisfied is the thing this refuses to do.
  const result = compose([
    requirement({ subjectPrefix: "(광고)" }),
    requirement({
      countryCode: "SG",
      ruleKey: "release-notes:SG",
      subjectPrefix: "<ADV>",
      displayObligations: [],
    }),
  ]);
  assert.ok("refusal" in result);
  assert.equal(result.refusal.reason, "conflicting_subject_prefix");
  assert.match(result.refusal.detail, /\(광고\)/);
  assert.match(result.refusal.detail, /<ADV>/);
});

test("the same prefix asked for twice is one prefix, not a conflict", () => {
  const result = compose([
    requirement({ subjectPrefix: "<ADV>" }),
    requirement({
      countryCode: "SG",
      ruleKey: "release-notes:SG",
      subjectPrefix: "<ADV>",
      displayObligations: [],
    }),
  ]);
  assert.ok("contract" in result);
  assert.equal(result.contract.subjectPrefix, "<ADV>");
});

test("the hash does not move when only the order of the inputs does", () => {
  // Otherwise two identical contracts differ, and the remedy for a difference is
  // to skip a message and send a replacement. The order of a query's rows would
  // have been enough to do that.
  const korea = requirement();
  const singapore = requirement({
    countryCode: "SG",
    ruleKey: "release-notes:SG",
    footerBlocks: ["postal_address", "legal_name"],
    unsubscribeLanguages: ["en"],
    displayObligations: [
      { obligationKey: "adv_subject_label", state: "implemented", waiverApprovalId: null },
    ],
  });
  assert.equal(hashOf([korea, singapore]), hashOf([singapore, korea]));
  // And within a country, the order its blocks and duties came back in.
  assert.equal(
    hashOf([korea]),
    hashOf([
      requirement({
        footerBlocks: ["contact_phone", "contact_email", "postal_address", "legal_name"],
        unsubscribeLanguages: ["en", "ko"],
        displayObligations: [...korea.displayObligations].reverse(),
      }),
    ])
  );
});

test("every part of the contract moves the hash", () => {
  // A change that does not move it is a message sent under duties nobody
  // compared, which is what C16 is about.
  const base = hashOf([requirement()]);
  const changes = {
    "rule version": { ruleVersion: 2 },
    "subject prefix": { subjectPrefix: "<ADV>" },
    "footer blocks": { footerBlocks: ["legal_name"] },
    "unsubscribe deadline": { unsubscribeSlaBusinessDays: 10 },
    "unsubscribe languages": { unsubscribeLanguages: ["ko"] },
    "a duty's state": {
      displayObligations: [
        { obligationKey: "body_disclosures", state: "deferred", waiverApprovalId: null },
        {
          obligationKey: "advertising_subject_label",
          state: "waived",
          waiverApprovalId: "approval-1",
        },
      ],
    },
    "which approval waived a duty": {
      displayObligations: [
        { obligationKey: "body_disclosures", state: "implemented", waiverApprovalId: null },
        {
          obligationKey: "advertising_subject_label",
          state: "waived",
          waiverApprovalId: "approval-2",
        },
      ],
    },
  };
  for (const [what, overrides] of Object.entries(changes)) {
    assert.notEqual(hashOf([requirement(overrides)]), base, `${what} did not move the hash`);
  }
  // And the template, which section 7.6 names: the same duties rendered by a
  // different template are a different message.
  assert.notEqual(hashOf([requirement()], "template-2"), base);
});

test("a waiver withdrawn and replaced is a different contract", () => {
  // The reason the approval id is in the contract and not only the state: a
  // message rendered under a waiver that has since been withdrawn was rendered
  // under an authority that no longer exists, and the footer can be identical.
  const first = hashOf([requirement()]);
  const second = hashOf([
    requirement({
      displayObligations: [
        { obligationKey: "body_disclosures", state: "implemented", waiverApprovalId: null },
        {
          obligationKey: "advertising_subject_label",
          state: "waived",
          waiverApprovalId: "approval-2",
        },
      ],
    }),
  ]);
  assert.notEqual(first, second);
});

test("canonical JSON sorts keys at every depth and keeps array order", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [3, 1], c: 2 } }),
    '{"a":{"c":2,"d":[3,1]},"b":1}'
  );
  assert.equal(canonicalJson(null), "null");
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
});

test("the idempotency key is the one section 7.6 fixes, and fits the provider", () => {
  const key = displayIdempotencyKey({
    rootDeliveryId: "dlv_01234567890123456789012345",
    generation: 2,
    displayContractHash: "a".repeat(64),
  });
  assert.equal(key, "dlv_01234567890123456789012345:g2:aaaaaaaaaaaaaaaa");
  assert.ok(key.length <= 256);
  // The generation is in it because a replacement is a different message with
  // the same root, and a crash after submitting must not produce a second one.
  assert.notEqual(
    key,
    displayIdempotencyKey({
      rootDeliveryId: "dlv_01234567890123456789012345",
      generation: 3,
      displayContractHash: "a".repeat(64),
    })
  );
});

test("no candidate at all composes to a contract with no deadline", () => {
  // A preview with no resolved country still has a template, and the send verdict
  // refuses it as `country_undetermined` -- not here, where there is nothing to
  // compose and nothing wrong with saying so.
  const result = compose([]);
  assert.ok("contract" in result);
  assert.equal(result.contract.unsubscribeSlaBusinessDays, null);
  assert.deepEqual(result.contract.footerBlocks, []);
});
