// S10: what has to be published, and told to whom, before release notes go live.
//
// Contract: docs/policy/email-product-news-redesign-draft.md sections 10, 11
// approval E and 12 (S10); docs/policy/email-notifications.md section 3.1 type 5.
//
// The pure tests pin each refusal. The last group reads the repository as it is
// and asserts the gate is closed today -- the amendment has not been written, so
// a pass would mean the gate is not looking.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  CHANGE_NOTICE_PERIOD_DAYS,
  PUBLICATION_REFUSALS,
  effectiveDateOf,
  publicationProblems,
  utcDayStart,
} from "../lib/emailPolicyPublicationCore.ts";
import {
  AMENDED_DOCUMENTS,
  CHANGE_NOTICE_TEMPLATE_KEY,
  DIGEST_BEFORE_AMENDMENT,
  DIGEST_VERIFIED_BY,
  documentFacts,
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
  verified: true,
  ...overrides,
});

const notice = (overrides = {}) => ({
  templateKey: "policy_change_notice",
  classification: "legal",
  purpose: null,
  owed: 10,
  reached: 9,
  unreachable: 1,
  notAttempted: 0,
  firstSentAt: new Date("2026-10-01T00:00:00.000Z"),
  ...overrides,
});

const refusals = (input) =>
  publicationProblems({ documents: [amended()], notice: notice(), now: NOW, ...input }).map(
    (problem) => problem.refusal
  );

test("a published amendment with every owed account attempted passes", () => {
  // One of ten unreachable: reported by the counts, not blocking. Section 3.1's
  // fifth type asks for the notice to be sent and non-delivery tracked, not for
  // a dead mailbox to hold every later product.
  assert.deepEqual(refusals({}), []);
});

test("an owed account with no attempt at all blocks, however many others were reached", () => {
  // The set question. The first version compared sizes, so an extra delivery to
  // one account could stand in for another account's missing one.
  assert.deepEqual(refusals({ notice: notice({ reached: 10, notAttempted: 1 }) }), [
    "change_notice_incomplete",
  ]);
});

test("a page nobody recorded, or nobody verifies, is not shown to have changed", () => {
  assert.deepEqual(refusals({ documents: [amended({ digestBeforeAmendment: null })] }), [
    "document_state_unrecorded",
  ]);
  assert.deepEqual(refusals({ documents: [amended({ publishedDigest: null })] }), [
    "document_state_unrecorded",
  ]);
  // A digest typed into a table and checked by nothing is a claim, not evidence.
  assert.deepEqual(refusals({ documents: [amended({ verified: false })] }), [
    "document_state_unverified",
  ]);
});

test("a page that still renders what it rendered before is not amended", () => {
  assert.deepEqual(
    refusals({ documents: [amended({ digestBeforeAmendment: "same", publishedDigest: "same" })] }),
    ["document_not_amended"]
  );
});

test("the amendment has to be in effect, with a date that exists", () => {
  assert.deepEqual(refusals({ documents: [amended({ effectiveFrom: null })] }), [
    "effective_date_missing",
  ]);
  assert.deepEqual(refusals({ documents: [amended({ effectiveFrom: "15 Nov 2026" })] }), [
    "effective_date_missing",
  ]);
  // Rolls over to 3 March if parsed naively; a page showing it shows nothing.
  assert.deepEqual(refusals({ documents: [amended({ effectiveFrom: "2026-02-31" })] }), [
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

test("a notice nobody named, or that reached nobody, is not a notice", () => {
  assert.deepEqual(refusals({ notice: notice({ templateKey: null }) }), [
    "change_notice_unidentified",
  ]);
  assert.deepEqual(refusals({ notice: notice({ firstSentAt: null, reached: 0 }) }), [
    "change_notice_not_sent",
  ]);
});

test("only a legal notice counts", () => {
  // Of the classifications a template may register, only `legal` has neither a
  // purpose a person can switch off nor an unsubscribe. A `service` template
  // must have a purpose, and a `transactional` key could point at login codes
  // and count them as notice.
  for (const [classification, purpose] of [
    ["marketing", "product_updates"],
    ["service", "service_status"],
    ["transactional", null],
  ]) {
    assert.deepEqual(
      refusals({ notice: notice({ classification, purpose }) }),
      ["change_notice_not_legal"],
      `${classification}/${purpose}`
    );
  }
});

test("every problem is reported, not only the first", () => {
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
    { documents: [amended({ verified: false })] },
    { documents: [amended({ digestBeforeAmendment: "x", publishedDigest: "x" })] },
    { documents: [amended({ effectiveFrom: null })] },
    { documents: [amended({ effectiveFrom: "2099-01-01" })] },
    { notice: notice({ firstSentAt: new Date("2026-11-14T00:00:00.000Z") }) },
    { notice: notice({ templateKey: null }) },
    { notice: notice({ firstSentAt: null, reached: 0 }) },
    { notice: notice({ notAttempted: 1 }) },
    { notice: notice({ classification: "transactional" }) },
  ];
  for (const input of cases) for (const refusal of refusals(input)) seen.add(refusal);
  assert.deepEqual([...seen].sort(), [...PUBLICATION_REFUSALS].sort());
});

test("the owed population is anchored on the latest effective date", () => {
  // Every account is owed a notice about every document that changes after it
  // joined, so the latest date is the anchor.
  assert.equal(
    effectiveDateOf([
      amended({ effectiveFrom: "2026-11-15" }),
      amended({ effectiveFrom: "2026-11-20" }),
    ])?.toISOString(),
    "2026-11-20T00:00:00.000Z"
  );
  // Any document without a usable date leaves no anchor at all.
  assert.equal(effectiveDateOf([amended(), amended({ effectiveFrom: null })]), null);
  assert.equal(utcDayStart("2026-11-15")?.toISOString(), "2026-11-15T00:00:00.000Z");
});

// The repository as it stands.

test("section 10's four documents are the ones the gate reads", () => {
  assert.deepEqual(
    [...AMENDED_DOCUMENTS],
    ["/privacy", "/terms", "signup consent copy", "login consent sentence"]
  );
});

test("every verifier the gate relies on exists and names its document", () => {
  // An entry here makes a hand-recorded digest count as evidence; it must point
  // at a test that actually recomputes that document.
  for (const [path, file] of Object.entries(DIGEST_VERIFIED_BY)) {
    assert.ok(existsSync(file), `${path}: ${file} does not exist`);
    assert.ok(readFileSync(file, "utf8").includes(path), `${file} never names ${path}`);
  }
});

test("the recorded pre-amendment state of /privacy is what the site renders today", () => {
  assert.equal(
    DIGEST_BEFORE_AMENDMENT["/privacy"],
    SITEMAP_CONTENT_EVIDENCE["/privacy"].contentSha256
  );
});

test("today, nothing is published and release notes cannot go live", async () => {
  // A pass here would mean the gate is not looking: the amendment is an owner
  // decision not yet made, /terms and the two pieces of consent copy have no
  // recorded state, and no notice template exists.
  assert.equal(CHANGE_NOTICE_TEMPLATE_KEY, null);
  assert.equal(documentFacts().length, 4);
  const problems = (await emailPolicyPublicationProblems(NOW)).map(
    (problem) => `${problem.subject}:${problem.refusal}`
  );
  assert.deepEqual(problems, [
    "/privacy:document_not_amended",
    "/terms:document_state_unrecorded",
    "signup consent copy:document_state_unrecorded",
    "login consent sentence:document_state_unrecorded",
    "change notice:change_notice_unidentified",
  ]);
});
