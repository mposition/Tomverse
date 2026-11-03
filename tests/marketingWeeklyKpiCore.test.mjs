import assert from "node:assert/strict";
import test from "node:test";

import { marketingKpiWeek, marketingWeeklyKpi } from "@/lib/marketingWeeklyKpiCore";

test("the week is the last full Monday-to-Monday in Brisbane time (UTC+10)", () => {
  // Thursday 2026-10-29 12:00 Brisbane: the week before is Mon 19th to Mon 26th, Brisbane midnight.
  const week = marketingKpiWeek(new Date("2026-10-29T02:00:00.000Z"));
  assert.equal(week.start.toISOString(), "2026-10-18T14:00:00.000Z");
  assert.equal(week.end.toISOString(), "2026-10-25T14:00:00.000Z");
  // Monday 00:00 Brisbane exactly closes the week that just ended.
  assert.equal(marketingKpiWeek(new Date("2026-10-25T14:00:00.000Z")).end.toISOString(), "2026-10-25T14:00:00.000Z");
  // A minute before, it is still Sunday in Brisbane: the week before that.
  assert.equal(marketingKpiWeek(new Date("2026-10-25T13:59:00.000Z")).end.toISOString(), "2026-10-18T14:00:00.000Z");
  // Monday morning in UTC is already Monday afternoon in Brisbane; Sunday UTC evening is Monday in Brisbane.
  assert.equal(marketingKpiWeek(new Date("2026-10-25T20:00:00.000Z")).end.toISOString(), "2026-10-25T14:00:00.000Z");
});

const week = { start: new Date("2026-10-18T14:00:00.000Z"), end: new Date("2026-10-25T14:00:00.000Z") };
const inside = new Date("2026-10-20T00:00:00.000Z");
const before = new Date("2026-10-18T13:59:59.999Z");
const post = (overrides) => ({
  channelId: "ch-x",
  status: "published",
  guardCodes: [],
  createdAt: before,
  updatedAt: before,
  publishedAt: null,
  ...overrides,
});

test("a week's counts: published by publish time, rejections and failures by last change, Guard codes by creation", () => {
  const kpi = marketingWeeklyKpi({
    week,
    channels: [
      { id: "ch-x", accountSlug: "x-1" },
      { id: "ch-li", accountSlug: "linkedin-1" },
    ],
    posts: [
      post({ publishedAt: inside }),
      // Published in the week and since verified: still a post published that week.
      post({ status: "verified", publishedAt: inside, updatedAt: inside }),
      post({ channelId: "ch-li", status: "failed", updatedAt: inside }),
      post({ status: "rejected", updatedAt: inside }),
      // A Guard rejection counts each of its codes once.
      post({ status: "guard_rejected", guardCodes: ["claim_unknown", "claim_unknown", "link_off_host"], createdAt: inside }),
      post({ status: "guard_rejected", guardCodes: ["claim_unknown"], createdAt: inside }),
      // Outside the week: published the moment before it began, the week's end itself, an old rejection.
      post({ publishedAt: before }),
      post({ publishedAt: week.end }),
      post({ status: "rejected", updatedAt: before }),
    ],
  });
  assert.deepEqual(kpi, {
    postsPublished: 2,
    postsRejected: 1,
    guardRejectionsByCode: [
      { code: "claim_unknown", count: 2 },
      { code: "link_off_host", count: 1 },
    ],
    channelTotals: [
      { accountSlug: "linkedin-1", published: 0, failed: 1 },
      { accountSlug: "x-1", published: 2, failed: 0 },
    ],
  });
});

test("a quiet week lists every account with zeros", () => {
  assert.deepEqual(marketingWeeklyKpi({ week, channels: [{ id: "ch-x", accountSlug: "x-1" }], posts: [] }), {
    postsPublished: 0,
    postsRejected: 0,
    guardRejectionsByCode: [],
    channelTotals: [{ accountSlug: "x-1", published: 0, failed: 0 }],
  });
});
