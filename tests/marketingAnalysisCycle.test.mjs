// One run of the analysis and brief, against fake ports: no model, no app.

import assert from "node:assert/strict";
import test from "node:test";

import { runMarketingAnalysisCycle } from "@/lib/marketingAnalysisCycleCore";
import {
  marketingGeneratorReportProvenanceMatches,
  marketingGeneratorReportSchema,
} from "@/lib/marketingIntelReportCore";

const SECRET = "s".repeat(48);
const NOW = Date.parse("2026-11-01T00:00:00.000Z");
const DEADLINE = new Date(NOW + 5 * 60 * 1000).toISOString();

const SELF = {
  summary: "Tomverse puts several AI models' answers to one question side by side.",
  strengths: ["Reads up to three answers together."],
  weaknesses: ["No team plan."],
  audiences: ["Students"],
};
const COMPETITIVE = {
  pricePosition: "Pro costs US$15 a month.",
  ahead: [{ point: "Cheaper.", sources: ["https://poe.com/pricing"] }],
  behind: [],
  weeklyMessage: "Stress reading answers side by side.",
  topicId: "side-by-side-answers",
  claimIds: ["claim.made-up", "claim.review-three-models"],
};

const context = (overrides = {}) => ({
  claims: [
    {
      id: "claim.review-three-models",
      type: "feature",
      locales: ["en", "ko"],
      statements: { en: "Read up to three model answers.", ko: "최대 3개" },
      values: null,
    },
    { id: "claim.pro-monthly-price", type: "pricing", locales: ["ko"], statements: {}, values: { name: "Pro" } },
  ],
  competitors: { tracked: [{ competitorId: "poe", displayName: "Poe", officialHosts: ["poe.com"] }], knownIds: ["poe"] },
  ownProduct: { pages: { faq: {} }, plans: [{ id: "pro", monthlyPriceCents: 1500 }] },
  analysis: { enabled: true },
  ...overrides,
});

const MARKET = {
  facts: [
    { competitorId: "poe", factType: "plan_price_monthly", value: { kind: "money", amountMinor: 1999, currency: "USD" }, sourceUrl: "https://poe.com/pricing", checkedAt: "2026-11-01T00:00:00.000Z" },
    // A competitor the registry no longer tracks is left out.
    { competitorId: "retired", factType: "plan_price_monthly", value: { kind: "money", amountMinor: 1, currency: "USD" }, sourceUrl: "https://retired.example/", checkedAt: "2026-11-01T00:00:00.000Z" },
  ],
  features: [{ competitorId: "poe", name: "Multi-bot chat", sourceUrl: "https://poe.com/pricing" }],
};

const answered = (content) => ({
  status: "answered",
  callId: "c1",
  requestKey: "k",
  content: JSON.stringify(content),
  citations: [],
  ledgerState: "settled",
});

function ports({ ctx = context(), answers = [answered(SELF), answered(COMPETITIVE)], submit } = {}) {
  const seen = { calls: [], reports: [] };
  let clock = NOW;
  let index = 0;
  return {
    seen,
    deps: {
      readContext: async () => ctx,
      callLlm: async (messages, requestKey) => {
        seen.calls.push({ messages, requestKey });
        return answers[index++];
      },
      submitReport:
        submit ??
        (async (report) => {
          seen.reports.push(report);
          return { httpStatus: 200, body: { result: { status: "recorded" } } };
        }),
      secret: SECRET,
      newId: (() => {
        let n = 0;
        return () => `id-${n++}`;
      })(),
      now: () => (clock += 1_000),
      sleep: async () => {},
    },
  };
}

test("with the switch on, two calls make one signed brief whose analysis rests on what A3 kept", async () => {
  const { deps, seen } = ports();
  const summary = await runMarketingAnalysisCycle({ generatorRunId: "run-1", deadlineAt: DEADLINE, market: MARKET }, deps);
  assert.deepEqual(summary, {
    calls: 2,
    unusable: null,
    claimIds: 1,
    report: { httpStatus: 200, status: "recorded" },
    stoppedAt: null,
  });
  assert.equal(seen.calls.length, 2);
  const competitiveInput = JSON.parse(seen.calls[1].messages[1].content);
  assert.deepEqual(competitiveInput.tomverse.reading, SELF);
  assert.deepEqual(competitiveInput.competitors.map((row) => row.id), ["poe"]);
  assert.equal(competitiveInput.competitors[0].facts.length, 1);
  assert.equal(competitiveInput.competitors[0].features[0].name, "Multi-bot chat");
  // The analysis is told each claim's English sentence, or its values.
  assert.deepEqual(
    competitiveInput.claims.map((claim) => [claim.id, claim.statement]),
    [
      ["claim.review-three-models", "Read up to three model answers."],
      ["claim.pro-monthly-price", null],
    ],
  );

  assert.equal(seen.reports.length, 1);
  const report = marketingGeneratorReportSchema.parse(seen.reports[0]);
  assert.equal(marketingGeneratorReportProvenanceMatches(SECRET, report), true);
  assert.equal(report.kind, "brief");
  assert.deepEqual(report.payload.topicIds, ["side-by-side-answers"]);
  // The made-up claim id never reaches the brief the app checks.
  assert.deepEqual(report.payload.claimIds, ["claim.review-three-models"]);
  assert.deepEqual(report.analysis.competitorIds, ["poe"]);
  assert.equal(report.analysis.factCount, 1);
  assert.equal(report.analysis.featureCount, 1);
});

