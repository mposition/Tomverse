import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminAgentTeamBoard } from "@/components/admin/AdminAgentTeamBoard";
import { AdminAgentHeader } from "@/components/admin/ui/AdminAgentHeader";
import type { AgentOfficeLiveRooms } from "@/lib/agentOffice/live";

const unread = { kind: "unread" } as const;

const rooms: AgentOfficeLiveRooms = {
  readAt: "2026-11-07T01:00:00.000Z",
  review: unread,
  decision: unread,
  digest: unread,
  queue: { marketing: 3, amuxEscalations: 0, amuxHalts: 0 },
  research: { kind: "disabled" },
  qa: unread,
  finance: unread,
  routing: {
    kind: "observed",
    last: null,
    spentTodayMicroUsd: 0,
    spentMonthMicroUsd: 2_500_000,
    dayCapMicroUsd: 1_000_000,
    monthCapMicroUsd: 10_000_000,
    lastPromotedAt: null,
  },
  sre: unread,
  support: unread,
  marketing: {
    kind: "observed",
    drafts: "on",
    publish: "off",
    pending: { count: 3, oldestAt: null },
    lastRun: { at: "2026-11-07T00:00:00.000Z" },
    calls: 4,
  },
  trust: { kind: "not_permitted" },
  engineering: unread,
  amux: { kind: "no_catalog" },
};

const extras = {
  researchOpen: 1,
  marketingCost: { spentMicroUsd: 4_100_000, capMicroUsd: 20_000_000 },
  researchNextAt: "2026-11-07T23:00:00.000Z",
};

test("the board draws three totals and ten cards, each a link to its team's screen", () => {
  const html = renderToStaticMarkup(<AdminAgentTeamBoard rooms={rooms} extras={extras} readAt={rooms.readAt} />);
  assert.equal(html.match(/data-testid="team-board-card"/g)?.length, 10);
  for (const href of [
    "/admin/marketing",
    "/admin/product-research",
    "/admin/engineering-agent",
    "/admin/sre-ops",
    "/admin/finance-agent",
    "/admin/release",
    "/admin/agent-digests?tab=trust-safety",
  ]) {
    assert.ok(html.includes(`href="${href}"`), href);
  }
  assert.match(html, /data-testid="team-board-waiting"/);
  assert.match(html, /data-testid="team-board-cost"/);
  assert.match(html, /data-testid="team-board-working"/);
  // The Decisions link opens the inbox on its All tab; the agents tab is still a placeholder.
  assert.ok(html.includes('href="/admin/work-queue"'));
  assert.ok(!html.includes('tab=agents'));
});

test("totals sum what was read and say when something was not", () => {
  const html = renderToStaticMarkup(<AdminAgentTeamBoard rooms={rooms} extras={extras} readAt={rooms.readAt} />);
  // 3 marketing posts + 1 open Scout suggestion; the unread engineering room makes it a floor.
  assert.match(html, /4 items/);
  assert.match(html, /At least one count could not be read/);
  // Marketing 4.10 + routing 2.50 against 20 + 10.
  assert.match(html, /US\$ 6\.60/);
  assert.match(html, /Limit US\$ 30\.00/);
  assert.match(html, /Teams with a cost record: 2/);
  // Unread teams are dashed "Unavailable" cards, not off and not healthy.
  assert.match(html, /data-tone="unknown"/);
  assert.match(html, /Unavailable/);
});

test("a team with no cost record says so instead of showing zero", () => {
  const html = renderToStaticMarkup(<AdminAgentTeamBoard rooms={rooms} extras={extras} readAt={rooms.readAt} />);
  assert.match(html, /No cost record/);
  assert.doesNotMatch(html, /US\$ 0\.00/);
});

test("a failed read of every room is an error, not an empty board", () => {
  const html = renderToStaticMarkup(<AdminAgentTeamBoard rooms={null} extras={extras} readAt={rooms.readAt} />);
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /data-testid="team-board-card"/);
});

test("the agent head shows the switch as a reading that links to settings, never as off when unread", () => {
  const html = renderToStaticMarkup(
    <AdminAgentHeader
      team="marketing"
      name="Marketing team"
      status={{ tone: "ok", label: "Working" }}
      description="Makes posts."
      meta={[{ icon: "calendar", label: "Daily" }]}
      autoRun={{ state: "unknown", href: "/admin/marketing?tab=settings" }}
    />,
  );
  assert.match(html, /data-testid="agent-header"/);
  assert.match(html, /href="\/admin\/marketing\?tab=settings"/);
  assert.match(html, /data-state="unknown"/);
  assert.match(html, /Unavailable/);
  assert.doesNotMatch(html, /<button/);
});
