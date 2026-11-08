import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_LOCAL_POSTING_WINDOW,
  localParts,
  planDailyMarketingSchedule,
  type DailySchedulePost,
  type DailyScheduleTakenSlot,
} from "@/lib/marketingDailyScheduleCore";

/**
 * One approved post a day per account (owner request 2026-11-08). Pure: every
 * case passes its own clock.
 */

const post = (id: string, overrides: Partial<DailySchedulePost> = {}): DailySchedulePost => ({
  id,
  status: "approved",
  provider: "zernio",
  channelId: "ig-ko",
  accountLocale: "ko",
  approvedAt: "2026-11-07T00:00:00.000Z",
  approvalExpiresAt: "2026-11-30T00:00:00.000Z",
  dailyCap: 1,
  ...overrides,
});

// Seoul 05:00, Brisbane 06:00, Taipei 04:00 on 8 November: every market's 10:00 is ahead.
const EARLY = Date.parse("2026-11-07T20:00:00.000Z");

const times = (plan: ReturnType<typeof planDailyMarketingSchedule>, channelId?: string) =>
  plan.slots.filter((slot) => !channelId || slot.channelId === channelId).map((slot) => slot.scheduledAt);

const inWindow = (iso: string, timeZone: string) => {
  const local = localParts(Date.parse(iso), timeZone);
  return local.hour >= MARKETING_LOCAL_POSTING_WINDOW.startHour && local.hour < MARKETING_LOCAL_POSTING_WINDOW.endHour;
};

test("each account gets one post a day, at its market's 10:00, oldest approval first", () => {
  const plan = planDailyMarketingSchedule({
    now: EARLY,
    taken: [],
    posts: [
      post("ko-3", { approvedAt: "2026-11-07T03:00:00.000Z" }),
      post("ko-1", { approvedAt: "2026-11-07T01:00:00.000Z" }),
      post("ko-2", { approvedAt: "2026-11-07T02:00:00.000Z" }),
      post("en-1", { channelId: "li-en", accountLocale: "en" }),
      post("en-2", { channelId: "li-en", accountLocale: "en", approvedAt: "2026-11-07T05:00:00.000Z" }),
      post("tw-1", { channelId: "ig-tw", accountLocale: "zh-Hant" }),
    ],
  });
  assert.deepEqual(
    plan.slots.filter((slot) => slot.channelId === "ig-ko").map((slot) => slot.postId),
    ["ko-1", "ko-2", "ko-3"]
  );
  assert.deepEqual(times(plan, "ig-ko"), [
    "2026-11-08T01:00:00.000Z",
    "2026-11-09T01:00:00.000Z",
    "2026-11-10T01:00:00.000Z",
  ]);
  assert.deepEqual(times(plan, "li-en"), ["2026-11-08T00:00:00.000Z", "2026-11-09T00:00:00.000Z"]);
  assert.deepEqual(times(plan, "ig-tw"), ["2026-11-08T02:00:00.000Z"]);
  assert.deepEqual(plan.expired, []);
  assert.deepEqual(
    plan.accounts.map((account) => [account.channelId, account.timeZone]),
    // Accounts in the order of their oldest approval.
    [
      ["li-en", "Australia/Brisbane"],
      ["ig-tw", "Asia/Taipei"],
      ["ig-ko", "Asia/Seoul"],
    ]
  );
});

test("an account whose cap is already spent today starts tomorrow", () => {
  const plan = planDailyMarketingSchedule({
    now: EARLY,
    taken: [{ channelId: "ig-ko", slotDay: "2026-11-08", scheduledAt: null }],
    posts: [post("a"), post("b", { approvedAt: "2026-11-07T01:00:00.000Z" })],
  });
  assert.deepEqual(times(plan), ["2026-11-09T01:00:00.000Z", "2026-11-10T01:00:00.000Z"]);
});

