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
  FeedbackInboxPanel,
  FeedbackListItem,
  feedbackFirstLine,
  resolveSelectedFeedbackId,
  type FeedbackRow,
} from "@/components/admin/FeedbackInboxPanel";
import { adminFeedbackInboxMessages } from "@/lib/adminMessages/feedbackInbox";

/**
 * Support › Inquiries is a list beside one open report. The first render is
 * what these pin; selecting, filtering and focus need a real browser and live
 * in tests/e2e-admin/admin-read-surfaces.spec.ts.
 */

const m = adminFeedbackInboxMessages.en;

const router: AppRouterInstance = {
  back: () => {},
  forward: () => {},
  refresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: () => {},
  bfcacheId: "feedback-list-fixture",
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

const panel = (
  rows: FeedbackRow[],
  search = "",
  props: { canWrite?: boolean; rowLimit?: number } = {}
) =>
  renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/admin/support">
        <SearchParamsContext.Provider value={new URLSearchParams(search)}>
          <FeedbackInboxPanel rows={rows} {...props} />
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );

const html = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);
const count = (markup: string, needle: string) => markup.split(needle).length - 1;

const finished = row({
  id: "report-finished",
  status: "resolved",
  message: "\nExport failed on the long chat.\nThe second line stays out of the list.",
  traceId: "trace-finished",
});

test("every report is one row in the list, and only the open one is read in full", () => {
  const out = panel([row({}), finished, row({ id: "report-closed", status: "closed" })]);

  assert.equal(count(out, 'data-testid="feedback-list-item"'), 3);
  assert.equal(count(out, 'data-testid="feedback-entry"'), 1, "one report in the detail pane");
  assert.equal(count(out, 'aria-current="true"'), 1);

  // The report still waiting on someone is the one open: its body, trace and actions.
  assert.ok(out.includes('data-feedback-id="report-open"'));
  assert.ok(out.includes("trace-1234"));
  assert.equal(count(out, m.copyContext), 1, "only the open report offers its actions");

  // The finished one is its first line and its time, nothing more.
  assert.ok(out.includes("Export failed on the long chat."));
  assert.ok(out.includes("2026-11-05 11:30 AEST"));
  assert.ok(!out.includes("The second line stays out of the list."));
  assert.ok(!out.includes("trace-finished"));
});

test("a search that finds a finished report opens it, so the match can be seen", () => {
  const out = panel([finished, row({})], "q=trace-finished");
  assert.equal(count(out, 'data-testid="feedback-list-item"'), 1);
  assert.ok(out.includes('data-feedback-id="report-finished"'));
  assert.ok(out.includes("trace-finished"));
  assert.ok(out.includes("The second line stays out of the list."));
  assert.ok(out.includes(m.copyContext));
});

test("a link that lands on one report opens it, below the desktop width too", () => {
  const out = panel([row({}), finished], "q=report-finished");
  // The list is hidden below `lg` once a report is open, and the way back says so.
  assert.ok(out.includes("max-lg:hidden"));
  assert.ok(out.includes(m.backToList));
  // Without a link the list is what shows first on a phone.
  const list = panel([row({}), finished]);
  const listTag = list.slice(list.indexOf('data-testid="feedback-list"'));
  assert.ok(!listTag.slice(0, listTag.indexOf(">")).includes("max-lg:hidden"));
});

test("a status filter narrows the list and keeps the counts of the whole read", () => {
  const out = panel([row({}), finished], "status=resolved");
  assert.equal(count(out, 'data-testid="feedback-list-item"'), 1);
  assert.ok(out.includes('aria-pressed="true"'));
  // The counters describe the rows read, not the filter: the open one still counts.
  assert.ok(out.includes(m.openCount(1)));
});

test("the read says how many reports it holds, and an empty read says so", () => {
  const limited = panel([row({})], "", { rowLimit: 20 });
  assert.ok(limited.includes("Showing the 20 most recent reports"));
  const none = panel([]);
  assert.ok(none.includes(m.emptyAll));
  assert.equal(count(none, 'data-testid="feedback-list-item"'), 0);
});

