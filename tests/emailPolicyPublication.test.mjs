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
  CHANGE_NOTICE_APPROVED_CONTENT_HASHES,
  CHANGE_NOTICE_TEMPLATE_KEY,
  AMENDED_DOCUMENT_EVIDENCE,
  APPROVED_AMENDED_DIGESTS,
  DIGEST_VERIFIED_BY,
  documentFacts,
} from "../lib/emailPolicyPublication.ts";
import { SITEMAP_CONTENT_EVIDENCE } from "../lib/sitemapContentDates.ts";
import {
  CONSENT_COPY_VERSIONS,
  MAKES_NO_SEND_PROMISE_VERSIONS,
  PROMISE_NO_UNREQUESTED_SEND_VERSIONS,
} from "../lib/emailConsentCopy.ts";
import { AMENDED_DOCUMENT_VERIFIERS } from "./support/amendedDocumentVerifiers.mjs";

const NOW = new Date("2026-12-01T00:00:00.000Z");

const amended = (overrides = {}) => ({
  path: "/privacy",
  approvedDigests: ["new"],
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
  unreachableAccounts: [{ userId: "u1", reason: "hard_bounce" }],
  blockingAccounts: [],
  untold: 0,
  firstSentAt: new Date("2026-10-01T00:00:00.000Z"),
  ...overrides,
});

const refusals = (input) =>
  publicationProblems({
    documents: [amended()],
    notice: notice(),
    now: NOW,
    ...input,
  }).map((problem) => problem.refusal);

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
  assert.deepEqual(refusals({ documents: [amended({ approvedDigests: [] })] }), [
    "document_state_unrecorded",
  ]);
  assert.deepEqual(refusals({ documents: [amended({ publishedDigest: null })] }), [
    "document_state_unrecorded",
  ]);
  assert.deepEqual(refusals({ documents: [amended({ verified: false })] }), [
    "document_state_unverified",
  ]);
});

