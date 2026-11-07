import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import {
  FeedbackFoldToggle,
  FeedbackInboxPanel,
  feedbackFirstLine,
  isFeedbackCardOpen,
  type FeedbackRow,
} from "@/components/admin/FeedbackInboxPanel";
import { adminFeedbackInboxMessages } from "@/lib/adminMessages/feedbackInbox";

/**
 * Support › Feedback folds finished reports to one line. The first render is
 * what these pin; opening and focus need a real browser and live in
 * tests/e2e-admin/admin-read-surfaces.spec.ts.
 */

const m = adminFeedbackInboxMessages.en;

const router: AppRouterInstance = {
  back: () => {},
  forward: () => {},
  refresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: () => {},
  bfcacheId: "feedback-fold-fixture",
};

const row = (overrides: Partial<FeedbackRow>): FeedbackRow => ({
  id: "report-open",
  userId: null,
  email: "reporter@example.com",
  type: "bug",
  status: "open",
  message: "The answer stopped.",
  traceId: "trace-1234",
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
  errorReportVerification: null,
  traceProvenance: null,
  errorClassificationSource: null,
  clientErrorCode: null,
  evidenceAvailability: null,
  autoFixCase: null,
  completionSnapshot: null,
  replyDelivery: null,
  traceEvidence: null,
  createdAt: "2026-11-05T01:30:00.000Z",
  ...overrides,
});

const panel = (rows: FeedbackRow[], search = "") =>
  renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/admin/support">
        <SearchParamsContext.Provider value={new URLSearchParams(search)}>
          <FeedbackInboxPanel rows={rows} />
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );

const toggle = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);
const count = (markup: string, needle: string) => markup.split(needle).length - 1;

const finished = row({
  id: "report-finished",
  status: "resolved",
  message: "\nExport failed on the long chat.\nThe second line stays inside the fold.",
  traceId: "trace-finished",
});

test("a finished report starts as one summary line and a working one stays a full card", () => {
  const out = panel([row({}), finished, row({ id: "report-closed", status: "closed" })]);

  assert.equal(count(out, 'data-testid="feedback-entry"'), 3);
  assert.equal(count(out, 'data-testid="feedback-fold-toggle"'), 2, "one per finished report");
  assert.equal(count(out, 'aria-expanded="false"'), 2);
  assert.ok(!out.includes('aria-expanded="true"'));

  // The working report keeps its card: its body, trace and status buttons.
  assert.ok(out.includes("The answer stopped."));
  assert.ok(out.includes("trace-1234"));
  assert.ok(out.includes(m.copyContext));

  // The folded one shows the summary only.
  assert.ok(out.includes("Export failed on the long chat."));
  assert.ok(out.includes("2026-11-05 11:30 AEST"));
  assert.ok(!out.includes("The second line stays inside the fold."));
  assert.ok(!out.includes("trace-finished"));
  assert.equal(count(out, m.copyContext), 1, "only the working report offers its actions");
});

test("a search opens the finished reports it found, so the match can be seen", () => {
  const out = panel([finished], "q=trace-finished");
  assert.ok(out.includes('aria-expanded="true"'));
  assert.ok(out.includes("trace-finished"));
  assert.ok(out.includes("The second line stays inside the fold."));
  assert.ok(out.includes(m.copyContext));
  assert.ok(out.includes(m.foldReport));
});

test("a status filter alone leaves finished reports folded", () => {
  const out = panel([finished], "status=resolved");
  assert.ok(out.includes('aria-expanded="false"'));
  assert.ok(!out.includes("trace-finished"));
});

test("the operator's choice beats the default, and only finished reports fold", () => {
  assert.equal(isFeedbackCardOpen("open", false, false), true);
  assert.equal(isFeedbackCardOpen("reviewing", undefined, false), true);
  assert.equal(isFeedbackCardOpen("resolved", undefined, false), false);
  assert.equal(isFeedbackCardOpen("closed", undefined, false), false);
  assert.equal(isFeedbackCardOpen("closed", true, false), true);
  assert.equal(isFeedbackCardOpen("closed", undefined, true), true);
  assert.equal(isFeedbackCardOpen("closed", false, true), false);
});

test("the summary uses the first line that has text in it", () => {
  assert.equal(feedbackFirstLine("one line"), "one line");
  assert.equal(feedbackFirstLine("\r\n   \r\n  second \r\nthird"), "second");
  assert.equal(feedbackFirstLine("  \n "), "");
});

test("the toggle is a real button that states whether the card is open, in both languages", () => {
  const folded = toggle(
    <FeedbackFoldToggle feedback={finished} open={false} onToggle={() => {}} m={m} />
  );
  assert.match(folded, /^<button type="button"/);
  assert.ok(folded.includes('aria-expanded="false"'));
  assert.ok(folded.includes(m.statuses.resolved));

  const opened = toggle(
    <FeedbackFoldToggle feedback={finished} open onToggle={() => {}} m={m} />
  );
  assert.match(opened, /^<button type="button"/);
  assert.ok(opened.includes('aria-expanded="true"'));
  assert.ok(opened.includes(m.foldReport));

  const ko = adminFeedbackInboxMessages.ko;
  const koreanOpen = toggle(
    <FeedbackFoldToggle feedback={finished} open onToggle={() => {}} m={ko} />
  );
  assert.ok(koreanOpen.includes(ko.foldReport));
  const koreanFolded = toggle(
    <FeedbackFoldToggle feedback={finished} open={false} onToggle={() => {}} m={ko} />
  );
  assert.ok(koreanFolded.includes(ko.statuses.resolved));
});

test("a folded row names a reply that never reached the reporter, and nothing else", () => {
  const reply = { outcomeCode: "fixed", userReply: "It is fixed now." };
  const delivery = {
    resent: false,
    attempts: 3,
    lastErrorKind: null,
    acceptedAt: null,
    updatedAt: "2026-11-05T02:00:00.000Z",
  };
  const mark = 'data-testid="feedback-fold-reply-undelivered"';
  const render = (overrides: Partial<FeedbackRow>) =>
    toggle(
      <FeedbackFoldToggle
        feedback={row({ status: "resolved", ...overrides })}
        open={false}
        onToggle={() => {}}
        m={m}
      />
    );

  assert.ok(render({ completionSnapshot: reply }).includes(mark), "never queued");
  assert.ok(
    render({
      completionSnapshot: reply,
      replyDelivery: { ...delivery, status: "abandoned" },
    }).includes(mark),
    "the queue gave up"
  );
  assert.ok(
    !render({
      completionSnapshot: reply,
      replyDelivery: { ...delivery, status: "delivered" },
    }).includes(mark)
  );
  assert.ok(!render({ completionSnapshot: null }).includes(mark), "nothing was written");
  assert.ok(
    !render({ completionSnapshot: reply, email: null }).includes(mark),
    "no address to answer"
  );
});