test("with the switch off, or no switch in an older context, nothing is called", async () => {
  for (const ctx of [context({ analysis: { enabled: false } }), context({ analysis: undefined })]) {
    const { deps, seen } = ports({ ctx });
    const summary = await runMarketingAnalysisCycle({ generatorRunId: "run-1", deadlineAt: DEADLINE, market: MARKET }, deps);
    assert.deepEqual(summary.stoppedAt, { stage: "disabled", detail: "analysis_switch_off" });
    assert.equal(seen.calls.length, 0);
    assert.equal(seen.reports.length, 0);
  }
});

test("a switch the ledger finds off is a skipped step; any other refusal or unknown stops the run", async () => {
  const cases = [
    [{ status: "refused", stage: "reserve", code: "purpose_disabled" }, { stage: "disabled", detail: "reserve:purpose_disabled" }],
    [{ status: "refused", stage: "reserve", code: "budget_exhausted" }, { stage: "llm", detail: "reserve:budget_exhausted" }],
    [{ status: "unknown", callId: "c1", requestKey: "k" }, { stage: "llm", detail: "unknown" }],
    [{ status: "retained", callId: "c1", requestKey: "k", ledgerState: "unknown_retained" }, { stage: "llm", detail: "retained" }],
  ];
  for (const [outcome, stoppedAt] of cases) {
    const { deps, seen } = ports({ answers: [outcome] });
    const summary = await runMarketingAnalysisCycle({ generatorRunId: "run-1", deadlineAt: DEADLINE, market: MARKET }, deps);
    assert.deepEqual(summary.stoppedAt, stoppedAt, JSON.stringify(outcome));
    assert.equal(seen.calls.length, 1);
    assert.equal(seen.reports.length, 0);
  }
});

test("an answer that came back unusable records no brief and does not stop the run", async () => {
  const unusable = [
    [[answered({ nope: true })], "self_unreadable", 1],
    [[answered(SELF), answered({ ...COMPETITIVE, claimIds: ["claim.made-up"] })], "no_known_claim", 2],
    [[answered(SELF), answered({ ...COMPETITIVE, topicId: "cheaper-than-poe" })], "topic_names_competitor", 2],
  ];
  for (const [answers, reason, calls] of unusable) {
    const { deps, seen } = ports({ answers });
    const summary = await runMarketingAnalysisCycle({ generatorRunId: "run-1", deadlineAt: DEADLINE, market: MARKET }, deps);
    assert.equal(summary.unusable, reason);
    assert.equal(summary.stoppedAt, null);
    assert.equal(summary.calls, calls);
    assert.equal(seen.reports.length, 0);
  }
});

test("too close to its deadline, no call is started", async () => {
  const { deps, seen } = ports();
  const summary = await runMarketingAnalysisCycle(
    { generatorRunId: "run-1", deadlineAt: new Date(NOW + 30_000).toISOString(), market: MARKET },
    deps,
  );
  assert.deepEqual(summary.stoppedAt, { stage: "deadline", detail: "deadline_too_close" });
  assert.equal(seen.calls.length, 0);
});

test("the report is resent as the same bytes on a lost answer or a 5xx, and an unknown end stops the run", async () => {
  const sent = [];
  let attempt = 0;
  const { deps } = ports({
    submit: async (report) => {
      sent.push(JSON.stringify(report));
      attempt += 1;
      if (attempt === 1) throw new Error("lost");
      if (attempt === 2) return { httpStatus: 503, body: {} };
      return { httpStatus: 200, body: { result: { status: "recorded" } } };
    },
  });
  const summary = await runMarketingAnalysisCycle({ generatorRunId: "run-1", deadlineAt: DEADLINE, market: MARKET }, deps);
  assert.equal(summary.stoppedAt, null);
  assert.equal(sent.length, 3);
  assert.equal(new Set(sent).size, 1);

  const { deps: lost } = ports({ submit: async () => { throw new Error("lost"); } });
  const stopped = await runMarketingAnalysisCycle({ generatorRunId: "run-1", deadlineAt: DEADLINE, market: MARKET }, lost);
  assert.deepEqual(stopped.stoppedAt, { stage: "submit", detail: "outcome_unknown" });
});
