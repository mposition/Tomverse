import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { AmuxIdeaDetailSummary } from "@/components/admin/AmuxIdeaDetailSummary";
import { AmuxIdeaInbox, AmuxIdeaList } from "@/components/admin/AmuxIdeaProgressPanel";
import { AmuxIdeaRequestStatusCard } from "@/components/admin/AmuxIdeaRequestStatusCard";
import { AmuxInitialPlanPanel } from "@/components/admin/AmuxInitialPlanPanel";
import { adminAmuxIdeaInputMessages } from "@/lib/adminMessages/amuxIdeaInput";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";
import { amuxIdeaProgress, type AmuxIdeaProgressFacts } from "@/lib/amux/ideaProgressCore";
import type { AmuxIdeaProgressRow } from "@/lib/amux/ideaProgressRead";

const router: AppRouterInstance = {
  back: () => {}, forward: () => {}, refresh: () => {}, push: () => {},
  replace: () => {}, prefetch: () => {}, bfcacheId: "amux-idea-status-fixture",
};
const render = (node: ReactNode) => renderToStaticMarkup(
  <AppRouterContext.Provider value={router}>{node}</AppRouterContext.Provider>);
const task = (status: string, overrides: Partial<AmuxIdeaProgressFacts["cards"][number]> = {}) =>
  ({ cardType: "task", status, reviewPrNumber: null, merged: false, ...overrides });
const row = (facts: Partial<AmuxIdeaProgressFacts>,
  overrides: Partial<AmuxIdeaProgressRow> = {}): AmuxIdeaProgressRow => ({
  ...amuxIdeaProgress({ state: "submitted", cancelled: false, chunks: [], proposedUnits: 0, cards: [], ...facts }),
  ideaId: "idea-status-1", submissionOrigin: "owner", closable: false,
  requestId: "cfa39925-f53e-4d19-9eb7-3b8ec2e94f68", submittedAt: "2026-11-05T00:00:00.000Z",
  displayKey: null, reviewPullRequests: [], taskRows: [], checkoutEvidence: [], referencePins: null,
  ...overrides,
});
const taskRow = (displayKey: string, status: string, overrides: Partial<AmuxIdeaProgressRow["taskRows"][number]> = {}) =>
  ({ id: `task-${displayKey}`, displayKey, status, reviewPrNumber: null, merged: false,
    blockReason: null, escalationId: null, ...overrides });
const localeOf = (markup: string) => markup.includes(adminAmuxIdeaProgressMessages.ko.notice.execution_blocked.title)
  || markup.includes(adminAmuxIdeaProgressMessages.ko.stages.execution)
  ? adminAmuxIdeaProgressMessages.ko : adminAmuxIdeaProgressMessages.en;

// AMUX-CONTSEED-001: AMUX-CONTSEED-002 blocked, 003 to 006 in backlog, no PR, nothing running.
const contseed = () => row({ state: "completed", chunks: [{ chunkIndex: 0, state: "decided",
  coverageStatus: "complete", previewState: "completed", holdStatus: "succeeded" }],
cards: [task("blocked"), task("backlog"), task("backlog"), task("backlog"), task("backlog")] }, {
  displayKey: "AMUX-CONTSEED-001",
  taskRows: [taskRow("AMUX-CONTSEED-002", "blocked", { blockReason: "execution_lease_expired",
    escalationId: "cm0000000000000000000abcd" }),
  taskRow("AMUX-CONTSEED-003", "backlog"), taskRow("AMUX-CONTSEED-004", "backlog"),
  taskRow("AMUX-CONTSEED-005", "backlog"), taskRow("AMUX-CONTSEED-006", "backlog")],
});

