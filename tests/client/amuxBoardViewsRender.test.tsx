import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AmuxBoardAttentionLane, type AttentionLaneCard } from "@/components/admin/AmuxBoardAttentionLane";
import { AmuxBoardPastWork, type PastWorkCard } from "@/components/admin/AmuxBoardPastWork";
import { AmuxCardListPanel } from "@/components/admin/AmuxCardListPanel";
import { AmuxCliUsagePanel } from "@/components/admin/AmuxCliUsagePanel";
import { AdminDisclosureTable } from "@/components/admin/ui/AdminDisclosureTable";
import type { AmuxExecutionListRow } from "@/lib/amux/adminExecutionCardList";

const attentionCard = (n: number, over: Partial<AttentionLaneCard> = {}): AttentionLaneCard => ({
  id: `task-${n}`, title: `Card number ${n}`, displayKey: `AMUX-T-00${n}`, attentionReason: "human_review_required",
  ownerQuestion: null, worker: null, sev1: false, ...over,
});

test("the waiting-on-you column counts four reasons, shows the first five lines and links to the tab", () => {
  const cards = [
    attentionCard(1), attentionCard(2, { attentionReason: "execution_blocked" }),
    attentionCard(3, { ownerQuestion: "open" }), attentionCard(4, { attentionReason: "usage_outcome_unknown" }),
    attentionCard(5), attentionCard(6), attentionCard(7),
  ];
  const html = renderToStaticMarkup(<AmuxBoardAttentionLane cards={cards} countedCards={cards} cardTotal={7}
    decisionMakerTotal={0} decisionMakerRows={[]} canReviewCards onOpen={() => {}} />);
  assert.match(html, /href="\/admin\/amux-execution\?tab=review"/);
  assert.match(html, /Handle in the Waiting on you tab/);
  assert.match(html, /7 cards on one screen/);
  const count = (group: string) => html.match(new RegExp(`data-testid="amux-attention-group-${group}"[^>]*>(\\d+)<`))?.[1];
  assert.deepEqual(["decision", "question", "recovery", "read"].map(count), ["4", "1", "1", "1"]);
  // Five lines, the rest behind a link to the tab.
  assert.equal((html.match(/data-testid="amux-board-card-task-\d"/g) ?? []).length, 5);
  assert.match(html, /\+ 2 more · see in the tab/);
  // A stopped card is red and links to Safety & recovery; the review and question buttons keep their names.
  assert.match(html, /data-testid="amux-board-card-task-2" data-stuck="true"/);
  assert.match(html, /data-testid="amux-card-safety-link-task-2"/);
  assert.match(html, /aria-label="Open owner review"/);
  assert.match(html, /aria-label="Question awaiting answer"/);
});

test("without the owner's access the column offers no review button, and Decision Maker requests come first", () => {
  const cards = [attentionCard(1)];
  const html = renderToStaticMarkup(<AmuxBoardAttentionLane cards={cards} countedCards={cards} cardTotal={1}
    decisionMakerTotal={2} canReviewCards={false} onOpen={() => {}}
    decisionMakerRows={[<li key="a" data-testid="dm-a">A</li>, <li key="b" data-testid="dm-b">B</li>]} />);
  assert.doesNotMatch(html, /amux-card-open-review/);
  assert.ok(html.indexOf("amux-dm-attention-list") < html.indexOf("amux-board-card-task-1"));
  // A Decision Maker request is a decision: 2 here plus the card's own.
  assert.match(html, /data-testid="amux-attention-group-decision"[^>]*>3</);
  assert.match(html, /3 cards on one screen/);
});

test("counts of cards the board has not loaded yet are marked as partial, not shown as the whole", () => {
  const html = renderToStaticMarkup(<AmuxBoardAttentionLane cards={[attentionCard(1)]} countedCards={[attentionCard(1)]}
    cardTotal={14} decisionMakerTotal={0} decisionMakerRows={[]} canReviewCards onOpen={() => {}} />);
  assert.match(html, /data-partial="true">1\+</);
});

const past = (n: number, over: Partial<PastWorkCard> = {}): PastWorkCard => ({
  id: `past-${n}`, title: `Past card ${n}`, displayKey: `AMUX-P-00${n}`, status: "done", archived: false,
  worker: null, updatedAt: "2026-11-07T04:20:00.000Z", ...over,
});

test("past work shows a state chip, the number, the title and an AEST time, and counts only what is loaded", () => {
  const html = renderToStaticMarkup(<AmuxBoardPastWork cards={[past(1), past(2, { status: "blocked" }),
    past(3, { status: "cancelled" }), past(4, { archived: true })]} total={101} loading={false} failed={false}
    protectedTitle="Title unavailable" onOpen={() => {}} onLoadMore={() => {}} onRetry={() => {}} />);
  assert.match(html, /Past work/);
  assert.match(html, /Cards that went to done, blocked, cancelled or the archive: 101/);
  for (const chip of ["Done", "Blocked", "Cancelled", "Archived"]) assert.ok(html.includes(chip), chip);
  assert.match(html, /11-07 14:20/);
  assert.match(html, /title="2026-11-07 14:20 AEST"/);
  assert.doesNotMatch(html, />2026-11-07T04:20/);
  assert.match(html, /4 \/ 101/);
  assert.match(html, /Show 97 more/);
  assert.match(html, /State counts cover the cards loaded so far\. Times are AEST\./);
});

