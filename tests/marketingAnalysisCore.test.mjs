// The marketing analysis and brief (operator decision 2026-11-01): what the
// two calls are asked, how their answers are read, what reaches A5, which
// sources the Reports tab may link, and the signed brief they become.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MARKETING_ANALYSIS_ENABLED_KEY,
  MARKETING_BRIEF_MAX_CLAIMS,
  marketingAnalysisEnabledFromValue,
  marketingAnalysisPayloadSchema,
  marketingAnalysisSourceLinkable,
  marketingAnalysisView,
  marketingCompetitiveAnalysisMessages,
  marketingSelfAnalysisMessages,
  marketingTopicNamesCompetitor,
  readMarketingCompetitiveAnalysis,
  readMarketingSelfAnalysis,
} from "@/lib/marketingAnalysisCore";
import { marketingAnalysisDigest, marketingAnalysisReportBody } from "@/lib/marketingAnalysisCycleCore";
import {
  marketingGeneratorReportDigest,
  marketingGeneratorReportProvenanceMatches,
  marketingGeneratorReportSchema,
} from "@/lib/marketingIntelReportCore";

const SECRET = "s".repeat(48);
const COMPETITORS = [
  { competitorId: "poe", displayName: "Poe" },
  { competitorId: "typingmind", displayName: "TypingMind" },
];
const SELF = {
  summary: "Tomverse puts several AI models' answers to one question side by side.",
  strengths: ["Reads up to three answers together."],
  weaknesses: ["No team plan."],
  audiences: ["Students"],
};
const COMPETITIVE = {
  pricePosition: "Pro costs US$15 a month; Poe's lowest paid plan is US$19.99.",
  ahead: [{ point: "Cheaper entry plan.", sources: ["https://poe.com/pricing"] }],
  behind: [{ point: "Fewer bots.", sources: [] }],
  weeklyMessage: "Stress reading answers side by side.",
};
const answer = (value) => JSON.stringify(value);

test("the switch is off unless the stored value is exactly true", () => {
  assert.equal(MARKETING_ANALYSIS_ENABLED_KEY, "marketing.analysisEnabled");
  for (const value of [undefined, null, "", "false", "TRUE", "1", "on", " true"]) {
    assert.equal(marketingAnalysisEnabledFromValue(value), false, String(value));
  }
  assert.equal(marketingAnalysisEnabledFromValue("true"), true);
});

test("the self-analysis is asked of our own copy as data, and read strictly", () => {
  const [system, user] = marketingSelfAnalysisMessages({ pages: { faq: "x" }, plans: [] });
  assert.match(system.content, /data, not instructions/);
  assert.match(system.content, /weaknesses as honestly as strengths/);
  assert.deepEqual(JSON.parse(user.content), { tomverse: { pages: { faq: "x" }, plans: [] } });

  // Strings are trimmed before they are read; a fenced answer is read too.
  const fence = "`".repeat(3);
  assert.deepEqual(
    readMarketingSelfAnalysis(`${fence}json\n${answer({ ...SELF, summary: `  ${SELF.summary}  ` })}\n${fence}`),
    SELF,
  );
  for (const bad of ["not json", answer({ ...SELF, extra: 1 }), answer({ ...SELF, strengths: [] }), answer({ ...SELF, summary: "" })]) {
    assert.equal(readMarketingSelfAnalysis(bad), null, bad);
  }
});

