// The decision inbox: the work queue's rows and the badge counts, grouped by
// area. Pinned here because the inbox is read-only and has two ways to tell an
// operator something untrue: an empty list drawn while a source did not
// answer, and a link to a screen the role cannot open.

import assert from "node:assert/strict";
import test from "node:test";
import {
  DECISION_AREAS,
  DECISION_KIND_AREA,
  buildDecisionInbox,
  decisionGroupOf,
  decisionWaitHours,
  emailIn,
  initialsOf,
} from "../lib/adminDecisionInbox.ts";
import { EMPTY_ADMIN_NAVIGATION_COUNTS } from "../lib/adminNavigationBadges.ts";

const now = new Date("2026-11-07T04:00:00.000Z");
const hoursAgo = (hours) => new Date(now.getTime() - hours * 3_600_000).toISOString();

const row = (id, severity, openedAt, extra = {}) => ({
  id,
  category: "x",
  severity,
  title: extra.title ?? `title ${id}`,
  detail: extra.detail ?? `detail ${id}`,
  href: extra.href ?? "/admin/refunds",
  openedAt,
});

const queue = (items, extra = {}) => ({ items, truncatedCategories: [], failedCategories: [], ...extra });
const counts = (overrides) => ({ ...EMPTY_ADMIN_NAVIGATION_COUNTS, ...overrides });

test("every kind belongs to exactly one of the four areas", () => {
  assert.deepEqual([...DECISION_AREAS], ["customers", "agents", "development", "system"]);
  for (const area of Object.values(DECISION_KIND_AREA)) assert.ok(DECISION_AREAS.includes(area));
});

test("queue rows are sorted by severity, then by how long they have waited", () => {
  const inbox = buildDecisionInbox({
    queue: queue([
      row("feedback:1", "normal", hoursAgo(80), { href: "/admin/support?tab=feedback" }),
      row("refund:1", "high", hoursAgo(5)),
      row("refund:2", "high", hoursAgo(30)),
      row("incident:1", "critical", hoursAgo(1), { href: "/admin/providers?tab=incidents" }),
    ]),
    counts: counts({}),
    role: "owner",
    now,
  });
  assert.deepEqual(
    inbox.items.map((item) => item.id),
    ["incident:1", "refund:2", "refund:1", "feedback:1"]
  );
  assert.equal(inbox.waitHours["refund:2"], 30);
});

test("an agent or AMUX approval is one counted line with its count and no start time", () => {
  const inbox = buildDecisionInbox({
    queue: queue([]),
    counts: counts({
      pendingMarketingApprovals: 3,
      openProductResearchSuggestions: 0,
      openAmuxEscalations: 2,
      openAmuxOrchestratorHalts: 1,
      awaitingAmuxDecisionMaker: 0,
    }),
    role: "owner",
    now,
  });
  const marketing = inbox.items.find((item) => item.kind === "marketing");
  assert.ok(marketing);
  assert.equal(marketing.counted, true);
  assert.equal(marketing.count, 3);
  assert.equal(marketing.openedAt, null);
  assert.equal(inbox.waitHours[marketing.id], undefined);
  // A zero count is not a line.
  assert.equal(inbox.items.some((item) => item.kind === "scout"), false);
  // The area totals add the counts, not the number of lines.
  assert.equal(inbox.byArea.agents, 3);
  assert.equal(inbox.byArea.development, 3);
  assert.equal(inbox.total, 6);
});

test("a count that could not be read is named, never treated as zero", () => {
  const inbox = buildDecisionInbox({
    queue: queue([]),
    counts: counts({ pendingMarketingApprovals: 4 }),
    role: "owner",
    now,
  });
  assert.equal(inbox.byArea.agents, 4);
  assert.ok(inbox.unreadSources.includes("scout"));
  assert.ok(inbox.unreadSources.includes("amuxHalt"));
  assert.equal(inbox.unreadSources.includes("marketing"), false);
});

test("a work queue that failed to load is flagged, and its failed sources are passed on", () => {
  const down = buildDecisionInbox({ queue: null, counts: counts({}), role: "owner", now });
  assert.equal(down.queueUnread, true);
  assert.equal(down.items.length, 0);
  const partial = buildDecisionInbox({
    queue: queue([], { failedCategories: ["Refunds"], truncatedCategories: ["Support"] }),
    counts: counts({}),
    role: "owner",
    now,
  });
  assert.equal(partial.queueUnread, false);
  assert.deepEqual(partial.failedCategories, ["Refunds"]);
  assert.deepEqual(partial.truncatedCategories, ["Support"]);
});

test("a line whose screen the role cannot open is left out of the list and of the count", () => {
  // The Decision Maker board is the owner's; the review queue is every role's.
  const input = { awaitingAmuxDecisionMaker: 2, openAmuxEscalations: 1 };
  const owner = buildDecisionInbox({ queue: queue([]), counts: counts(input), role: "owner", now });
  const support = buildDecisionInbox({ queue: queue([]), counts: counts(input), role: "support", now });
  assert.equal(owner.items.some((item) => item.kind === "amuxDecisionMaker"), true);
  assert.equal(support.items.some((item) => item.kind === "amuxDecisionMaker"), false);
  assert.equal(support.items.some((item) => item.kind === "amuxReview"), true);
  assert.equal(owner.byArea.development, 3);
  assert.equal(support.byArea.development, 1);
});

test("a queue row of a kind the inbox does not know is not invented into an area", () => {
  const inbox = buildDecisionInbox({
    queue: queue([row("mystery:1", "normal", hoursAgo(2))]),
    counts: counts({}),
    role: "owner",
    now,
  });
  assert.equal(inbox.items.length, 0);
});

test("a customer line names the e-mail it came from, for its initials", () => {
  const inbox = buildDecisionInbox({
    queue: queue([row("refund:1", "high", hoursAgo(2), { title: "Refund request from mina.kim@example.com" })]),
    counts: counts({}),
    role: "owner",
    now,
  });
  assert.equal(inbox.items[0].requesterEmail, "mina.kim@example.com");
  assert.equal(initialsOf("mina.kim@example.com"), "MI");
  assert.equal(initialsOf(null), "?");
  assert.equal(emailIn("no address here", "x@y.io"), "x@y.io");
});

test("waits are grouped as long, recent or unknown at the 24 hour line", () => {
  assert.equal(decisionWaitHours(null, now), null);
  assert.equal(decisionWaitHours("not a date", now), null);
  assert.equal(decisionWaitHours(hoursAgo(25), now), 25);
  // A start in the future is a zero wait, not a negative one.
  assert.equal(decisionWaitHours(hoursAgo(-3), now), 0);
  assert.equal(decisionGroupOf(null), "unknown");
  assert.equal(decisionGroupOf(23), "recent");
  assert.equal(decisionGroupOf(24), "long");
});
