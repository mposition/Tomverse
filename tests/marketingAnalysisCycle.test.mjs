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
    strategy: "not_due",
    morning: "no_data",
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

// The weekly plan (owner request 2026-11-03): a third call at the first run of
// a Brisbane week, read against the accounts, claims and assets offered.

const PLAN_CONTEXT = context({
  analysis: { enabled: true, strategyDue: true },
  channels: [
    { channel: "instagram", accountSlug: "instagram-3", defaultLocale: "ko" },
    { channel: "facebook", accountSlug: "facebook-3", defaultLocale: "en" },
  ],
  assets: [
    { id: "asset.short-ko", allowedChannels: ["instagram"], altLocales: ["ko"], kind: "video", alt: { ko: "세 답 비교 장면" } },
    { id: "asset.short-en", allowedChannels: ["instagram"], altLocales: ["en"], kind: "video", alt: { en: "Three answers" } },
  ],
});

const PLAN = {
  headline: "구독 여러 개 대신 한 화면에서 세 모델을 비교",
  rationale: "대형 3사가 모두 월 US$20 선이다.",
  goal: "공개 게시로 계정별 반응 기준선을 만든다.",
  accounts: [
    {
      accountSlug: "instagram-3",
      role: "한국어 인지도",
      angle: "같은 질문, 세 답",
      format: "숏폼 영상",
      posts: 9,
      days: ["Tue", "thu", "sat", "sun", "mon"],
      claimIds: ["claim.review-three-models", "claim.made-up"],
      assetIds: ["asset.short-ko", "asset.short-en"],
    },
    { accountSlug: "instagram-3", role: "중복", angle: "중복", format: "글", posts: 1, days: [], claimIds: [], assetIds: [] },
    { accountSlug: "x-1", role: "없는 계정", angle: "-", format: "글", posts: 2, days: ["mon"], claimIds: [], assetIds: [] },
    {
      accountSlug: "facebook-3",
      role: "설명형",
      angle: "저장과 공유",
      format: "텍스트",
      posts: 2,
      days: ["mon", "wed"],
      // Offered only in ko: not this en account's claim.
      claimIds: ["claim.pro-monthly-price", "claim.review-three-models"],
      assetIds: ["asset.short-en"],
    },
  ],
  needs: ["zh-Hant 숏폼 1개 추가"],
  avoid: ["경쟁사 이름을 쓰지 않는다"],
};

test("when this week has no plan, a third call plans it and the brief carries what survives the checks", async () => {
  const { deps, seen } = ports({ ctx: PLAN_CONTEXT, answers: [answered(SELF), answered(COMPETITIVE), answered(PLAN)] });
  const summary = await runMarketingAnalysisCycle({ generatorRunId: "run-1", deadlineAt: DEADLINE, market: MARKET }, deps);
  assert.equal(summary.calls, 3);
  assert.equal(summary.strategy, "recorded");
  assert.equal(summary.stoppedAt, null);

  const planInput = JSON.parse(seen.calls[2].messages[1].content);
  assert.deepEqual(planInput.brief, { topicId: "side-by-side-answers", claimIds: ["claim.review-three-models"] });
  assert.deepEqual(
    planInput.accounts.map((account) => [account.accountSlug, account.weeklyCap, account.assets.map((asset) => asset.id)]),
    [
      ["instagram-3", 4, ["asset.short-ko"]],
      ["facebook-3", 5, []],
    ],
  );
  // The 2026-11-01 run is a Sunday in Brisbane: the week began on the Monday before.
  assert.deepEqual(planInput.week, { start: "2026-10-26", end: "2026-11-01" });

  const report = marketingGeneratorReportSchema.parse(seen.reports[0]);
  assert.equal(marketingGeneratorReportProvenanceMatches(SECRET, report), true);
  const strategy = report.analysis.strategy;
  assert.equal(strategy.weekStart, "2026-10-26");
  assert.deepEqual(
    strategy.accounts.map((plan) => [plan.accountSlug, plan.posts, plan.days, plan.claimIds, plan.assetIds]),
    [
      ["instagram-3", 4, ["tue", "thu", "sat", "sun"], ["claim.review-three-models"], ["asset.short-ko"]],
      ["facebook-3", 2, ["mon", "wed"], ["claim.review-three-models"], []],
    ],
  );
  // The plan stays with the analysis: A5's brief is the topic and claims alone.
  assert.deepEqual(Object.keys(report.payload).sort(), ["claimIds", "sourceDigests", "topicIds"]);
});