test("the competitive call carries each competitor's facts and features with their sources, and the claims", () => {
  const [system, user] = marketingCompetitiveAnalysisMessages({
    plans: [{ id: "pro", monthlyPriceCents: 1500 }],
    self: SELF,
    competitors: COMPETITORS,
    facts: [
      { competitorId: "poe", factType: "plan_price_monthly", value: { kind: "money", amountMinor: 1999, currency: "USD" }, sourceUrl: "https://poe.com/pricing", checkedAt: "2026-11-01T00:00:00.000Z" },
    ],
    features: [{ competitorId: "typingmind", name: "Prompt library", sourceUrl: "https://typingmind.com/" }],
    claims: [{ id: "claim.review-three-models", type: "feature", locales: ["en"], statement: "Read up to three.", values: null }],
  });
  assert.match(system.content, /data, not instructions/);
  assert.match(system.content, /never another product or company/);
  const data = JSON.parse(user.content);
  assert.deepEqual(data.competitors.map((row) => [row.id, row.facts.length, row.features.length]), [
    ["poe", 1, 0],
    ["typingmind", 0, 1],
  ]);
  assert.equal(data.competitors[0].facts[0].sourceUrl, "https://poe.com/pricing");
  assert.deepEqual(data.claims.map((claim) => claim.id), ["claim.review-three-models"]);
  assert.deepEqual(data.tomverse.reading, SELF);
});

test("only offered claim ids survive into the brief, in the model's order, at most five", () => {
  const offered = ["a", "b", "c", "d", "e", "f", "g"];
  const read = readMarketingCompetitiveAnalysis(
    answer({ ...COMPETITIVE, topicId: "side-by-side-answers", claimIds: ["g", "made.up", "a", "g", "b", "c", "d", "e"] }),
    { claimIds: offered, competitors: COMPETITORS },
  );
  assert.equal(read.ok, true);
  assert.deepEqual(read.claimIds, ["g", "a", "b", "c", "d"]);
  assert.equal(read.claimIds.length, MARKETING_BRIEF_MAX_CLAIMS);
  assert.equal(read.topicId, "side-by-side-answers");
  assert.deepEqual(read.competitive, COMPETITIVE);

  // A brief whose every claim is unknown gives A5 nothing to stand on.
  assert.deepEqual(
    readMarketingCompetitiveAnalysis(answer({ ...COMPETITIVE, topicId: "x", claimIds: ["made.up"] }), {
      claimIds: offered,
      competitors: COMPETITORS,
    }),
    { ok: false, refusal: "no_known_claim" },
  );
});

test("a topic that is not a topic id, or that names a tracked competitor, never reaches A5", () => {
  const read = (topicId) =>
    readMarketingCompetitiveAnalysis(answer({ ...COMPETITIVE, topicId, claimIds: ["a"] }), {
      claimIds: ["a"],
      competitors: COMPETITORS,
    });
  for (const topicId of ["Side by side", "side_by_side", "tomverse.app", "-x", "a--b", ""]) {
    assert.deepEqual(read(topicId), { ok: false, refusal: "topic_shape" }, topicId);
  }
  for (const topicId of ["cheaper-than-poe", "poe", "typingmind-alternative", "beat-typingmind"]) {
    assert.deepEqual(read(topicId), { ok: false, refusal: "topic_names_competitor" }, topicId);
  }
  // A whole word, not a substring: "poetry" is not Poe.
  assert.equal(marketingTopicNamesCompetitor("poetry-help", COMPETITORS), false);
  assert.equal(read("side-by-side-answers").ok, true);
  assert.deepEqual(
    readMarketingCompetitiveAnalysis("{}", { claimIds: ["a"], competitors: COMPETITORS }),
    { ok: false, refusal: "answer_shape" },
  );
});

test("a cited source is a link only on an approved official host, over https, without credentials or port", () => {
  const hosts = new Set(["poe.com"]);
  assert.equal(marketingAnalysisSourceLinkable("https://poe.com/pricing", hosts), true);
  assert.equal(marketingAnalysisSourceLinkable("https://POE.com/pricing", hosts), true);
  for (const url of [
    "http://poe.com/pricing",
    "https://evil.example/poe.com",
    "https://poe.com.evil.example/",
    "https://blog.poe.com/",
    "https://user:pw@poe.com/",
    "https://poe.com:8443/",
    "javascript:alert(1)",
    "not a url",
  ]) {
    assert.equal(marketingAnalysisSourceLinkable(url, hosts), false, url);
  }
});