test("a role that cannot write sees the write controls locked and named", () => {
  const out = panel([row({})], "", { canWrite: false });
  assert.ok(out.includes('title="Needs support access"'));
  assert.ok(out.includes("disabled"));
  const writable = panel([row({})]);
  assert.ok(!writable.includes("Needs support access"));
});

test("the technical details stay folded and hold the ids, browser and app version", () => {
  const out = panel([
    row({
      userAgent: "Mozilla/5.0 test",
      traceEvidence: {
        occurrenceId: "occ-1",
        environment: "production",
        release: "2026.11.05",
        routeClass: "chat",
        phase: null,
        errorCode: "AI_TIMEOUT",
        classificationSource: "server",
        httpStatus: 504,
        provider: "openai",
        modelId: "gpt-test",
        sentryEventId: null,
        occurredAt: "2026-11-05T01:29:00.000Z",
      },
    }),
  ]);
  const tech = out.slice(out.indexOf("<details"));
  assert.ok(!tech.slice(0, 20).includes("open"));
  assert.ok(tech.includes(m.meta.userAgent("Mozilla/5.0 test")));
  assert.ok(tech.includes(m.evidenceRow.release("2026.11.05", "production")));
  assert.ok(tech.includes("2026-11-05 11:29 AEST"));
  assert.ok(tech.includes("feedback-trace-evidence"));
});

test("the chosen report stays chosen through a refresh and a filter change", () => {
  const items = [row({ id: "a" }), row({ id: "b", status: "resolved" }), row({ id: "c" })];
  const visible = items.filter((item) => item.status === "open");
  // No choice yet: the first report still waiting on someone.
  assert.equal(resolveSelectedFeedbackId(items, visible, null), "a");
  // A choice beats the default.
  assert.equal(resolveSelectedFeedbackId(items, visible, "c"), "c");
  // Closed reports keep the choice even when the filter now hides them.
  assert.equal(resolveSelectedFeedbackId(items, visible, "b"), "b");
  // Only finished reports are visible: the first of them, not nothing.
  assert.equal(resolveSelectedFeedbackId(items, [items[1]], null), "b");
  // A report that is no longer in the rows falls back to the default.
  assert.equal(resolveSelectedFeedbackId(items, visible, "gone"), "a");
  assert.equal(resolveSelectedFeedbackId([], [], null), null);
});

test("the summary uses the first line that has text in it", () => {
  assert.equal(feedbackFirstLine("one line"), "one line");
  assert.equal(feedbackFirstLine("\r\n   \r\n  second \r\nthird"), "second");
  assert.equal(feedbackFirstLine("  \n "), "");
});

test("a list row is a real button that states whether it is the open one, in both languages", () => {
  const closed = html(<FeedbackListItem feedback={finished} selected={false} onSelect={() => {}} m={m} />);
  assert.match(closed, /^<button type="button"/);
  assert.ok(!closed.includes("aria-current"));
  assert.ok(closed.includes(m.statuses.resolved));

  const chosen = html(<FeedbackListItem feedback={finished} selected onSelect={() => {}} m={m} />);
  assert.ok(chosen.includes('aria-current="true"'));

  const ko = adminFeedbackInboxMessages.ko;
  const korean = html(<FeedbackListItem feedback={finished} selected={false} onSelect={() => {}} m={ko} />);
  assert.ok(korean.includes(ko.statuses.resolved));
  const guest = html(
    <FeedbackListItem feedback={row({ email: null })} selected={false} onSelect={() => {}} m={ko} />
  );
  assert.ok(guest.includes(ko.guest));
});

test("a row names a reply that never reached the reporter, and nothing else", () => {
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
    html(
      <FeedbackListItem
        feedback={row({ status: "resolved", ...overrides })}
        selected={false}
        onSelect={() => {}}
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

test("an undelivered reply opens with its resend offer and the text that will be sent", () => {
  const out = panel([
    row({
      status: "resolved",
      completionSnapshot: { outcomeCode: "fixed", userReply: "It is fixed now." },
      userReply: "A later, different reply.",
    }),
  ]);
  assert.ok(out.includes('data-testid="feedback-reply-resend"'));
  const preview = out.slice(out.indexOf("feedback-reply-resend-preview"));
  assert.ok(preview.includes("It is fixed now."));
  assert.ok(!preview.includes("A later, different reply."));
});
