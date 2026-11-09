// The operator reads the market analysis, the brief, the morning report, the
// weekly plan and competitor proposals in Korean (owner request 2026-11-09).
// Each prompt says so, keeps machine keys as given, and asks for lengths that
// fit the stored schema, so a long Korean answer is not refused whole.

import assert from "node:assert/strict";
import test from "node:test";

import { MARKETING_A3_PROMPT_VERSION, marketingA3DiscoveryMessages } from "@/lib/marketingA3Core";
import {
  MARKETING_ANALYSIS_PROMPT_VERSION,
  marketingCompetitiveAnalysisMessages,
  marketingCompetitiveAnalysisSchema,
  marketingSelfAnalysisMessages,
  marketingSelfAnalysisSchema,
} from "@/lib/marketingAnalysisCore";
import { MARKETING_MORNING_PROMPT_VERSION, marketingMorningMessages } from "@/lib/marketingMorningCore";
import { MARKETING_STRATEGY_PROMPT_VERSION, marketingStrategyMessages } from "@/lib/marketingStrategyCore";

const system = (messages) => messages.find((message) => message.role === "system").content;

/** The `Length, in ... characters:` line's limits, by the words before each number. */
const lengths = (prompt) => {
  const line = prompt.split("\n").find((entry) => entry.startsWith("Length, in"));
  assert.ok(line, "the prompt states the lengths it wants");
  return Object.fromEntries(
    [...line.matchAll(/([A-Za-z][A-Za-z ]*?) at most (\d+)/gu)].map((match) => [
      match[1].replace(/^each /u, "").trim(),
      Number(match[2]),
    ]),
  );
};

const korean = (length) => "가".repeat(length);

test("the prompt versions moved with the Korean instructions", () => {
  assert.equal(MARKETING_ANALYSIS_PROMPT_VERSION, "analysis-v3");
  assert.equal(MARKETING_A3_PROMPT_VERSION, "a3-web-search-v4");
  assert.equal(MARKETING_MORNING_PROMPT_VERSION, "morning-v2");
  assert.equal(MARKETING_STRATEGY_PROMPT_VERSION, "strategy-v4");
});

test("the self-analysis answers in Korean, at lengths its schema keeps", () => {
  const prompt = system(marketingSelfAnalysisMessages({}));
  assert.match(prompt, /Write every sentence in Korean/u);
  const limit = lengths(prompt);
  const answer = {
    summary: korean(limit.summary),
    strengths: Array.from({ length: 6 }, () => korean(limit["strength or weakness"])),
    weaknesses: Array.from({ length: 6 }, () => korean(limit["strength or weakness"])),
    audiences: Array.from({ length: 5 }, () => korean(limit.audience)),
  };
  assert.equal(marketingSelfAnalysisSchema.safeParse(answer).success, true);
});

test("the competitive analysis answers in Korean and keeps the topic id English", () => {
  const prompt = system(
    marketingCompetitiveAnalysisMessages({
      plans: [],
      self: { summary: "a", strengths: ["a"], weaknesses: ["a"], audiences: ["a"] },
      competitors: [],
      facts: [],
      features: [],
      claims: [],
    }),
  );
  assert.match(prompt, /Write every sentence in Korean/u);
  assert.match(prompt, /topicId alone stays lower case English words/u);
  assert.match(prompt, /ids and URLs are copied exactly/u);
  const limit = lengths(prompt);
  const point = { point: korean(limit.point), sources: [] };
  const answer = {
    pricePosition: korean(limit.pricePosition),
    ahead: Array.from({ length: 8 }, () => point),
    behind: Array.from({ length: 8 }, () => point),
    weeklyMessage: korean(limit.weeklyMessage),
  };
  assert.equal(marketingCompetitiveAnalysisSchema.safeParse(answer).success, true);
});

test("a competitor proposal's rationale is Korean and under its 400-character limit", () => {
  const prompt = system(marketingA3DiscoveryMessages({ knownIds: [], trackedNames: [] }));
  assert.match(prompt, /Write rationale in Korean, at most 300 characters/u);
  assert.match(prompt, /competitorId, displayName, officialHosts and evidenceUrls are not translated/u);
});

test("the morning report and the weekly plan ask for lengths under their stored limits", () => {
  const morning = system(
    marketingMorningMessages({ date: "2026-11-09", operations: {}, brief: {}, competitors: [], marketPrices: [] }),
  );
  assert.match(morning, /Write every sentence in Korean/u);
  // lib/marketingAnalysisCore.ts marketingMorningReportSchema.
  const morningMax = { verdict: 600, title: 200, why: 500, worked: 800, what: 200, "change or action": 300 };
  for (const [field, stated] of Object.entries(lengths(morning))) {
    assert.ok(stated < morningMax[field], `${field}: ${stated} under ${morningMax[field]}`);
  }

  const strategy = system(
    marketingStrategyMessages({
      week: { start: "2026-11-09", end: "2026-11-15" },
      analysis: {},
      brief: { topicId: "a", claimIds: [] },
      accounts: [],
      claims: [],
    }),
  );
  assert.match(strategy, /every sentence is in Korean/u);
  // lib/marketingAnalysisCore.ts marketingWeeklyStrategySchema.
  const strategyMax = {
    headline: 400,
    rationale: 1000,
    goal: 800,
    role: 300,
    angle: 500,
    format: 200,
    "need or avoid": 300,
    platform: 80,
    objective: 300,
    budget: 200,
    why: 600,
  };
  const stated = lengths(strategy);
  assert.deepEqual(Object.keys(stated).sort(), Object.keys(strategyMax).sort());
  for (const [field, value] of Object.entries(stated)) {
    assert.ok(value < strategyMax[field], `${field}: ${value} under ${strategyMax[field]}`);
  }
});