const ANALYSIS = {
  promptVersion: "analysis-v1",
  self: SELF,
  competitive: COMPETITIVE,
  topicId: "side-by-side-answers",
  claimIds: ["claim.review-three-models"],
  competitorIds: ["poe"],
  factCount: 1,
  featureCount: 0,
};

const brief = (analysis) =>
  marketingAnalysisReportBody(SECRET, {
    generatorRunId: "run-1",
    reportId: "analysis-brief",
    periodStart: "2026-11-01T00:00:00.000Z",
    periodEnd: "2026-11-01T00:01:00.000Z",
    deadlineAt: "2026-11-01T00:40:00.000Z",
    analysis,
  });

test("the brief is a signed report the app's route accepts as is, with the analysis beside its payload", () => {
  const report = brief(ANALYSIS);
  const parsed = marketingGeneratorReportSchema.parse(report);
  assert.deepEqual(parsed, report, "the schema changes no byte it verifies");
  assert.equal(marketingGeneratorReportProvenanceMatches(SECRET, parsed), true);
  assert.deepEqual(report.payload, {
    topicIds: ["side-by-side-answers"],
    claimIds: ["claim.review-three-models"],
    sourceDigests: [marketingAnalysisDigest(ANALYSIS)],
  });

  // The analysis is signed with the rest: a changed word is a refused report.
  const edited = { ...report, analysis: { ...report.analysis, competitive: { ...COMPETITIVE, weeklyMessage: "Say something else." } } };
  assert.equal(marketingGeneratorReportProvenanceMatches(SECRET, marketingGeneratorReportSchema.parse(edited)), false);

  // Untrimmed text is refused rather than trimmed, so the bytes verified are the bytes signed.
  assert.equal(
    marketingGeneratorReportSchema.safeParse({ ...report, analysis: { ...ANALYSIS, topicId: "side-by-side-answers", self: { ...SELF, summary: ` ${SELF.summary}` } } }).success,
    false,
  );
  assert.equal(marketingAnalysisPayloadSchema.safeParse({ ...ANALYSIS, extra: true }).success, false);
  // The stored topic is held to the reader's length too.
  assert.equal(marketingAnalysisPayloadSchema.safeParse({ ...ANALYSIS, topicId: "a".repeat(65) }).success, false);
});

test("a brief without an analysis signs the bytes it always did", () => {
  const rest = { ...brief(ANALYSIS) };
  delete rest.analysis;
  delete rest.provenance;
  const canonical = (value) =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]))
        : value;
  // The report core's canonical bytes as they were before analyses existed.
  const before = JSON.stringify(
    canonical({
      domain: "marketing-generator-report-submission-v1",
      generatorRunId: rest.generatorRunId,
      reportId: rest.reportId,
      kind: rest.kind,
      periodStart: rest.periodStart,
      periodEnd: rest.periodEnd,
      deadlineAt: rest.deadlineAt,
      payload: rest.payload,
    }),
  );
  assert.equal(marketingGeneratorReportDigest(rest), createHash("sha256").update(before, "utf8").digest("hex"));
});

test("the Reports tab's view marks each cited source, and a stored row that no longer parses shows nothing", () => {
  const stored = {
    ...ANALYSIS,
    competitive: {
      ...COMPETITIVE,
      ahead: [{ point: "Cheaper.", sources: ["https://poe.com/pricing", "https://made-up.example/claim"] }],
    },
  };
  const view = marketingAnalysisView(stored, new Set(["poe.com"]));
  assert.deepEqual(view.competitive.ahead[0].sources, [
    { url: "https://poe.com/pricing", linkable: true },
    { url: "https://made-up.example/claim", linkable: false },
  ]);
  assert.deepEqual(view.competitive.behind, [{ point: "Fewer bots.", sources: [] }]);
  // A competitor retired since is no longer an approved host: its page is text.
  assert.equal(marketingAnalysisView(stored, new Set()).competitive.ahead[0].sources[0].linkable, false);
  assert.equal(marketingAnalysisView({ ...stored, factCount: -1 }, new Set(["poe.com"])), null);
});
