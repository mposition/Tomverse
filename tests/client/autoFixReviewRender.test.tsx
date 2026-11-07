import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";

import { AutoFixReviewPanel, autoFixWaitingKind } from "@/components/admin/AutoFixReviewPanel";
import type { FeedbackRow } from "@/components/admin/FeedbackInboxPanel";
import { SupportReadFailedBlock } from "@/components/admin/SupportReadFailedBlock";
import { AdminPrivacyRequestsPanel } from "@/components/admin/AdminPrivacyRequestsPanel";
import { AUTOFIX_CASE_STATE, AUTOFIX_CLASSIFICATION } from "@/lib/feedbackAutoFixCore";
import { adminFeedbackInboxMessages } from "@/lib/adminMessages/feedbackInbox";
import { adminPrivacyRequestsMessages } from "@/lib/adminMessages/privacyRequests";

/**
 * Support › Auto-fix review is the newest reports seen by their automation
 * case: read only, no read of its own, and an honest empty or error state.
 */

const m = adminFeedbackInboxMessages.en;
const router: AppRouterInstance = {
  back: () => {},
  forward: () => {},
  refresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: () => {},
  bfcacheId: "autofix-review-fixture",
};
const count = (markup: string, needle: string) => markup.split(needle).length - 1;

const report = (id: string, autoFixCase: FeedbackRow["autoFixCase"], overrides: Partial<FeedbackRow> = {}): FeedbackRow => ({
  id,
  userId: null,
  email: "reporter@example.com",
  type: "bug",
  status: "reviewing",
  message: `Report ${id} stopped.\nSecond line.`,
  traceId: `trace-${id}`,
  modelId: null,
  plan: null,
  hasAttachments: false,
  attachmentCount: 0,
  path: null,
  userAgent: null,
  language: "en",
  emailUpdatesConsent: true,
  closureOutcome: null,
  userReply: null,
  errorReportVerification: "verified",
  traceProvenance: null,
  errorClassificationSource: null,
  clientErrorCode: null,
  evidenceAvailability: null,
  autoFixCase,
  completionSnapshot: null,
  replyDelivery: null,
  traceEvidence: null,
  createdAt: "2026-11-05T01:30:00.000Z",
  ...overrides,
});

const done = (overrides: Record<string, unknown> = {}) =>
  ({
    status: "done" as const,
    kind: "code_fix",
    confidence: "high",
    cause: "A null model id.",
    recommendation: "Check the route.",
    handedOff: false,
    prNumber: null,
    ...overrides,
  }) as NonNullable<NonNullable<FeedbackRow["autoFixCase"]>["analysis"]>;

const fixCase = (state: string, overrides: Partial<NonNullable<FeedbackRow["autoFixCase"]>> = {}) => ({
  state,
  classification: "application_candidate",
  ineligibilityReason: null,
  updatedAt: "2026-11-05T03:00:00.000Z",
  analysis: null,
  ...overrides,
});

test("a case is waiting for a person when it needs a look, or its fix is a draft PR or handed off", () => {
  assert.equal(autoFixWaitingKind(report("a", null)), null);
  assert.equal(autoFixWaitingKind(report("a", fixCase("awaiting_human_review"))), "awaiting_human_review");
  assert.equal(autoFixWaitingKind(report("a", fixCase("classifying"))), null);
  assert.equal(autoFixWaitingKind(report("a", fixCase("ineligible", { classification: "provider_transient" }))), null);
  assert.equal(autoFixWaitingKind(report("a", fixCase("closed", { analysis: done({ handedOff: true }) }))), "handedOff");
  assert.equal(
    autoFixWaitingKind(report("a", fixCase("closed", { analysis: done({ handedOff: true, prNumber: 12 }) }))),
    "prOpen"
  );
  // An analysis that failed, or one with no fix to hand over, waits on nobody by itself.
  assert.equal(autoFixWaitingKind(report("a", fixCase("closed", { analysis: { status: "failed" } }))), null);
  assert.equal(autoFixWaitingKind(report("a", fixCase("closed", { analysis: done() }))), null);
});

