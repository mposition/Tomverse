import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { AmuxIdeaDetailSummary } from "@/components/admin/AmuxIdeaDetailSummary";
import { AmuxIdeaInbox, AmuxIdeaList } from "@/components/admin/AmuxIdeaProgressPanel";
import { amuxIdeaProgress } from "@/lib/amux/ideaProgressCore";
import type { AmuxIdeaProgressRow } from "@/lib/amux/ideaProgressRead";

const router: AppRouterInstance = {
  back: () => {}, forward: () => {}, refresh: () => {}, push: () => {},
  replace: () => {}, prefetch: () => {}, bfcacheId: "amux-idea-title-fixture",
};

const row = (fields: Partial<AmuxIdeaProgressRow>): AmuxIdeaProgressRow => ({
  ...amuxIdeaProgress({ state: "awaiting_owner", submissionOrigin: "session", cancelled: false,
    chunks: [], proposedUnits: 0, cards: [] }),
  ideaId: "idea-1", submissionOrigin: "session", closable: true,
  requestId: "4ed13f4c-1111-4111-8111-111111111111",
  submittedAt: "2026-11-04T00:00:00.000Z", displayKey: null,
  reviewPullRequests: [], taskRows: [], checkoutEvidence: [], referencePins: null,
  ...fields,
});

const render = (node: React.ReactNode) => renderToStaticMarkup(
  <AppRouterContext.Provider value={router}>{node}</AppRouterContext.Provider>);
const heading = (markup: string) =>
  /<h2 id="amux-idea-detail-heading"[^>]*>(.*?)<\/h2>/.exec(markup)?.[1] ?? "";
const shortId = /<span class="[^"]*" data-testid="amux-idea-short-id">4ed13f4c<\/span>/;

test("a titled idea shows its title large and the short id small, in list and detail", () => {
  const titled = row({ title: "가격 표가 모바일에서 잘립니다" });
  const detail = heading(render(<AmuxIdeaDetailSummary row={titled} />));
  assert.ok(detail.startsWith("가격 표가 모바일에서 잘립니다"));
  assert.match(detail, shortId);
  const list = render(<AmuxIdeaList activeRequestId={null} rows={[titled]} />);
  assert.ok(list.includes("가격 표가 모바일에서 잘립니다"));
  assert.match(list, shortId);
  // The close checkbox names the idea in one string.
  assert.ok(list.includes("가격 표가 모바일에서 잘립니다 (4ed13f4c)"));
});

test("a card display key wins over the title, and no title falls back to the short id", () => {
  const keyed = heading(render(<AmuxIdeaDetailSummary row={row({ displayKey: "AMUX-77", title: "Ignored" })} />));
  assert.equal(keyed, "AMUX-77");
  const bare = heading(render(<AmuxIdeaDetailSummary row={row({ title: null })} />));
  assert.match(bare, /^(Idea|아이디어) 4ed13f4c$/);
  assert.doesNotMatch(bare, /amux-idea-short-id/);
});

test("a lane PR waiting for review is named by the idea's title", () => {
  const markup = render(<AmuxIdeaInbox rows={[row({ title: "Lane title", closable: false,
    reviewPullRequests: [{ number: 3300, displayKey: null }] })]} />);
  assert.match(markup, /PR #3300 · Lane title <span[^>]*data-testid="amux-idea-short-id">4ed13f4c<\/span>/);
  const keyed = render(<AmuxIdeaInbox rows={[row({ title: "Lane title", closable: false,
    reviewPullRequests: [{ number: 3301, displayKey: "AMUX-9" }] })]} />);
  assert.match(keyed, /PR #3301 · AMUX-9/);
});