test("a post already scheduled for today fills a one-a-day account's today", () => {
  const plan = planDailyMarketingSchedule({
    now: EARLY,
    taken: [{ channelId: "ig-ko", slotDay: null, scheduledAt: "2026-11-08T07:00:00.000Z" }],
    posts: [post("a")],
  });
  assert.deepEqual(times(plan), ["2026-11-09T01:00:00.000Z"]);
});

test("an account with room left today still uses today", () => {
  // X allows two a day; one went out this morning.
  const plan = planDailyMarketingSchedule({
    now: EARLY,
    taken: [{ channelId: "x-en", slotDay: "2026-11-08", scheduledAt: null }],
    posts: [
      post("a", { channelId: "x-en", accountLocale: "en", dailyCap: 2 }),
      post("b", { channelId: "x-en", accountLocale: "en", dailyCap: 2, approvedAt: "2026-11-07T01:00:00.000Z" }),
    ],
  });
  assert.deepEqual(times(plan), ["2026-11-08T00:00:00.000Z", "2026-11-09T00:00:00.000Z"]);
});

test("days already holding a scheduled post are gone around, and the post is not moved", () => {
  const taken: DailyScheduleTakenSlot[] = [
    { channelId: "ig-ko", slotDay: null, scheduledAt: "2026-11-09T03:00:00.000Z" },
    // Another account's post does not take this account's day.
    { channelId: "li-en", slotDay: null, scheduledAt: "2026-11-10T00:00:00.000Z" },
  ];
  const plan = planDailyMarketingSchedule({
    now: EARLY,
    taken,
    posts: [
      post("a"),
      post("b", { approvedAt: "2026-11-07T01:00:00.000Z" }),
      post("c", { approvedAt: "2026-11-07T02:00:00.000Z" }),
    ],
  });
  assert.deepEqual(times(plan), [
    "2026-11-08T01:00:00.000Z",
    "2026-11-10T01:00:00.000Z",
    "2026-11-11T01:00:00.000Z",
  ]);
});

test("overdue scheduled posts take the next days first, as the publisher would claim them", () => {
  // Two posts from an earlier "publish all now", still waiting on a one-a-day account.
  const plan = planDailyMarketingSchedule({
    now: EARLY,
    taken: [
      { channelId: "ig-ko", slotDay: null, scheduledAt: "2026-11-07T10:00:00.000Z" },
      { channelId: "ig-ko", slotDay: null, scheduledAt: "2026-11-07T10:00:00.000Z" },
    ],
    posts: [post("a")],
  });
  // Today (UTC 11-07, Seoul 11-08 05:00) and 11-08 are theirs; 11-08 is the market's today.
  assert.deepEqual(times(plan), ["2026-11-09T01:00:00.000Z"]);
});

test("late in the market's day, today's slot is as soon as possible, then tomorrow", () => {
  // Seoul 19:50: five minutes on is 19:55, still inside the window.
  const stillToday = planDailyMarketingSchedule({
    now: Date.parse("2026-11-08T10:50:00.000Z"),
    taken: [],
    posts: [post("a"), post("b", { approvedAt: "2026-11-07T01:00:00.000Z" })],
  });
  assert.deepEqual(times(stillToday), ["2026-11-08T10:55:00.000Z", "2026-11-09T01:00:00.000Z"]);

  // Seoul 19:58: five minutes on is past 20:00, so today is over.
  const tomorrow = planDailyMarketingSchedule({
    now: Date.parse("2026-11-08T10:58:00.000Z"),
    taken: [],
    posts: [post("a")],
  });
  assert.deepEqual(times(tomorrow), ["2026-11-09T01:00:00.000Z"]);
});

