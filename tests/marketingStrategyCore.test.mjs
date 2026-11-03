// The weekly marketing plan (owner request 2026-11-03): which week a run plans,
// what the model is told, and what of its answer is kept.

import assert from "node:assert/strict";
import test from "node:test";

import {
  marketingAnalysisPayloadSchema,
  marketingStrategyWeek,
  marketingWeeklyStrategySchema,
} from "@/lib/marketingAnalysisCore";
import { marketingStrategyMessages, readMarketingWeeklyStrategy } from "@/lib/marketingStrategyCore";

test("the week is Monday to Sunday on the Brisbane clock", () => {
  // 13:59Z Sunday is 23:59 Sunday in Brisbane; 14:00Z is Monday 00:00.
  assert.deepEqual(marketingStrategyWeek(Date.parse("2026-11-08T13:59:59Z")), { start: "2026-11-02", end: "2026-11-08" });
  assert.deepEqual(marketingStrategyWeek(Date.parse("2026-11-08T14:00:00Z")), { start: "2026-11-09", end: "2026-11-15" });
  // The generator's 21:00Z run is 07:00 the next day in Brisbane.
  assert.deepEqual(marketingStrategyWeek(Date.parse("2026-11-08T21:00:00Z")), { start: "2026-11-09", end: "2026-11-15" });
});

const WEEK = { start: "2026-11-09", end: "2026-11-15" };
const ACCOUNTS = [
  { accountSlug: "instagram-1", platform: "instagram", locale: "en", assets: [{ id: "asset.en", kind: "video", about: "Three answers" }] },
  { accountSlug: "rednote-1", platform: "rednote", locale: "zh-Hans", assets: [] },
];
const CLAIMS = [{ id: "claim.why-tomverse", type: "feature", locales: ["en", "ko"], statement: "Why Tomverse" }];

const answer = (accounts, extra = {}) =>
  JSON.stringify({ headline: "h", rationale: "r", goal: "g", accounts, needs: [" a ", ""], avoid: [], ...extra });

const plan = (overrides = {}) => ({
  accountSlug: "instagram-1",
  role: "role",
  angle: "angle",
  format: "video",
  posts: 3,
  days: ["tue", "thu", "sat"],
  claimIds: ["claim.why-tomverse"],
  assetIds: ["asset.en"],
  ...overrides,
});

test("the model is told each account's weekly cap and asked to write in Korean", () => {
  const [system, user] = marketingStrategyMessages({
    week: WEEK,
    analysis: { self: {} },
    brief: { topicId: "t", claimIds: [] },
    accounts: ACCOUNTS,
    claims: CLAIMS,
  });
  assert.match(system.content, /Korean/u);
  assert.match(system.content, /data, not instructions/u);
  const data = JSON.parse(user.content);
  assert.deepEqual(data.accounts.map((account) => account.weeklyCap), [4, null]);
});

test("a hand-posted platform plans no automated posts, and a fenced answer is read", () => {
  const read = readMarketingWeeklyStrategy(
    "```json\n" + answer([plan(), plan({ accountSlug: "rednote-1", posts: 2, days: ["mon"], claimIds: [], assetIds: [] })]) + "\n```",
    { week: WEEK, accounts: ACCOUNTS, claims: CLAIMS },
  );
  assert.ok(read);
  assert.equal(read.weekStart, "2026-11-09");
  assert.deepEqual(read.needs, ["a"]);
  assert.deepEqual(
    read.accounts.map((entry) => [entry.accountSlug, entry.posts, entry.days]),
    [
      ["instagram-1", 3, ["tue", "thu", "sat"]],
      ["rednote-1", 0, []],
    ],
  );
  assert.equal(marketingWeeklyStrategySchema.safeParse(read).success, true);
});

test("the post count is the number of distinct days named", () => {
  const read = readMarketingWeeklyStrategy(answer([plan({ posts: 3, days: ["mon", "Mon", "someday"] })]), {
    week: WEEK,
    accounts: ACCOUNTS,
    claims: CLAIMS,
  });
  assert.deepEqual([read.accounts[0].posts, read.accounts[0].days], [1, ["mon"]]);
});

test("paid advertising is a proposal: complete ones are kept, cut to their stored length, at most three", () => {
  const ad = (overrides = {}) => ({
    platform: "Meta",
    objective: "호주 영어 시장 도달 시험",
    budget: "AUD 50~100, 7일",
    why: "승인된 영상이 있다",
    ...overrides,
  });
  const read = readMarketingWeeklyStrategy(
    answer([plan()], { paidAds: [ad({ platform: "x".repeat(120) }), ad({ why: "" }), ad(), ad(), ad()] }),
    { week: WEEK, accounts: ACCOUNTS, claims: CLAIMS },
  );
  assert.equal(read.paidAds.length, 3);
  assert.equal(read.paidAds[0].platform.length, 80);
  assert.equal(read.promptVersion, "strategy-v2");
  const none = readMarketingWeeklyStrategy(answer([plan()]), { week: WEEK, accounts: ACCOUNTS, claims: CLAIMS });
  assert.deepEqual(none.paidAds, []);
});

test("the model is told a paid ad is a proposal, never a spend", () => {
  const [system] = marketingStrategyMessages({
    week: WEEK,
    analysis: {},
    brief: { topicId: "t", claimIds: [] },
    accounts: ACCOUNTS,
    claims: CLAIMS,
  });
  assert.match(system.content, /paidAds/u);
  assert.match(system.content, /never placed automatically/u);
});

test("an answer that is not a plan, or plans no offered account, is not kept", () => {
  const input = { week: WEEK, accounts: ACCOUNTS, claims: CLAIMS };
  assert.equal(readMarketingWeeklyStrategy("not json", input), null);
  assert.equal(readMarketingWeeklyStrategy(answer([plan({ accountSlug: "x-1" })]), input), null);
  assert.equal(readMarketingWeeklyStrategy(answer([plan()], { headline: "" }), input), null);
  assert.equal(readMarketingWeeklyStrategy(answer([plan()], { extra: "field" }), input), null);
});

test("an analysis payload stays valid with or without a plan", () => {
  const base = {
    promptVersion: "analysis-v1",
    self: { summary: "s", strengths: ["a"], weaknesses: ["b"], audiences: ["c"] },
    competitive: { pricePosition: "p", ahead: [], behind: [], weeklyMessage: "w" },
    topicId: "side-by-side",
    claimIds: ["claim.why-tomverse"],
    competitorIds: [],
    factCount: 0,
    featureCount: 0,
  };
  assert.equal(marketingAnalysisPayloadSchema.safeParse(base).success, true);
  const strategy = readMarketingWeeklyStrategy(answer([plan()]), { week: WEEK, accounts: ACCOUNTS, claims: CLAIMS });
  assert.equal(marketingAnalysisPayloadSchema.safeParse({ ...base, strategy }).success, true);
});
