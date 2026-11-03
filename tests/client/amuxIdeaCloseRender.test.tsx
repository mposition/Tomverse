import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { AmuxIdeaDetailSummary } from "@/components/admin/AmuxIdeaDetailSummary";
import { AmuxIdeaList } from "@/components/admin/AmuxIdeaProgressPanel";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";
import { amuxIdeaProgress } from "@/lib/amux/ideaProgressCore";
import type { AmuxIdeaProgressRow } from "@/lib/amux/ideaProgressRead";

const router: AppRouterInstance = {
  back: () => {}, forward: () => {}, refresh: () => {}, push: () => {},
  replace: () => {}, prefetch: () => {}, bfcacheId: "amux-idea-close-fixture",
};

const row = (n: number, closable: boolean, state = "awaiting_owner"): AmuxIdeaProgressRow => ({
  ...amuxIdeaProgress({ state, submissionOrigin: "session", cancelled: state === "cancelled",
    chunks: [], proposedUnits: 0, cards: [] }),
  ideaId: `idea-${n}-0000`, submissionOrigin: "session", closable,
  requestId: `${n}1111111-1111-4111-8111-111111111111`,
  submittedAt: "2026-10-30T00:00:00.000Z", displayKey: null,
  reviewPullRequests: [], taskRows: [], checkoutEvidence: [], referencePins: null,
});

const render = (node: React.ReactNode) => renderToStaticMarkup(
  <AppRouterContext.Provider value={router}>{node}</AppRouterContext.Provider>);
const count = (markup: string, needle: string) => markup.split(needle).length - 1;

test("an idea waiting for the owner can be closed from its detail; others cannot", () => {
  const waiting = render(<AmuxIdeaDetailSummary row={row(1, true)} />);
  assert.match(waiting, /data-testid="amux-idea-close"/);
  assert.match(waiting, /data-testid="amux-idea-close-open"/);
  assert.doesNotMatch(waiting, /data-testid="amux-idea-close-form"/,
    "the reason field opens on the first click; the second click confirms");
  assert.match(waiting, /data-testid="amux-session-review"/,
    "the no-plan notice and the close button show together");
  const closed = render(<AmuxIdeaDetailSummary row={row(2, false, "cancelled")} />);
  assert.doesNotMatch(closed, /data-testid="amux-idea-close"/);
});

test("the list offers a checkbox only on closable ideas and one form to close the selection", () => {
  const markup = render(<AmuxIdeaList activeRequestId={null}
    rows={[row(1, true), row(2, false, "cancelled"), row(3, true)]} />);
  assert.equal(count(markup, `data-testid="amux-idea-close-select"`), 2);
  assert.match(markup, /data-testid="amux-idea-close-selected"/);
  // Nothing is ticked yet: the bar invites a selection and keeps the reason field closed.
  const m = markup.includes(adminAmuxIdeaProgressMessages.ko.close.selectionHint)
    ? adminAmuxIdeaProgressMessages.ko : adminAmuxIdeaProgressMessages.en;
  assert.ok(markup.includes(m.close.selectionHint) && markup.includes(m.close.selectAll));
  assert.doesNotMatch(markup, /data-testid="amux-idea-close-form"/);
  const none = render(<AmuxIdeaList activeRequestId={null} rows={[row(2, false, "cancelled")]} />);
  assert.doesNotMatch(none, /amux-idea-close/);
});

test("both Admin locales carry every close message, and the no-plan notice points at closing", () => {
  const { en, ko } = adminAmuxIdeaProgressMessages;
  assert.deepEqual(Object.keys(ko.close).sort(), Object.keys(en.close).sort());
  assert.deepEqual(Object.keys(ko.close.results).sort(), Object.keys(en.close.results).sort());
  assert.ok(en.sessionReviewDetail.includes(en.close.open));
  assert.ok(ko.sessionReviewDetail.includes(ko.close.open));
  assert.equal(/cancel/i.test(en.sessionReviewHint), false);
});