test("near midnight each market counts its own today, and every time is inside 09:00-20:00 local", () => {
  // UTC 14:30 on 8 Nov: Seoul 23:30 (8th), Taipei 22:30 (8th), Brisbane 00:30 (9th).
  const now = Date.parse("2026-11-08T14:30:00.000Z");
  const plan = planDailyMarketingSchedule({
    now,
    taken: [],
    posts: [
      post("ko"),
      post("tw", { channelId: "ig-tw", accountLocale: "zh-Hant" }),
      post("en", { channelId: "li-en", accountLocale: "en" }),
    ],
  });
  assert.deepEqual(times(plan, "ig-ko"), ["2026-11-09T01:00:00.000Z"]);
  assert.deepEqual(times(plan, "ig-tw"), ["2026-11-09T02:00:00.000Z"]);
  // Brisbane's today is already the 9th, and its 10:00 is still ahead.
  assert.deepEqual(times(plan, "li-en"), ["2026-11-09T00:00:00.000Z"]);
  for (const account of plan.accounts) {
    for (const slot of account.slots) {
      assert.ok(inWindow(slot.scheduledAt, account.timeZone), `${slot.scheduledAt} in ${account.timeZone}`);
      assert.ok(Date.parse(slot.scheduledAt) > now);
    }
  }

  // Every hour of a day, across all four markets: always inside the window, always ahead.
  for (let hour = 0; hour < 24; hour += 1) {
    const at = Date.parse("2026-11-08T00:17:00.000Z") + hour * 3_600_000;
    const sweep = planDailyMarketingSchedule({
      now: at,
      taken: [],
      posts: ["en", "ko", "zh-Hant", "zh-Hans"].flatMap((locale) =>
        [1, 2, 3].map((n) =>
          post(`${locale}-${n}`, { channelId: `acct-${locale}`, accountLocale: locale, approvedAt: `2026-11-07T0${n}:00:00.000Z` })
        )
      ),
    });
    assert.equal(sweep.slots.length, 12);
    for (const account of sweep.accounts) {
      const days = account.slots.map((slot) => slot.localDay);
      assert.equal(new Set(days).size, days.length, "one a day");
      for (const slot of account.slots) {
        assert.ok(inWindow(slot.scheduledAt, account.timeZone), `${slot.scheduledAt} in ${account.timeZone}`);
        assert.ok(Date.parse(slot.scheduledAt) > at);
      }
    }
  }
});

test("a post whose turn comes after its approval expires is left out and reported; the day passes on", () => {
  const plan = planDailyMarketingSchedule({
    now: EARLY,
    taken: [],
    posts: [
      post("a"),
      // Its turn would be 9 Nov 10:00 KST, but its approval ends before that.
      post("b", { approvedAt: "2026-11-07T01:00:00.000Z", approvalExpiresAt: "2026-11-09T00:00:00.000Z" }),
      post("c", { approvedAt: "2026-11-07T02:00:00.000Z" }),
      // Already expired.
      post("d", { approvedAt: "2026-11-07T03:00:00.000Z", approvalExpiresAt: "2026-11-07T00:00:00.000Z" }),
    ],
  });
  assert.deepEqual(
    plan.slots.map((slot) => [slot.postId, slot.scheduledAt]),
    [
      ["a", "2026-11-08T01:00:00.000Z"],
      ["c", "2026-11-09T01:00:00.000Z"],
    ]
  );
  assert.deepEqual(plan.expired, ["b", "d"]);
});

test("hand-posted accounts, accounts the publisher does not post to and posts not approved are left out", () => {
  const plan = planDailyMarketingSchedule({
    now: EARLY,
    taken: [],
    posts: [
      post("manual", { provider: "manual", channelId: "manual-acct" }),
      post("rednote", { channelId: "rn", dailyCap: null }),
      post("scheduled", { status: "scheduled" }),
      post("verified", { status: "verified" }),
      post("ok"),
    ],
  });
  assert.deepEqual(plan.slots.map((slot) => slot.postId), ["ok"]);
  assert.deepEqual(plan.accounts.map((account) => account.channelId), ["ig-ko"]);
  assert.deepEqual(plan.expired, []);
});