test("a failed past-work read is an alert with a retry, never an empty list", () => {
  const html = renderToStaticMarkup(<AmuxBoardPastWork cards={[]} total={101} loading={false} failed
    protectedTitle="" onOpen={() => {}} onLoadMore={() => {}} onRetry={() => {}} />);
  assert.match(html, /role="alert"/);
  assert.match(html, /Past work could not be read/);
  assert.match(html, /Try again/);
  assert.doesNotMatch(html, /No past work to show/);
});

const listRow = (n: number, over: Partial<AmuxExecutionListRow> = {}): AmuxExecutionListRow => ({
  id: `list-${n}`, displayKey: `AMUX-L-00${n}`, sourceKey: `SRC-${n}`, status: "review", owner: null, kind: "task",
  priority: "p2", revision: 1, briefPresent: true, requiresHumanReview: false, reviewPrNumber: null, attemptCount: 1,
  lastAttemptOutcome: "ok", lastAttemptToStatus: "review", updatedAt: "2026-11-07T04:20:00.000Z",
  title: `Listed card ${n}`, worker: "codex-contract", ...over,
});

test("the card list is a table with the number, title, state chip, worker, priority, runs and an AEST time", () => {
  const html = renderToStaticMarkup(<AmuxCardListPanel rows={[listRow(1), listRow(2, { status: "blocked", worker: null, attemptCount: 0, lastAttemptToStatus: null })]}
    total={145} limit={200} nowMs={Date.parse("2026-11-07T05:20:00.000Z")} onOpen={() => {}} />);
  assert.match(html, /<table/);
  for (const header of ["Card", "State", "Worker", "Priority", "Runs", "Last change \\(AEST\\)"]) assert.match(html, new RegExp(`>${header}<`), header);
  assert.match(html, /AMUX-L-001/);
  assert.match(html, /Listed card 1/);
  assert.match(html, /In review/);
  assert.match(html, /Blocked/);
  assert.match(html, /11-07 14:20/);
  assert.match(html, /P2/);
  assert.match(html, /1 run · sent to review/);
  assert.match(html, /None yet/);
  assert.match(html, /Not assigned yet/);
  // An ISO string and the stored English status never reach the screen; the Task ID, source key and brief are not columns.
  assert.doesNotMatch(html, />2026-11-07T04:20/);
  assert.doesNotMatch(html, />review<|>blocked</);
  assert.doesNotMatch(html, /SRC-1|Source key|>Brief</);
  assert.match(html, /data-testid="amux-card-list-count"/);
  assert.match(html, /Showing 2 of 145 cards, the 200 most recently updated/);
});

test("an empty list says so and keeps its search", () => {
  const html = renderToStaticMarkup(<AmuxCardListPanel rows={[]} total={0} limit={200} nowMs={null} onOpen={() => {}} />);
  assert.match(html, /No cards to show\./);
  assert.match(html, /aria-label="Search cards"/);
});

test("a disclosure table keeps its detail closed until a row is opened, and names the toggle", () => {
  const html = renderToStaticMarkup(<AdminDisclosureTable columns={[{ key: "a", header: "A", render: (row: { id: string }) => row.id }]}
    rows={[{ id: "row-1" }]} rowKey={(row) => row.id} caption="Rows" detail={() => <p>the breakdown</p>}
    expandLabel={(row) => `Open ${row.id}`} collapseLabel={(row) => `Close ${row.id}`} />);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-label="Open row-1"/);
  assert.doesNotMatch(html, /the breakdown/);
});

test("the usage coverage shows four numbers, one row per worker, and never turns an unreported call into zero", () => {
  const row = (worker: string, over: Record<string, unknown> = {}) => ({
    worker, executor: "codex", source: "cli", model: "gpt-6", round: 1, recorded: 512, usageUnknown: 4, noReceiptAttempts: 0,
    unmeasuredRateLowerBound: 0.008, reportedInputTokens: "1000", reportedOutputTokens: "500", reportedCacheReadTokens: "0",
    reportedCacheWriteTokens: "0", cacheWriteReports: 0, knownProjectedApiCostMicrousd: "18400000", pricedCalls: 500, ...over,
  });
  const html = renderToStaticMarkup(<AmuxCliUsagePanel view={{ recorded: 946, unmeasuredLowerBound: 37,
    rows: [row("codex-contract"), row("claude-impl", { recorded: 434, usageUnknown: 0, noReceiptAttempts: 21, pricedCalls: 0, knownProjectedApiCostMicrousd: "0" })] }} />);
  assert.match(html, /data-testid="amux-cli-usage-panel"/);
  assert.match(html, /Recorded calls/);
  assert.match(html, /At least 25/);
  assert.match(html, /US\$ 18\.40/);
  assert.match(html, /codex-contract/);
  assert.match(html, /claude-impl/);
  assert.match(html, /Price unknown/);
  // The model and round breakdown is behind the row, closed.
  assert.doesNotMatch(html, /gpt-6/);
  assert.match(html, /Open a row to see the model and round breakdown/);
});
