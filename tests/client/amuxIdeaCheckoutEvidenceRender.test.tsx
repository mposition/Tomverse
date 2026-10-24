import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AmuxIdeaDetailSummary } from "@/components/admin/AmuxIdeaDetailSummary";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";
import { amuxIdeaProgress } from "@/lib/amux/ideaProgressCore";
import type { AmuxIdeaProgressRow } from "@/lib/amux/ideaProgressRead";

const row = (checkoutEvidence: AmuxIdeaProgressRow["checkoutEvidence"]): AmuxIdeaProgressRow => ({
  ...amuxIdeaProgress({ state: "submitted", cancelled: false, chunks: [],
    proposedUnits: 0, cards: [] }),
  ideaId: "idea-1", requestId: "11111111-1111-4111-8111-111111111111",
  submittedAt: "2026-10-16T00:00:00.000Z", displayKey: null,
  reviewPullRequests: [], taskRows: [], checkoutEvidence, referencePins: null,
});

test("Admin shows the intake SHA before checkout evidence exists", () => {
  const sessionRow = { ...row([]), submissionOrigin: "session" as const,
    referencePins: [{ referenceOrdinal: 0, pinnedCommitSha: "a".repeat(40) }] };
  const markup = renderToStaticMarkup(createElement(AmuxIdeaDetailSummary,
    { row: sessionRow }));
  assert.match(markup, /data-testid="amux-intake-pins"/);
  assert.ok(markup.includes("a".repeat(40)));
  assert.doesNotMatch(markup, /data-testid="amux-checkout-evidence"/);
});

test("Admin distinguishes an older unpinned idea from a damaged pin", () => {
  const legacy = renderToStaticMarkup(createElement(AmuxIdeaDetailSummary,
    { row: { ...row([]), submissionOrigin: "session",
      referencePinsLegacy: true } }));
  const unknown = renderToStaticMarkup(createElement(AmuxIdeaDetailSummary,
    { row: { ...row([]), submissionOrigin: "session",
      referencePinsLegacy: false } }));
  const m = legacy.includes(adminAmuxIdeaProgressMessages.ko.intakePinsLegacy)
    ? adminAmuxIdeaProgressMessages.ko : adminAmuxIdeaProgressMessages.en;
  assert.ok(legacy.includes(m.intakePinsLegacy));
  assert.doesNotMatch(legacy, /role="alert"/);
  assert.ok(unknown.includes(m.intakePinsUnavailable));
  assert.match(unknown, /role="alert"/);
});

test("Admin idea detail shows pinned SHA and exclusion reasons without private paths", () => {
  const markup = renderToStaticMarkup(createElement(AmuxIdeaDetailSummary, { row: row([{
    referenceOrdinal: 0, pinnedCommitSha: "a".repeat(40), excludedCount: 2,
    excludedReasons: { secretPath: 1, secretContent: 1,
      nonRegular: 0, unscannableContent: 0 }, readManifests: [],
  }]) }));
  assert.match(markup, /data-testid="amux-checkout-evidence"/);
  assert.ok(markup.includes("a".repeat(40)));
  const m = markup.includes(adminAmuxIdeaProgressMessages.ko.checkoutEvidenceTitle)
    ? adminAmuxIdeaProgressMessages.ko : adminAmuxIdeaProgressMessages.en;
  assert.ok(markup.includes(m.checkoutReference(0)));
  assert.ok(markup.includes(m.checkoutExcluded(2)));
  assert.ok(markup.includes(`${m.checkoutReasons.secretPath}: 1`));
  assert.ok(markup.includes(`${m.checkoutReasons.secretContent}: 1`));
  assert.ok(!markup.includes(`${m.checkoutReasons.nonRegular}: 0`));
  assert.ok(!markup.includes(".env") && !markup.includes("/tmp/"));
  assert.doesNotMatch(renderToStaticMarkup(createElement(AmuxIdeaDetailSummary,
    { row: row([]) })), /data-testid="amux-checkout-evidence"/);
});

