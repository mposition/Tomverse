import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AdminMarketingPanel, type MarketingConsoleView } from "@/components/admin/AdminMarketingPanel";
import { MarketingAgentOverview } from "@/components/admin/MarketingAgentOverview";
import { MarketingApprovalCard, type MarketingCardFormat } from "@/components/admin/MarketingApprovalCard";
import { adminMarketingAgentMessages } from "@/lib/adminMessages/marketingAgent";
import { marketingWeekPosts, type MarketingAgentOverview as AgentData } from "@/lib/marketingAgentOverviewCore";
import type { MarketingConsoleOverview } from "@/lib/marketingConsoleOverview";

/**
 * The Marketing agent's redesigned screens (admin redesign, step 6), rendered:
 * the head on every tab, the Overview's reads and what it says when one failed,
 * the approval card, and which tab holds the webhook blocks.
 */
const en = adminMarketingAgentMessages.en;

const format: MarketingCardFormat = {
  relative: () => "3 hours ago",
  stamp: (iso) => (typeof iso === "string" ? "2026-11-07 17:00 AEST" : null),
  channelName: (channel) => String(channel),
  guardWord: () => "passed",
  guardTone: () => "success",
};

const row = {
  id: "post-1",
  status: "pending_approval",
  channel: "instagram",
  accountSlug: "tomverse-main",
  locale: "ko",
  guardDecision: "pass",
  guardCodes: ["G-100"],
  claimCount: 2,
  assetIds: [],
  renderedText: "Compare three models\nin one go",
  approvalExpiresAt: null,
  createdAt: "2026-11-07T04:00:00.000Z",
};

test("posts are counted per Brisbane day, and the seven days before are kept apart", () => {
  const now = new Date("2026-11-07T12:00:00.000Z"); // 22:00 on 7 November in Brisbane
  const at = (iso: string) => new Date(iso);
  const week = marketingWeekPosts(
    [
      at("2026-11-07T00:30:00.000Z"), // 10:30 on the 7th
      at("2026-11-06T15:00:00.000Z"), // 01:00 on the 7th: after Brisbane midnight, still the 7th
      at("2026-11-07T11:00:00.000Z"),
      at("2026-11-06T13:59:00.000Z"), // 23:59 on the 6th
      at("2026-10-30T02:00:00.000Z"), // eight days back: the earlier week
      at("2026-10-01T02:00:00.000Z"), // far too old to count
    ],
    now,
  );
  assert.equal(week.days.length, 7);
  assert.equal(week.days[6].date, "2026-11-07");
  assert.equal(week.days[6].count, 3);
  assert.equal(week.days[5].date, "2026-11-06");
  assert.equal(week.days[5].count, 1);
  assert.equal(week.total, 4);
  assert.equal(week.previousTotal, 1);
});

test("the full approval card shows the words once, the checks that were made and the row's own controls", () => {
  const html = renderToStaticMarkup(
    <MarketingApprovalCard row={row} variant="full" format={format} rail={<button data-testid="rail">controls</button>} />,
  );
  assert.match(html, /data-testid="marketing-row"/);
  assert.equal((html.match(/data-testid="marketing-queue-text"/g) ?? []).length, 1);
  assert.match(html, /Compare three models\nin one go/);
  assert.match(html, /Guard: passed/);
  assert.match(html, /Guard codes: G-100/);
  assert.match(html, /2 cited facts/);
  // A draft with no file says so rather than reading as words only.
  assert.match(html, /No file attached/);
  assert.match(html, /Approval has no expiry yet/);
  assert.match(html, /data-testid="rail"/);
});

test("the compact card is the Overview's: the picture, a few lines and the controls, no check list", () => {
  const html = renderToStaticMarkup(
    <MarketingApprovalCard row={row} variant="compact" format={format} rail={<button data-testid="rail">controls</button>} />,
  );
  assert.match(html, /data-testid="marketing-pending-card"/);
  assert.match(html, /data-testid="marketing-post-thumb"/);
  assert.doesNotMatch(html, /Automatic checks/);
  assert.match(html, /data-testid="rail"/);
});

