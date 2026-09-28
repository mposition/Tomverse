// S10: what has to be published, and told to whom, before release notes go live.
//
// Contract: docs/policy/email-product-news-redesign-draft.md sections 10, 11
// approval E and 12 (S10); docs/policy/email-notifications.md section 3.1 type 5.
//
// Two kinds of test. The pure ones pin each refusal. The last group reads the
// repository as it is and asserts the gate refuses today -- the amendment has
// not been written, so a pass would mean the gate is not looking.

import assert from "node:assert/strict";
import test from "node:test";

import {
  AMENDED_DOCUMENT_PATHS,
  CHANGE_NOTICE_PERIOD_DAYS,
  PUBLICATION_REFUSALS,
  publicationProblems,
} from "../lib/emailPolicyPublicationCore.ts";
import {
  CHANGE_NOTICE_TEMPLATE_KEY,
  DIGEST_BEFORE_AMENDMENT,
  emailPolicyPublicationProblems,
} from "../lib/emailPolicyPublication.ts";
import { SITEMAP_CONTENT_EVIDENCE } from "../lib/sitemapContentDates.ts";

const NOW = new Date("2026-12-01T00:00:00.000Z");
const DAY = 86_400_000;

const amended = (overrides = {}) => ({
  path: "/privacy",
  digestBeforeAmendment: "old",
  publishedDigest: "new",
  effectiveFrom: "2026-11-15",
  ...overrides,
});

const notice = (overrides = {}) => ({
  templateKey: "policy_change_notice",
  classification: "service",
  purpose: null,
  owed: 10,
  delivered: 10,
  firstSentAt: new Date("2026-10-01T00:00:00.000Z"),
  ...overrides,
});

const refusals = (input) =>
  publicationProblems({ documents: [amended()], notice: notice(), now: NOW, ...input }).map(
    (problem) => problem.refusal
  );

test("a published amendment with a delivered notice passes", () => {
  assert.deepEqual(refusals({}), []);
});

test("a page nobody recorded the prior state of is not shown to have changed", () => {
  assert.deepEqual(
    refusals({ documents: [amended({ digestBeforeAmendment: null })] }),
    ["document_state_unrecorded"]
  );
  assert.deepEqual(refusals({ documents: [amended({ publishedDigest: null })] }), [
    "document_state_unrecorded",
  ]);
});

test("a page that still renders what it rendered before is not amended", () => {
  assert.deepEqual(
    refusals({ documents: [amended({ digestBeforeAmendment: "same", publishedDigest: "same" })] }),
    ["document_not_amended"]
  );
});

test("the amendment has to be in effect, with a date the page shows", () => {
  assert.deepEqual(refusals({ documents: [amended({ effectiveFrom: null })] }), [
    "effective_date_missing",
  ]);
  assert.deepEqual(refusals({ documents: [amended({ effectiveFrom: "15 Nov 2026" })] }), [
    "effective_date_missing",
  ]);
  assert.deepEqual(refusals({ documents: [amended({ effectiveFrom: "2026-12-02" })] }), [
    "effective_date_not_reached",
  ]);
});

test("the notice has to go out a full notice period before the effective date", () => {
  const effective = new Date("2026-11-15T00:00:00.000Z");
  const tooLate = new Date(effective.getTime() - (CHANGE_NOTICE_PERIOD_DAYS - 1) * DAY);
  assert.deepEqual(refusals({ notice: notice({ firstSentAt: tooLate }) }), [
    "notice_period_too_short",
  ]);
  const onTime = new Date(effective.getTime() - CHANGE_NOTICE_PERIOD_DAYS * DAY);
  assert.deepEqual(refusals({ notice: notice({ firstSentAt: onTime }) }), []);
});

test("a notice nobody named, or nobody received, is not a notice", () => {
  assert.deepEqual(refusals({ notice: notice({ templateKey: null }) }), [
    "change_notice_unidentified",
  ]);
  assert.deepEqual(refusals({ notice: notice({ firstSentAt: null, delivered: 0 }) }), [
    "change_notice_not_sent",
  ]);
  assert.deepEqual(refusals({ notice: notice({ delivered: 7 }) }), ["change_notice_incomplete"]);
});

test("the notice must reach the people who unsubscribed", () => {
  // Section 3.1's fifth type. A marketing classification, or any purpose gate,
  // would put the notice behind the consent the amendment is about: the people
  // who already said no -- the ones most affected -- would be the only ones not
  // told.
  assert.deepEqual(refusals({ notice: notice({ classification: "marketing" }) }), [
    "change_notice_is_marketing",
  ]);
  assert.deepEqual(refusals({ notice: notice({ purpose: "product_updates" }) }), [
    "change_notice_is_marketing",
  ]);
});

test("every problem is reported, not only the first", () => {
  // An operator asking why the switch does nothing is asking what is left to do.
  const all = publicationProblems({
    documents: [
      amended({ digestBeforeAmendment: "same", publishedDigest: "same", effectiveFrom: null }),
      amended({ path: "/terms", digestBeforeAmendment: null }),
    ],
    notice: notice({ templateKey: null }),
    now: NOW,
  }).map((problem) => `${problem.subject}:${problem.refusal}`);
  assert.deepEqual(all, [
    "/privacy:document_not_amended",
    "/privacy:effective_date_missing",
    "/terms:document_state_unrecorded",
    "change notice:change_notice_unidentified",
  ]);
});

test("every refusal the core can produce is in the closed list", () => {
  const seen = new Set();
  const cases = [
    { documents: [amended({ digestBeforeAmendment: null })] },
    { documents: [amended({ digestBeforeAmendment: "x", publishedDigest: "x" })] },
    { documents: [amended({ effectiveFrom: null })] },
    { documents: [amended({ effectiveFrom: "2099-01-01" })] },
    { notice: notice({ firstSentAt: new Date("2026-11-14T00:00:00.000Z") }) },
    { notice: notice({ templateKey: null }) },
    { notice: notice({ firstSentAt: null, delivered: 0 }) },
    { notice: notice({ delivered: 1 }) },
    { notice: notice({ classification: "marketing" }) },
  ];
  for (const input of cases) for (const refusal of refusals(input)) seen.add(refusal);
  assert.deepEqual([...seen].sort(), [...PUBLICATION_REFUSALS].sort());
});

// The repository as it stands.

test("the documents section 10 names are the ones the gate reads", () => {
  assert.deepEqual([...AMENDED_DOCUMENT_PATHS], ["/privacy", "/terms"]);
});

test("the recorded pre-amendment state of /privacy is what the site renders today", () => {
  // Pinned on the day the amendment was prepared. While the two are equal the
  // page has not been amended, which is true today and is what the gate reports.
  assert.equal(
    DIGEST_BEFORE_AMENDMENT["/privacy"],
    SITEMAP_CONTENT_EVIDENCE["/privacy"].contentSha256
  );
});

test("today, nothing is published and release notes cannot go live", async () => {
  // A pass here would mean the gate is not looking: the amendment text is an
  // owner decision that has not been made, /terms has no recorded state, and no
  // change-notice template exists.
  assert.equal(CHANGE_NOTICE_TEMPLATE_KEY, null);
  const problems = (await emailPolicyPublicationProblems(NOW)).map(
    (problem) => `${problem.subject}:${problem.refusal}`
  );
  assert.deepEqual(problems, [
    "/privacy:document_not_amended",
    "/terms:document_state_unrecorded",
    "change notice:change_notice_unidentified",
  ]);
});