test("both Admin locales describe one excluded file correctly", () => {
  assert.equal(adminAmuxIdeaProgressMessages.en.checkoutExcluded(1), "1 file excluded");
  assert.equal(adminAmuxIdeaProgressMessages.en.checkoutExcluded(2), "2 files excluded");
  assert.equal(adminAmuxIdeaProgressMessages.ko.checkoutExcluded(1), "제외한 파일 1개");
});

test("Admin shows read-file count, digest and purge state without stored paths", () => {
  const evidence: AmuxIdeaProgressRow["checkoutEvidence"][number] = {
    referenceOrdinal: 0, pinnedCommitSha: "a".repeat(40), excludedCount: 0,
    excludedReasons: { secretPath: 0, secretContent: 0,
      nonRegular: 0, unscannableContent: 0 },
    readManifests: [{ manifestId: "9b7e4b8e-2d34-48b2-95a5-333360b10816",
      fileCount: 2, digest: "b".repeat(64), bodyPurged: false }],
  };
  const active = renderToStaticMarkup(createElement(AmuxIdeaDetailSummary,
    { row: row([evidence]) }));
  const m = active.includes(adminAmuxIdeaProgressMessages.en.checkoutEvidenceTitle)
    ? adminAmuxIdeaProgressMessages.en : adminAmuxIdeaProgressMessages.ko;
  assert.match(active, /data-testid="amux-checkout-read-manifest"/);
  assert.ok(active.includes("b".repeat(64)));
  assert.ok(active.includes(m.checkoutReadFiles(2)));
  assert.ok(active.includes(m.checkoutReadEncrypted));
  assert.ok(!active.includes(m.checkoutReadPurged));
  assert.ok(!active.includes("docs/private.md"));
  assert.ok(!active.includes(m.checkoutReadPage(1)), "one page needs no page label");
  const purged = renderToStaticMarkup(createElement(AmuxIdeaDetailSummary,
    { row: row([{ ...evidence, readManifests: [{ ...evidence.readManifests[0]!,
      bodyPurged: true }] }]) }));
  assert.ok(purged.includes(m.checkoutReadPurged));
  assert.ok(!purged.includes(m.checkoutReadEncrypted));
});

test("Admin shows each analysis page's read files on its own", () => {
  const evidence: AmuxIdeaProgressRow["checkoutEvidence"][number] = {
    referenceOrdinal: 0, pinnedCommitSha: "a".repeat(40), excludedCount: 0,
    excludedReasons: { secretPath: 0, secretContent: 0,
      nonRegular: 0, unscannableContent: 0 },
    readManifests: [
      { manifestId: "9b7e4b8e-2d34-48b2-95a5-333360b10816", fileCount: 1,
        digest: "b".repeat(64), bodyPurged: true },
      { manifestId: "2f0c3c1e-5b7a-4e8f-9d1a-0c6b5e4d3a21", fileCount: 3,
        digest: "c".repeat(64), bodyPurged: false }],
  };
  const markup = renderToStaticMarkup(createElement(AmuxIdeaDetailSummary,
    { row: row([evidence]) }));
  const m = markup.includes(adminAmuxIdeaProgressMessages.en.checkoutEvidenceTitle)
    ? adminAmuxIdeaProgressMessages.en : adminAmuxIdeaProgressMessages.ko;
  assert.equal(markup.match(/data-testid="amux-checkout-read-manifest"/g)?.length, 2);
  for (const text of [m.checkoutReadPage(1), m.checkoutReadPage(2),
    m.checkoutReadFiles(1), m.checkoutReadFiles(3), "b".repeat(64), "c".repeat(64),
    m.checkoutReadPurged, m.checkoutReadEncrypted]) assert.ok(markup.includes(text), text);
  // Only the page whose paths are still stored offers to show them.
  assert.equal(markup.split(m.checkoutReadShowPaths).length - 1, 1);
});

test("both Admin locales distinguish retained and deleted read-file paths", () => {
  assert.equal(adminAmuxIdeaProgressMessages.en.checkoutReadFiles(1), "1 file read by the CLI");
  assert.equal(adminAmuxIdeaProgressMessages.ko.checkoutReadFiles(1), "CLI가 읽은 파일 1개");
  assert.notEqual(adminAmuxIdeaProgressMessages.en.checkoutReadEncrypted,
    adminAmuxIdeaProgressMessages.en.checkoutReadPurged);
  assert.notEqual(adminAmuxIdeaProgressMessages.ko.checkoutReadEncrypted,
    adminAmuxIdeaProgressMessages.ko.checkoutReadPurged);
});