test("case 1: a blocked idea says so, why, and links to what the owner can do", () => {
  const markup = render(<AmuxIdeaDetailSummary row={contseed()} />);
  const m = localeOf(markup);
  assert.match(markup, /data-activity="blocked"/);
  assert.ok(markup.includes(m.activity.blocked), "the step reads blocked");
  assert.ok(markup.includes(m.notice.execution_blocked.title));
  assert.ok(markup.includes(m.notice.execution_blocked.body), "it says the idea cannot be closed here but a card-close question may come");
  assert.ok(markup.includes(m.blockReasons.execution_lease_expired), "the Task's reason is shown");
  assert.ok(markup.includes("/admin/amux-execution?tab=review&amp;focusEscalation=cm0000000000000000000abcd"),
    "the open review is one click away");
  assert.ok(markup.includes("/admin/amux-execution?tab=cards&amp;taskId=task-AMUX-CONTSEED-002"));
  assert.doesNotMatch(markup, /data-testid="amux-idea-close"/, "closing is not offered, as the close route refuses it");
  const steps = markup.slice(markup.indexOf("<ol"), markup.indexOf("</ol>"));
  assert.equal(steps.includes(`${m.stages.execution}</span><span class="block text-xs text-zinc-400">${m.automatic}`), false,
    "the current step no longer claims to run on its own");
});

test("a blocked Task with no open review and no known reason says exactly that", () => {
  const markup = render(<AmuxIdeaDetailSummary row={row({ cards: [task("blocked")] },
    { taskRows: [taskRow("AMUX-X-001", "blocked")] })} />);
  const m = localeOf(markup);
  assert.ok(markup.includes(m.blockReasonUnknown));
  assert.ok(markup.includes(m.blockedNoReview));
  assert.doesNotMatch(markup, /focusEscalation/);
  assert.ok(markup.includes("/admin/amux-recovery?tab=safety"), "the recovery screen is the place left to look");
});

test("an idea whose Tasks all wait is not called running", () => {
  const markup = render(<AmuxIdeaDetailSummary row={row({ cards: [task("backlog"), task("todo")] },
    { taskRows: [taskRow("AMUX-W-001", "backlog"), taskRow("AMUX-W-002", "todo")] })} />);
  const m = localeOf(markup);
  assert.match(markup, /data-activity="waiting"/);
  assert.ok(markup.includes(m.activity.waiting));
  assert.ok(markup.includes(m.notice.execution_waiting.body));
  assert.ok(markup.includes("/admin/amux-execution?tab=cards"));
  assert.doesNotMatch(markup, /amux-idea-blocked-tasks/);
});

test("a doing Task reads as running, and a person has nothing to do", () => {
  const markup = render(<AmuxIdeaDetailSummary row={row({ cards: [task("doing"), task("backlog")] },
    { taskRows: [taskRow("AMUX-R-001", "doing"), taskRow("AMUX-R-002", "backlog")] })} />);
  const m = localeOf(markup);
  assert.match(markup, /data-activity="running"/);
  assert.ok(markup.includes(m.activity.running));
  assert.ok(markup.includes(m.notice.execution_running.body));
});