test("a page counts only while it renders a version approved as carrying the amendment", () => {
  // Not "changed since before": /privacy changed for an unrelated reason on the
  // day this was written, and that change is not the amendment.
  assert.deepEqual(refusals({ documents: [amended({ publishedDigest: "unrelated-edit" })] }), [
    "document_not_amended",
  ]);
  // Several approved versions are fine: an edit after the amendment is added to
  // the list once somebody has approved that it still carries it.
  assert.deepEqual(refusals({ documents: [amended({ approvedDigests: ["v1", "new"] })] }), []);
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
    { documents: [amended({ approvedDigests: [] })] },
    { documents: [amended({ verified: false })] },
    { documents: [amended({ publishedDigest: "x" })] },
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

test("the amended documents are the two pages", () => {
  // The login sentence does not change (email is not bundled into it) and the
  // consent devices keep their promise under the owner's option B, so neither
  // is a document this amendment changes.
  assert.deepEqual([...AMENDED_DOCUMENTS], ["/privacy", "/terms"]);
});

test("every document the gate calls verified is recomputed here and matches its record", () => {
  // Run, not read. An earlier version only looked for strings in a named test
  // file, so a file that mentioned the tokens and hashed anything would have
  // turned a hand-typed digest into evidence.
  assert.deepEqual(
    Object.keys(DIGEST_VERIFIED_BY).sort(),
    Object.keys(AMENDED_DOCUMENT_VERIFIERS).sort(),
    "every verified document needs a verifier, and every verifier a claim"
  );
  for (const [path, { record }] of Object.entries(DIGEST_VERIFIED_BY)) {
    const verifier = AMENDED_DOCUMENT_VERIFIERS[path];
    assert.equal(verifier.record, record, `${path}: the verifier checks a different record`);
    const recorded =
      record === "sitemap" ? SITEMAP_CONTENT_EVIDENCE[path] : AMENDED_DOCUMENT_EVIDENCE[path];
    assert.ok(recorded, `${path}: nothing is recorded in the ${record} table`);
    assert.equal(verifier.digest(), recorded.contentSha256, `${path}: the recorded digest is not what renders`);
    assert.ok(verifier.showsDate(recorded.date), `${path}: the page does not show ${recorded.date}`);
    // And the verifier can tell a wrong date from the right one.
    assert.equal(verifier.showsDate("1999-01-01"), false, `${path}: the date check accepts anything`);
  }
});

test("a consent copy version that makes no promise has changed the promise in every language", () => {
  // Membership in MAKES_NO_SEND_PROMISE_VERSIONS is a claim; this checks the
  // words behind it. The in-product notice body is where today's version tells
  // existing accounts nothing is sent unless they ask. A version filed as
  // making no promise with that sentence unchanged in any language would open
  // the gate on copy that still promises.
  const promising = CONSENT_COPY_VERSIONS.filter((entry) =>
    PROMISE_NO_UNREQUESTED_SEND_VERSIONS.has(entry.version)
  );
  assert.ok(promising.length > 0);
  for (const entry of CONSENT_COPY_VERSIONS) {
    if (!MAKES_NO_SEND_PROMISE_VERSIONS.has(entry.version)) continue;
    for (const old of promising) {
      for (const [language, text] of Object.entries(old.copy.noticeBody)) {
        assert.notEqual(
          entry.copy.noticeBody?.[language],
          text,
          `${entry.version} ${language}: the notice body still carries ${old.version}'s promise`
        );
      }
    }
  }
});

test("the published version of each document is the one approved as carrying the amendment", () => {
  // docs/policy/email-policy-amendment-draft.md §2, §3 and §5, approved by
  // mposition on 2026-10-03.
  assert.deepEqual(APPROVED_AMENDED_DIGESTS["/privacy"], [AMENDED_DOCUMENT_EVIDENCE["/privacy"].contentSha256]);
  assert.deepEqual(APPROVED_AMENDED_DIGESTS["/terms"], [AMENDED_DOCUMENT_EVIDENCE["/terms"].contentSha256]);
  assert.equal(AMENDED_DOCUMENT_EVIDENCE["/privacy"].date, "2026-11-16");
  // A future effective date is not a lastmod (lib/sitemapContentDates.ts).
  assert.equal(SITEMAP_CONTENT_EVIDENCE["/privacy"], undefined);
  assert.equal(AMENDED_DOCUMENT_EVIDENCE["/terms"].date, "2026-11-16");
});

test("the documents are published, and only the notice and the date stand between them and release notes", () => {
  assert.equal(CHANGE_NOTICE_TEMPLATE_KEY, "policy_change_notice");
  assert.equal(CHANGE_NOTICE_APPROVED_CONTENT_HASHES.length, 7);
  assert.equal(documentFacts().length, 2);
  // No notice sent: the documents themselves raise nothing once the date has
  // passed, and before it each one says so.
  const unsent = {
    templateKey: "policy_change_notice",
    classification: "legal",
    purpose: null,
    owed: 10,
    told: 0,
    late: 0,
    unreachable: 0,
    unreachableAccounts: [],
    blockingAccounts: [],
    untold: 10,
    firstSentAt: null,
  };
  const after = publicationProblems({ documents: documentFacts(), notice: unsent, now: NOW }).map(
    (problem) => `${problem.subject}:${problem.refusal}`
  );
  assert.ok(!after.some((entry) => entry.startsWith("/")), after.join(", "));
  assert.ok(after.includes("policy_change_notice:change_notice_not_sent"), after.join(", "));
  const before = publicationProblems({
    documents: documentFacts(),
    notice: unsent,
    now: new Date("2026-11-15T23:59:59.000Z"),
  }).map((problem) => `${problem.subject}:${problem.refusal}`);
  assert.ok(before.includes("/privacy:effective_date_not_reached"), before.join(", "));
  assert.ok(before.includes("/terms:effective_date_not_reached"), before.join(", "));
});

test("the test seam cannot be used outside tests", async () => {
  // The campaign suites set it; the application must never be able to. It
  // throws unless NODE_ENV is "test", which the DB integration runner sets and
  // the application never does.
  const { setEmailPolicyPublishedForTests } = await import("../lib/emailPolicyPublication.ts");
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    assert.throws(() => setEmailPolicyPublishedForTests(true), /tests only/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