test("a session idea carries the analysis stop control; a v4 idea does not", () => {
  const session = renderToStaticMarkup(createElement(AmuxIdeaDetailSummary,
    { row: { ...row([]), submissionOrigin: "session" } }));
  assert.match(session, /data-testid="amux-v19-session-analysis-stop" data-state="checking"/);
  // Nothing is offered before the server says a claim is running.
  const m = session.includes(adminAmuxIdeaProgressMessages.ko.sessionStop.title)
    ? adminAmuxIdeaProgressMessages.ko : adminAmuxIdeaProgressMessages.en;
  assert.ok(!session.includes(m.sessionStop.action));
  assert.doesNotMatch(renderToStaticMarkup(createElement(AmuxIdeaDetailSummary,
    { row: row([]) })), /amux-v19-session-analysis-stop/);
});

test("both Admin locales state what a stop does before it is sent", () => {
  for (const locale of [adminAmuxIdeaProgressMessages.en, adminAmuxIdeaProgressMessages.ko]) {
    assert.deepEqual(Object.keys(locale.sessionStop).sort(),
      Object.keys(adminAmuxIdeaProgressMessages.en.sessionStop).sort());
    assert.ok(locale.sessionStop.startedAt("2026-10-19T00:00:00.000Z").includes("2026-10-19"));
    assert.ok(locale.sessionStop.elapsed("01:02:03").includes("01:02:03"));
  }
  assert.match(adminAmuxIdeaProgressMessages.en.sessionStop.confirm, /never sent again/);
  assert.match(adminAmuxIdeaProgressMessages.ko.sessionStop.confirm, /다시 보내지 않고/);
});

test("a session answer that made no plan says so and why nothing was registered", () => {
  const parked = { ...row([]), submissionOrigin: "session" as const,
    ...amuxIdeaProgress({ state: "awaiting_owner", submissionOrigin: "session",
      cancelled: false, chunks: [], proposedUnits: 0, cards: [] }) };
  assert.equal(parked.waitingFor, "session_review");
  const markup = renderToStaticMarkup(createElement(AmuxIdeaDetailSummary,
    { row: parked }));
  assert.match(markup, /data-testid="amux-session-review"/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(AmuxIdeaDetailSummary,
    { row: { ...row([]), submissionOrigin: "session" } })), /amux-session-review/);
  for (const locale of [adminAmuxIdeaProgressMessages.en, adminAmuxIdeaProgressMessages.ko]) {
    assert.ok(locale.sessionReview && locale.sessionReviewHint && locale.sessionReviewDetail);
  }
  // Owner decision 2026-10-23: the reason (and a model question) is read once
  // the idea is opened; the server enforces the seven-day answer retention.
  assert.match(markup, /data-testid="amux-session-review-reason"/);
  const m = markup.includes(adminAmuxIdeaProgressMessages.ko.sessionReviewLoading)
    ? adminAmuxIdeaProgressMessages.ko : adminAmuxIdeaProgressMessages.en;
  assert.ok(markup.includes(m.sessionReviewLoading), "it starts by reading");
  assert.doesNotMatch(renderToStaticMarkup(createElement(AmuxIdeaDetailSummary,
    { row: { ...row([]), submissionOrigin: "session" } })), /amux-session-review-reason/);
  for (const locale of [adminAmuxIdeaProgressMessages.en, adminAmuxIdeaProgressMessages.ko]) {
    assert.ok(locale.sessionReviewQuestionTitle && locale.sessionReviewQuestionHint &&
      locale.sessionReviewNotAPlan && locale.sessionReviewGone && locale.sessionReviewUnavailable);
  }
  const source = fs.readFileSync("components/admin/AmuxSessionReviewPanel.tsx", "utf8");
  assert.ok(source.includes("/api/admin/amux/ideas/session-review?"));
  assert.ok(source.includes("readAmuxSessionReviewReply"), "only an exact reply is shown");
  assert.equal(/method:s*"POST"/.test(source), false, "the panel only reads");
});