test("waiting fixes are listed with their state, reason, time in AEST, analysis and a link to the inquiry", () => {
  const out = renderToStaticMarkup(
    <AutoFixReviewPanel
      rowLimit={20}
      rows={[
        report("one", fixCase("awaiting_human_review", { analysis: done({ handedOff: true, prNumber: 7 }) })),
        report("two", fixCase("awaiting_human_review", { ineligibilityReason: "needs a person" })),
        report("three", fixCase("ineligible", { classification: "provider_transient", ineligibilityReason: "provider side" })),
      ]}
    />
  );
  assert.equal(count(out, 'data-testid="autofix-review-row"'), 2);
  assert.ok(out.includes(m.autoFix.states.prOpen));
  assert.ok(out.includes(m.autoFix.states.awaiting_human_review));
  assert.ok(out.includes(m.autoFix.classifications.application_candidate));
  assert.ok(out.includes(m.autoFix.updated("2026-11-05 13:00 AEST")));
  assert.ok(out.includes("A null model id."));
  assert.match(out, /href="https:\/\/github\.com\/mposition\/Tomverse\/pull\/7"/);
  assert.ok(out.includes(m.autoFix.reason("needs a person")));
  assert.ok(out.includes('href="/admin/support?tab=feedback&amp;q=one"'));
  assert.ok(out.includes(m.autoFix.scope(20)));
  // Read only: nothing here runs, approves or changes a fix.
  assert.ok(!out.includes("<button"));
  assert.ok(out.includes(m.autoFix.readOnly));
  // The case nobody waits on is named in the folded details, with its reason.
  const tech = out.slice(out.indexOf("<details"));
  assert.ok(tech.includes(m.autoFix.othersSummary(1)));
  assert.ok(tech.includes("provider side"));
  assert.ok(tech.includes(m.autoFix.classifications.provider_transient));
});

test("no waiting fix says so, and names how far back it looked", () => {
  const out = renderToStaticMarkup(<AutoFixReviewPanel rowLimit={20} rows={[report("a", null)]} />);
  assert.ok(out.includes('data-testid="autofix-review-empty"'));
  assert.ok(out.includes(m.autoFix.emptyTitle));
  assert.ok(out.includes(m.autoFix.emptyDetail(20)));
  assert.equal(count(out, 'data-testid="autofix-review-row"'), 0);
});

test("both languages describe every state, classification and case state the list can show", () => {
  const ko = adminFeedbackInboxMessages.ko.autoFix;
  for (const group of ["states", "classifications", "caseStates"] as const) {
    assert.deepEqual(Object.keys(ko[group]).sort(), Object.keys(m.autoFix[group]).sort(), group);
  }
  // Every state and classification the automation can record has words here.
  for (const state of Object.values(AUTOFIX_CASE_STATE)) {
    assert.ok(state in m.autoFix.caseStates, `case state ${state} has no label`);
  }
  for (const classification of Object.values(AUTOFIX_CLASSIFICATION)) {
    assert.ok(classification in m.autoFix.classifications, `classification ${classification} has no label`);
  }
});

test("a failed read is an alert with a retry, never an empty list", () => {
  for (const read of ["inquiries", "autofix"] as const) {
    const out = renderToStaticMarkup(
      <AppRouterContext.Provider value={router}>
        <SupportReadFailedBlock read={read} />
      </AppRouterContext.Provider>
    );
    assert.match(out, /role="alert"/);
    assert.match(out, /Try again<\/button>/);
    assert.ok(out.includes(read === "autofix" ? m.autoFix.readFailedTitle : m.readFailedTitle));
    assert.ok(!out.includes(m.autoFix.emptyTitle));
    assert.ok(!out.includes(m.emptyAll));
  }
});

test("the privacy queue draws a loading state, not an empty one, before its read comes back", () => {
  const pm = adminPrivacyRequestsMessages.en;
  const out = renderToStaticMarkup(<AdminPrivacyRequestsPanel />);
  assert.ok(out.includes(pm.title));
  assert.ok(out.includes(pm.addTitle));
  assert.match(out, /role="status" aria-label="Loading"/);
  assert.ok(!out.includes(pm.empty));
  assert.ok(!out.includes(pm.readFailedTitle));
});

test("a failed privacy read is held as an error with a retry, and an empty one needs a settled read", () => {
  const source = readFileSync("components/admin/AdminPrivacyRequestsPanel.tsx", "utf8");
  assert.match(source, /setLoadFailed\(true\)/);
  assert.match(source, /kind="error"[\s\S]*onRetry/);
  // The empty message waits for a read that finished and did not fail.
  assert.match(source, /!loading && !loadFailed && rows\.length === 0/);
});