const overview = (patch: Partial<MarketingConsoleOverview> = {}): MarketingConsoleOverview => ({
  readAt: "2026-11-07T08:00:00.000Z",
  environment: "production",
  pending: { count: 1, oldestAt: "2026-11-07T04:00:00.000Z" },
  llm: { calls: 12, countedMicroUsd: 4_100_000, tokenMicroUsd: 3_900_000 },
  lastRun: { at: "2026-11-07T01:20:00.000Z", calls: 4, reportAt: null, factsKept: 3, factsDropped: 0 },
  accounts: { total: 2, byStatus: { approval_mode: 2 } },
  competitors: { approved: 3 },
  ...patch,
});

const agent = (patch: Partial<AgentData> = {}): AgentData => ({
  week: {
    days: ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"].map(
      (date, index) => ({ date, count: index }),
    ),
    total: 21,
    previousTotal: 16,
  },
  scheduled: [
    {
      id: "s1",
      channel: "x",
      accountSlug: "tomverse-main",
      locale: "en",
      scheduledAt: "2026-11-07T07:00:00.000Z",
      excerpt: "One prompt, three answers",
    },
  ],
  runs: [
    { id: "run-a", at: "2026-11-07T01:20:00.000Z", calls: 4, countedMicroUsd: 310_000, unsettled: 0 },
    { id: "run-b", at: "2026-11-06T22:00:00.000Z", calls: 3, countedMicroUsd: 280_000, unsettled: 1 },
  ],
  ...patch,
});

const renderOverview = (
  o: MarketingConsoleOverview,
  a: AgentData,
  options: { cap?: string | null; cards?: React.ReactNode[] | null } = {},
) =>
  renderToStaticMarkup(
    <MarketingAgentOverview
      overview={o}
      agent={a}
      monthlyCapUsd={options.cap === undefined ? "20" : options.cap}
      model="gpt-6-luna"
      pendingCards={options.cards === undefined ? [<div key="c" data-testid="card" />] : options.cards}
      format={format}
    />,
  );

test("the Overview draws the week, the schedule, the cost ring and the recent runs it read", () => {
  const html = renderOverview(overview(), agent());
  assert.match(html, /data-testid="card"/);
  assert.match(html, /data-testid="marketing-week-posts"/);
  assert.match(html, /\+5 on the 7 days before/);
  assert.match(html, /<svg[^>]*role="img"[^>]*aria-label="Posts written, last 7 days"/);
  assert.match(html, /One prompt, three answers/);
  assert.match(html, /21%/);
  assert.match(html, /US\$ 4\.10/);
  assert.match(html, /Monthly limit US\$ 20\.00/);
  assert.match(html, /3 calls/);
  // A run with a call that never closed says so; its money may have been spent.
  assert.match(html, /Some calls are not closed/);
  // Ids and the model are folded away, not on the page.
  assert.match(html, /<details/);
});

test("a read that failed is said so and never drawn as nothing", () => {
  const html = renderOverview(overview({ pending: null, llm: null }), agent({ week: null, scheduled: null, runs: null }), {
    cards: null,
  });
  assert.match(html, new RegExp(en.waitingUnread));
  assert.match(html, new RegExp(en.weekNone));
  assert.match(html, new RegExp(en.scheduledUnread));
  assert.match(html, new RegExp(en.costUnread));
  assert.match(html, new RegExp(en.runsUnread));
  assert.doesNotMatch(html, new RegExp(en.waitingNone));
  assert.doesNotMatch(html, new RegExp(en.scheduledNone));
  assert.doesNotMatch(html, new RegExp(en.runsNone));
  assert.doesNotMatch(html, /data-testid="marketing-scheduled-list"/);
});

test("nothing waiting, scheduled or run reads as nothing; no monthly limit draws no ring", () => {
  const html = renderOverview(overview(), agent({ scheduled: [], runs: [] }), { cards: [], cap: null });
  assert.match(html, new RegExp(en.waitingNone));
  assert.match(html, new RegExp(en.scheduledNone));
  assert.match(html, new RegExp(en.runsNone));
  assert.match(html, new RegExp(en.costNoCap));
  assert.doesNotMatch(html, /\d+%/);
});

