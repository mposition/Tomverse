// S10: what has to be published, and told to whom, before release notes go live.
//
// Contract: docs/policy/email-product-news-redesign-draft.md sections 10, 11
// approval E and 12 (S10); docs/policy/email-notifications.md section 3.1 type 5.
//
// The pure tests pin each refusal. The per-account classification is SQL and is
// tested against a database in tests/integration/email-policy-publication.db.test.ts.
// The last group reads the repository as it is and asserts the gate is closed
// today -- a pass would mean the gate is not looking.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  PUBLICATION_REFUSALS,
  effectiveDateOf,
  noticeDeadline,
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
  told: 9,
  late: 0,
  unreachable: 1,
  untold: 0,
  firstSentAt: new Date("2026-10-01T00:00:00.000Z"),
  ...overrides,
});

const refusals = (input) =>
  publicationProblems({ documents: [amended()], notice: notice(), now: NOW, ...input }).map(
    (problem) => problem.refusal
  );

test("a published amendment with every owed account told passes", () => {
  // One of ten unreachable is reported by the counts and does not block.
  assert.deepEqual(refusals({}), []);
});

test("an account told late, or not at all, blocks", () => {
  assert.deepEqual(refusals({ notice: notice({ late: 1 }) }), ["notice_period_too_short"]);
  assert.deepEqual(refusals({ notice: notice({ untold: 1 }) }), ["change_notice_incomplete"]);
  assert.deepEqual(refusals({ notice: notice({ told: 0, late: 0 }) }), [
    "change_notice_not_sent",
  ]);
});

test("a page nobody recorded, or nobody verifies, is not shown to have changed", () => {
  assert.deepEqual(refusals({ documents: [amended({ digestBeforeAmendment: null })] }), [
    "document_state_unrecorded",
  ]);
  assert.deepEqual(refusals({ documents: [amended({ publishedDigest: null })] }), [
    "document_state_unrecorded",
  ]);
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

test("the amendment has one effective date, that exists and has arrived", () => {
  assert.deepEqual(refusals({ documents: [amended({ effectiveFrom: null })] }), [
    "effective_date_missing",
  ]);
  assert.deepEqual(refusals({ documents: [amended({ effectiveFrom: "2026-02-31" })] }), [
    "effective_date_missing",
  ]);
  assert.deepEqual(refusals({ documents: [amended({ effectiveFrom: "2026-12-02" })] }), [
    "effective_date_not_reached",
  ]);
  // Two dates are two amendments' worth of notice periods from one window, which
  // the second version showed cannot be satisfied.
  assert.deepEqual(
    refusals({
      documents: [amended(), amended({ path: "/terms", effectiveFrom: "2026-11-20" })],
    }),
    ["effective_dates_differ"]
  );
  assert.equal(
    effectiveDateOf([amended(), amended({ effectiveFrom: "2026-11-20" })]),
    null
  );
});

test("the notice deadline is a calendar day, thirty days out", () => {
  // Effective 15 November: sending any time on 16 October gives thirty days, so
  // the first late instant is 17 October at midnight.
  assert.equal(
    noticeDeadline(utcDayStart("2026-11-15")).toISOString(),
    "2026-10-17T00:00:00.000Z"
  );
});

test("a notice nobody named is not a notice, and only a legal one counts", () => {
  assert.deepEqual(refusals({ notice: notice({ templateKey: null }) }), [
    "change_notice_unidentified",
  ]);
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

test("every refusal the core can produce is in the closed list", () => {
  const seen = new Set();
  const cases = [
    { documents: [amended({ digestBeforeAmendment: null })] },
    { documents: [amended({ verified: false })] },
    { documents: [amended({ digestBeforeAmendment: "x", publishedDigest: "x" })] },
    { documents: [amended({ effectiveFrom: null })] },
    { documents: [amended(), amended({ effectiveFrom: "2026-11-16" })] },
    { documents: [amended({ effectiveFrom: "2099-01-01" })] },
    { notice: notice({ late: 1 }) },
    { notice: notice({ templateKey: null }) },
    { notice: notice({ told: 0, late: 0 }) },
    { notice: notice({ untold: 1 }) },
    { notice: notice({ classification: "transactional" }) },
  ];
  for (const input of cases) for (const refusal of refusals(input)) seen.add(refusal);
  assert.deepEqual([...seen].sort(), [...PUBLICATION_REFUSALS].sort());
});

// The repository as it stands.

test("section 10's four documents are the ones the gate reads", () => {
  assert.deepEqual(
    [...AMENDED_DOCUMENTS],
    ["/privacy", "/terms", "signup consent copy", "login consent sentence"]
  );
});

test("every verifier the gate relies on hashes the document and compares it", () => {
  // Mentioning a path is not verifying it. The named test has to compute a
  // SHA-256 and compare it with the recorded `contentSha256` for that path, or an
  // entry here would let a hand-typed digest count as evidence.
  for (const [path, file] of Object.entries(DIGEST_VERIFIED_BY)) {
    assert.ok(existsSync(file), `${path}: ${file} does not exist`);
    const source = readFileSync(file, "utf8");
    assert.match(source, /createHash\(\s*"sha256"\s*\)/, `${file} computes no digest`);
    assert.ok(
      source.includes(`["${path}"].contentSha256`),
      `${file} never compares a digest with the recorded one for ${path}`
    );
  }
});

test("the recorded pre-amendment state of /privacy is what the site renders today", () => {
  assert.equal(
    DIGEST_BEFORE_AMENDMENT["/privacy"],
    SITEMAP_CONTENT_EVIDENCE["/privacy"].contentSha256
  );
});

test("today, nothing is published and release notes cannot go live", async () => {
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
