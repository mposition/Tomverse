import assert from "node:assert/strict";
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
      nonRegular: 0, unscannableContent: 0 }, readManifest: null,
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
    readManifest: { fileCount: 2, digest: "b".repeat(64), bodyPurged: false },
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
  const purged = renderToStaticMarkup(createElement(AmuxIdeaDetailSummary,
    { row: row([{ ...evidence, readManifest: { ...evidence.readManifest!,
      bodyPurged: true } }]) }));
  assert.ok(purged.includes(m.checkoutReadPurged));
  assert.ok(!purged.includes(m.checkoutReadEncrypted));
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
});