const view = (patch: Partial<MarketingConsoleView> = {}): MarketingConsoleView => ({
  section: "queue",
  availability: { available: true },
  ordering: "newest",
  pageSize: 20,
  rows: [{ ...row, provider: "zernio", envelopeDigest: "d", historyVersion: 1, legalHold: false }],
  switches: { drafts: "on", publish: "off", autoPublish: "off", experiments: "off", webhookShadow: "off", applyScope: "no-scope" },
  canWrite: true,
  configGeneration: 1,
  llm: { settings: { model: "gpt-6-luna", monthlyUsdCap: "20" }, version: "v1", models: [] },
  overview: overview(),
  webhookStaging: null,
  ...patch,
});

test("every tab opens under the agent's head, with the switch as a reading that links to Settings", () => {
  const html = renderToStaticMarkup(<AdminMarketingPanel initial={view()} part="section" />);
  assert.match(html, /data-testid="agent-header"[^>]*data-team="marketing"/);
  assert.match(html, /data-testid="agent-auto-run"[^>]*data-state="on"/);
  assert.match(html, /href="\/admin\/marketing\?tab=settings"/);
  // Drafting off is "off", and an unreadable switch is "unknown", never "off".
  const off = renderToStaticMarkup(<AdminMarketingPanel initial={view({ switches: { ...view().switches, drafts: "off" } })} part="section" />);
  assert.match(off, /data-state="off"/);
  const unread = renderToStaticMarkup(<AdminMarketingPanel initial={view({ switches: { ...view().switches, drafts: "unreadable" } })} part="section" />);
  assert.match(unread, /data-state="unknown"/);
  // No run-now button on the page: nothing here starts the generator.
  assert.doesNotMatch(html, /Run now|지금 실행/);
});

test("the approval tab keeps the row's controls: fix the words, reject, then approve", () => {
  const html = renderToStaticMarkup(<AdminMarketingPanel initial={view()} part="section" />);
  assert.match(html, /data-testid="marketing-row"/);
  assert.match(html, /data-testid="marketing-queue-text"/);
  const at = (id: string) => html.indexOf(`data-testid="marketing-action-${id}"`);
  assert.ok(at("edit") > 0 && at("reject") > at("edit") && at("approve") > at("reject"));
  // A reader who may not write is offered none of them.
  const reader = renderToStaticMarkup(<AdminMarketingPanel initial={view({ canWrite: false })} part="section" />);
  assert.doesNotMatch(reader, /marketing-action-approve/);
  assert.match(reader, /data-testid="marketing-queue-text"/);
});

test("the Overview waits on people with the approve and reject controls, and holds no webhook block", () => {
  const html = renderToStaticMarkup(<AdminMarketingPanel initial={view()} part="overview" agent={agent()} />);
  assert.match(html, /data-testid="marketing-pending-card"/);
  assert.match(html, /data-testid="marketing-action-approve"/);
  assert.match(html, /data-testid="marketing-action-reject"/);
  assert.doesNotMatch(html, /marketing-action-edit/);
  assert.doesNotMatch(html, /marketing-webhook-card|marketing-switches/);
});

test("the webhook blocks and the switch strip live on the Settings tab alone", () => {
  const settings = renderToStaticMarkup(<AdminMarketingPanel initial={view()} part="settings" />);
  assert.match(settings, /data-testid="marketing-webhook-card"/);
  assert.match(settings, /data-testid="marketing-switches"/);
  for (const part of ["overview", "section"] as const) {
    const html = renderToStaticMarkup(<AdminMarketingPanel initial={view()} part={part} agent={agent()} />);
    assert.doesNotMatch(html, /marketing-webhook-card/, part);
    assert.doesNotMatch(html, /marketing-webhook-staging|marketing-webhook-verification-sign/, part);
  }
});

test("both languages carry every new key", () => {
  assert.deepEqual(Object.keys(adminMarketingAgentMessages.ko).sort(), Object.keys(en).sort());
});
