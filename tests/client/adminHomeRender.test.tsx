import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminWorkQueuePanel } from "@/components/admin/AdminWorkQueuePanel";
import { AdminFunnel } from "@/components/admin/ui/AdminFunnel";
import { AdminHeatmap } from "@/components/admin/ui/AdminHeatmap";
import { AdminLineChart } from "@/components/admin/ui/AdminLineChart";
import { AdminProviderMark } from "@/components/admin/ui/AdminProviderMark";
import { AdminSegmentedLinks } from "@/components/admin/ui/AdminSegmentedLinks";
import { AdminShareList } from "@/components/admin/ui/AdminShareList";
import { buildDecisionInbox } from "@/lib/adminDecisionInbox";
import { EMPTY_ADMIN_NAVIGATION_COUNTS } from "@/lib/adminNavigationBadges";

const now = new Date("2026-11-07T04:00:00.000Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

const inbox = buildDecisionInbox({
  queue: {
    items: [
      {
        id: "refund:1",
        category: "Refund",
        severity: "high",
        title: "Refund request from user04@example.com",
        detail: "Pro · no reason given",
        href: "/admin/refunds",
        openedAt: hoursAgo(30),
      },
      {
        id: "feedback:1",
        category: "Feedback",
        severity: "normal",
        title: "Image results look wrong",
        detail: "bug · no email supplied",
        href: "/admin/support?tab=feedback",
        openedAt: hoursAgo(3),
      },
    ],
    truncatedCategories: [],
    failedCategories: [],
  },
  counts: { ...EMPTY_ADMIN_NAVIGATION_COUNTS, pendingMarketingApprovals: 4 },
  role: "owner",
  now,
});

const panel = (props: Partial<Parameters<typeof AdminWorkQueuePanel>[0]> = {}) =>
  renderToStaticMarkup(
    <AdminWorkQueuePanel inbox={inbox} area={null} notices={[]} truncatedNotice={null} {...props} />
  );

test("the inbox groups waits and says what each line is in words, with the owner's link", () => {
  const html = panel();
  assert.match(html, /Waiting a long time/);
  assert.match(html, /Came in today/);
  assert.match(html, /No start time recorded/);
  assert.match(html, /Refund request/);
  assert.match(html, /4 marketing posts waiting for approval/);
  // The first item is open on the desktop pane, with a link to the screen that decides.
  assert.match(html, /href="\/admin\/refunds"/);
  assert.match(html, /Handle it on Refunds/);
  // Technical detail is folded, not open.
  assert.doesNotMatch(html, /<details[^>]*open/);
});

test("an area tab shows the same list through a filter", () => {
  const html = panel({ area: "agents" });
  assert.match(html, /4 marketing posts waiting for approval/);
  assert.doesNotMatch(html, /Refund request/);
});

test("an empty area says nothing is waiting, but an unread source is a notice and not a clear list", () => {
  const empty = panel({ area: "system" });
  assert.match(empty, /Nothing is waiting here/);
  const unread = panel({ area: "system", notices: ["Alerts could not be counted."] });
  assert.match(unread, /role="alert"/);
  assert.doesNotMatch(unread, /Nothing is waiting here/);
});

test("the inbox holds no write: it links to the owning screen and has no form or confirm", () => {
  const html = panel();
  assert.doesNotMatch(html, /<form/);
  assert.doesNotMatch(html, /role="dialog"/);
});

test("the heatmap, line chart and funnel draw nothing they cannot read", () => {
  assert.equal(
    renderToStaticMarkup(
      <AdminHeatmap matrix={[[0, 0], [0, 0]]} rowLabels={["a", "b"]} cellLabel={() => "x"} label="x" />
    ),
    ""
  );
  assert.equal(renderToStaticMarkup(<AdminLineChart values={[1]} label="x" />), "");
});

test("the heatmap labels every cell for screen readers and scales opacity to the busiest", () => {
  const html = renderToStaticMarkup(
    <AdminHeatmap
      matrix={[[0, 5], [10, 1]]}
      rowLabels={["Mon", "Tue"]}
      cellLabel={(row, column, value) => `r${row}c${column}:${value}`}
      label="Requests"
      columnLabelEvery={1}
    />
  );
  assert.match(html, /aria-label="r1c0:10"/);
  assert.match(html, /role="table" aria-label="Requests"/);
  assert.match(html, /opacity:1/);
});

test("the line chart can carry a dashed comparison and says what it shows", () => {
  const html = renderToStaticMarkup(
    <AdminLineChart values={[1, 2, 3]} previous={[3, 2, 1]} labels={["a", "b"]} label="Active accounts" />
  );
  assert.match(html, /role="img" aria-label="Active accounts"/);
  assert.match(html, /stroke-dasharray="5 5"/);
});

test("the funnel shows a hairline for an empty step and no rate after a zero", () => {
  const html = renderToStaticMarkup(
    <AdminFunnel
      rateLabel={(rate) => `${Math.round(rate * 100)}%`}
      steps={[
        { key: "a", label: "Visited", value: 100, valueLabel: "100" },
        { key: "b", label: "Signed up", value: 0, valueLabel: "0" },
        { key: "c", label: "Paid", value: 0, valueLabel: "0" },
      ]}
    />
  );
  assert.match(html, />0%</);
  // The step after a zero has nothing to be a rate of.
  assert.equal(html.match(/%</g)?.length, 1);
  assert.match(html, /height:6px/);
});

test("the period picker is made of links and marks the current one", () => {
  const html = renderToStaticMarkup(
    <AdminSegmentedLinks
      label="Report period"
      items={[
        { id: "today", label: "Today", href: "/admin/analytics?tab=usage&period=today", active: true },
        { id: "last7", label: "Last 7 days", href: "/admin/analytics?tab=usage&period=last7", active: false },
      ]}
    />
  );
  assert.match(html, /<a [^>]*aria-current="page"[^>]*>Today<\/a>/);
  assert.match(html, /period=last7/);
});

test("share rows scale to the largest row and keep a sliver for a tiny non-zero one", () => {
  const html = renderToStaticMarkup(
    <AdminShareList
      rows={[
        { key: "a", label: "OpenAI", value: 100, valueLabel: "$9.80" },
        { key: "b", label: "Perplexity", value: 1, valueLabel: "$0.10" },
        { key: "c", label: "None", value: 0, valueLabel: "$0.00" },
      ]}
    />
  );
  assert.match(html, /width:100%/);
  assert.match(html, /width:2%/);
  assert.match(html, /width:0%/);
});

test("a provider shows its logo, or its letter mark when it has none", () => {
  assert.match(renderToStaticMarkup(<AdminProviderMark provider="openai" />), /model-icons\/chatgpt\.png/);
  assert.match(renderToStaticMarkup(<AdminProviderMark provider="minimax" />), />MM</);
});