test("an unusable plan leaves the brief recorded without one", async () => {
  for (const content of [answered({ headline: "x" }), answered({ ...PLAN, accounts: [PLAN.accounts[2]] })]) {
    const { deps, seen } = ports({ ctx: PLAN_CONTEXT, answers: [answered(SELF), answered(COMPETITIVE), content] });
    const summary = await runMarketingAnalysisCycle({ generatorRunId: "run-1", deadlineAt: DEADLINE, market: MARKET }, deps);
    assert.equal(summary.strategy, "unusable");
    assert.deepEqual(summary.report, { httpStatus: 200, status: "recorded" });
    assert.equal(seen.reports[0].analysis.strategy, undefined);
  }
});

test("a plan is not asked for when this week has one, or when the run has no time left for it", async () => {
  const notDue = ports({ ctx: { ...PLAN_CONTEXT, analysis: { enabled: true, strategyDue: false } } });
  const first = await runMarketingAnalysisCycle({ generatorRunId: "run-1", deadlineAt: DEADLINE, market: MARKET }, notDue.deps);
  assert.equal(first.calls, 2);
  assert.equal(first.strategy, "not_due");

  // Enough for the two analysis calls, not for a third and the report after it.
  const tight = ports({ ctx: PLAN_CONTEXT });
  const deadlineAt = new Date(NOW + 100_000).toISOString();
  const second = await runMarketingAnalysisCycle({ generatorRunId: "run-1", deadlineAt, market: MARKET }, tight.deps);
  assert.equal(second.calls, 2);
  assert.equal(second.strategy, "no_time");
  assert.deepEqual(second.report, { httpStatus: 200, status: "recorded" });
});

test("a refused plan call stops the run as the analysis calls do", async () => {
  const refused = { status: "refused", stage: "reserve", code: "monthly_cap" };
  const { deps, seen } = ports({ ctx: PLAN_CONTEXT, answers: [answered(SELF), answered(COMPETITIVE), refused] });
  const summary = await runMarketingAnalysisCycle({ generatorRunId: "run-1", deadlineAt: DEADLINE, market: MARKET }, deps);
  assert.deepEqual(summary.stoppedAt, { stage: "llm", detail: "reserve:monthly_cap" });
  assert.equal(seen.reports.length, 0);
});

// The morning report (owner request 2026-11-03): a call at every run, from
// the app's counts; the figures are code's, the sentences the model's.

const OPERATIONS = {
  measurement: {
    dispatch: { sent: 0, published: 0, failed: 0, verified: 0 },
    queue: { pendingApproval: 9, approvedWaiting: 3, nextApprovalExpiryAt: "2026-11-30T07:02:00.000Z", scheduled: 0 },
    touches: 0,
    signups: { total: 2, attributed: 0 },
    guestLeads: null,
    llm: { calls: 90, countedMicroUsd: 12_340_000, capUsd: 100 },
    accounts: [{ accountSlug: "instagram-3", status: "approval_mode" }],
  },
  switches: { publishEnabled: false, draftsEnabled: true, autoPublishEnabled: false },
};

const MORNING = {
  verdict: "아직 나간 게시물이 없습니다. 게시 스위치를 켜는 것이 오늘 가장 큰 일입니다.",
  decisions: [
    { title: "승인된 3건 게시", why: "게시 스위치가 꺼져 있습니다.", section: "queue" },
    { title: "없는 섹션", why: "x", section: "settings" },
  ],
  worked: "발송이 0건이라 판단할 수 없습니다.",
  adjust: [
    { action: "stop", what: "경쟁사 이름", why: "Guard 표시 22건" },
    { action: "pause", what: "x", why: "y" },
  ],
  marketChanges: [
    { competitorId: "poe", change: "연간 요금 변경", action: "행동 없음" },
    { competitorId: "made-up", change: "x", action: "y" },
  ],
};