test("case 2: an approved idea waiting for its analysis says it waits, and does not ask for an approval again", () => {
  const detail = render(<AmuxIdeaDetailSummary row={row({ state: "submitted", chunks: [{ chunkIndex: 0,
    state: "awaiting_preview", coverageStatus: null, previewState: "confirmed", holdStatus: "reserved" }] })} />);
  const m = localeOf(detail);
  assert.match(detail, /data-stage="analysis"/);
  assert.match(detail, /data-activity="waiting"/);
  assert.ok(detail.includes(m.notice.analysis_waiting.body));
  assert.ok(!detail.includes("tab=recovery"), "the retired Cleanup and recovery section is not linked");
  assert.match(detail, /data-testid="amux-reservation-release"/, "the unused reservation is released right here");
  const ready = render(<AmuxIdeaDetailSummary reservationReleaseAvailable row={row({ state: "submitted",
    chunks: [{ chunkIndex: 0, state: "awaiting_preview", coverageStatus: null, previewState: "confirmed",
      holdStatus: "reserved" }] })} />);
  assert.match(ready, /data-testid="amux-reservation-release" data-phase="checking"/);
  const running = render(<AmuxIdeaDetailSummary reservationReleaseAvailable row={row({ state: "analyzing",
    chunks: [{ chunkIndex: 0, state: "in_flight", coverageStatus: null, previewState: "in_flight",
      holdStatus: "in_flight" }] })} />);
  assert.doesNotMatch(running, /amux-reservation-release/, "a running analysis offers no release");

  const input = adminAmuxIdeaInputMessages;
  const card = render(<AmuxIdeaRequestStatusCard state={{ kind: "saved", requestId: "cfa39925-f53e-4d19-9eb7-3b8ec2e94f68",
    ideaId: "idea-status-1", progressAbove: true }} />);
  assert.equal(card.includes(input.ko.statusSavedBody) || card.includes(input.en.statusSavedBody), false,
    "the saved card no longer says the next step is the execution approval");
  assert.ok(card.includes(input.ko.statusSavedProgressAbove) || card.includes(input.en.statusSavedProgressAbove));
  const waiting = render(<AmuxIdeaRequestStatusCard state={{ kind: "saved", requestId: "cfa39925-f53e-4d19-9eb7-3b8ec2e94f68",
    ideaId: "idea-status-1" }} />);
  assert.ok(waiting.includes(input.ko.statusSavedBody) || waiting.includes(input.en.statusSavedBody),
    "an idea really waiting for its approval still says so");
  const session = render(<AmuxIdeaRequestStatusCard state={{ kind: "saved", requestId: "cfa39925-f53e-4d19-9eb7-3b8ec2e94f68",
    ideaId: "idea-status-1", session: true }} />);
  assert.equal(session.includes(input.ko.statusSavedBody) || session.includes(input.en.statusSavedBody), false,
    "a session idea has no execution approval");
  assert.ok(session.includes(input.ko.sessionQueued) || session.includes(input.en.sessionQueued.replaceAll("'", "&#x27;")));
});

test("case 2: each flow panel has one distinct key, so React never leaves a stale copy on the page", () => {
  // Two siblings sharing a key make React drop one from its bookkeeping on every parent render: the
  // old plan panel stays in the page with its state frozen (button disabled, no reason) beside a new one.
  const source = readFileSync("components/admin/AmuxIdeaInputPanel.tsx", "utf8");
  const keys = [...source.matchAll(/<(AmuxInitialPlanPanel|AmuxIdeaAnalysisResultPanel)\s+key=\{([^}]+(?:\}[^}\s]*\}?`?)?)\}/g)]
    .map((match) => match[2]);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  assert.ok(source.includes("approvalClosed"), "the v4 approval steps follow the idea's real stage");
});

test("the plan button says why it cannot be pressed yet", () => {
  const markup = render(createElement(AmuxInitialPlanPanel, { ideaId: "cfa39925-f53e-4d19-9eb7-3b8ec2e94f68",
    operatorId: "owner-1", available: true, declaredExternalSources: false }));
  assert.match(markup, /<button[^>]*disabled/, "the first read has not answered");
  const input = adminAmuxIdeaInputMessages;
  assert.ok(markup.includes(input.ko.initialPlanChecking) || markup.includes(input.en.initialPlanChecking));
});

test("the list and the inbox tell a blocked idea apart from a running one", () => {
  const blocked = contseed();
  const list = render(<AmuxIdeaList rows={[blocked]} activeRequestId={null} />);
  const m = localeOf(list);
  assert.ok(list.includes(m.activity.blocked));
  assert.equal(list.includes(m.automatic), false);
  const inbox = render(<AmuxIdeaInbox rows={[blocked]} />);
  assert.ok(inbox.includes(m.executionBlocked), "a blocked idea waits on a person");
  assert.equal(inbox.includes(m.inboxEmpty), false);
  const running = render(<AmuxIdeaInbox rows={[row({ cards: [task("doing")] })]} />);
  assert.ok(running.includes(m.inboxEmpty));
});

test("both Admin locales carry every status message", () => {
  const { en, ko } = adminAmuxIdeaProgressMessages;
  assert.deepEqual(Object.keys(ko.notice).sort(), Object.keys(en.notice).sort());
  assert.deepEqual(Object.keys(ko.activity).sort(), Object.keys(en.activity).sort());
  assert.deepEqual(Object.keys(ko.blockReasons).sort(), Object.keys(en.blockReasons).sort());
  assert.deepEqual(Object.keys(ko.taskStatuses).sort(), Object.keys(en.taskStatuses).sort());
});