const MORNING_CONTEXT = context({
  operations: OPERATIONS,
  marketPrices: [{ reportCreatedAt: "2026-11-01T21:06:05.093Z", prices: [{ competitorId: "poe", factType: "plan_price_annual", value: { kind: "money", currency: "GBP", amountMinor: 4999 } }] }],
});

test("with counts in the context, a morning call writes the report the brief carries, figures counted by code", async () => {
  const { deps, seen } = ports({ ctx: MORNING_CONTEXT, answers: [answered(SELF), answered(COMPETITIVE), answered(MORNING)] });
  const summary = await runMarketingAnalysisCycle({ generatorRunId: "run-1", deadlineAt: DEADLINE, market: MARKET }, deps);
  assert.equal(summary.calls, 3);
  assert.equal(summary.morning, "recorded");
  assert.equal(summary.strategy, "not_due");

  const input = JSON.parse(seen.calls[2].messages[1].content);
  assert.equal(input.date, "2026-11-01");
  assert.equal(input.operations.measurement.queue.pendingApproval, 9);
  assert.equal(input.marketPrices.length, 1);
  assert.equal(input.brief.topicId, "side-by-side-answers");

  const report = marketingGeneratorReportSchema.parse(seen.reports[0]);
  assert.equal(marketingGeneratorReportProvenanceMatches(SECRET, report), true);
  const morning = report.analysis.morning;
  assert.deepEqual(morning.decisions.map((entry) => entry.section), ["queue"]);
  assert.deepEqual(morning.adjust.map((entry) => entry.action), ["stop"]);
  assert.deepEqual(morning.marketChanges.map((entry) => entry.competitorId), ["poe"]);
  assert.deepEqual(morning.figures, {
    published7d: 0,
    sent7d: 0,
    failed7d: 0,
    pendingApproval: 9,
    approvedWaiting: 3,
    nextApprovalExpiryAt: "2026-11-30T07:02:00.000Z",
    touches7d: 0,
    signupsAttributed7d: 0,
    llmCountedMicroUsd: 12_340_000,
    llmCapUsd: 100,
    publishEnabled: false,
  });
  // Nothing of it reaches A5's brief.
  assert.deepEqual(Object.keys(report.payload).sort(), ["claimIds", "sourceDigests", "topicIds"]);
});

test("an unusable morning answer leaves the brief recorded without it; a refused call stops the run", async () => {
  const unusable = ports({ ctx: MORNING_CONTEXT, answers: [answered(SELF), answered(COMPETITIVE), answered({ verdict: "" })] });
  const first = await runMarketingAnalysisCycle({ generatorRunId: "run-1", deadlineAt: DEADLINE, market: MARKET }, unusable.deps);
  assert.equal(first.morning, "unusable");
  assert.deepEqual(first.report, { httpStatus: 200, status: "recorded" });
  assert.equal(unusable.seen.reports[0].analysis.morning, undefined);

  const refused = { status: "refused", stage: "reserve", code: "monthly_cap" };
  const stopped = ports({ ctx: MORNING_CONTEXT, answers: [answered(SELF), answered(COMPETITIVE), refused] });
  const second = await runMarketingAnalysisCycle({ generatorRunId: "run-1", deadlineAt: DEADLINE, market: MARKET }, stopped.deps);
  assert.deepEqual(second.stoppedAt, { stage: "llm", detail: "reserve:monthly_cap" });
  assert.equal(stopped.seen.reports.length, 0);
});

test("the plan and the morning report both run at the first run of a week, plan first", async () => {
  const ctx = { ...PLAN_CONTEXT, operations: OPERATIONS, marketPrices: [] };
  const { deps, seen } = ports({ ctx, answers: [answered(SELF), answered(COMPETITIVE), answered(PLAN), answered(MORNING)] });
  const summary = await runMarketingAnalysisCycle({ generatorRunId: "run-1", deadlineAt: DEADLINE, market: MARKET }, deps);
  assert.equal(summary.calls, 4);
  assert.equal(summary.strategy, "recorded");
  assert.equal(summary.morning, "recorded");
  const morningInput = JSON.parse(seen.calls[3].messages[1].content);
  assert.equal(morningInput.brief.plan.headline, PLAN.headline);
});
