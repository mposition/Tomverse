import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShadowReport } from "@/components/admin/AdminRoutingShadowPanel";
import {
  AutoRouterOverviewView,
  autoRouterKindShares,
  autoRouterShadowSplit,
} from "@/components/admin/routing/AutoRouterOverview";
import { optimizerCycleTone } from "@/components/admin/routing/optimizerTone";
import { adminRoutingScreensMessages } from "@/lib/adminMessages/routingScreens";
import { OptimizerEvidenceView } from "@/components/admin/OptimizerEvidenceView";
import { verifiedOptimizerSummary } from "../fixtures/optimizerVerifiedSummary";
import { ChatServingCostView, CostEfficiencyDiagnosticView } from "@/components/admin/CostEfficiencyDiagnosticView";
import { COST_EFFICIENCY_CRITERIA, costEfficiencyReport } from "@/lib/autoCostEfficiencyReport";
import { summarizeChatServingCost } from "@/lib/autoChatServingCostCore";
import { optimizerSpend } from "@/lib/autoOptimizerCost";
import { costEfficiencyMessages } from "@/lib/adminMessages/costEfficiency";
import { adminAutoRouterOptimizerMessages } from "@/lib/adminMessages/autoRouterOptimizer";

const report = (overrides: Partial<ShadowReport> = {}): ShadowReport => ({
  windowDays: 7,
  since: "2026-11-01T00:00:00.000Z",
  truncated: false,
  rows: 120,
  decided: 100,
  undecided: 20,
  agreed: 64,
  agreementRate: 0.64,
  versions: {
    taskProfileVersions: [],
    candidateFilterVersions: [],
    selectionVersions: [],
    selectionPolicyVersions: [],
    mixed: false,
  },
  switches: [],
  byTaskKind: [
    { key: "coding", decided: 40, agreed: 30, agreementRate: 0.75 },
    { key: "writing", decided: 30, agreed: 20, agreementRate: 0.6667 },
    { key: "general", decided: 30, agreed: 14, agreementRate: 0.4667 },
    { key: "research", decided: 0, agreed: 0, agreementRate: null },
  ],
  byPlan: [],
  selectionReasons: {},
  rejectionReasons: {},
  decisionMicrosP50: 200_000,
  decisionMicrosP95: 310_000,
  ...overrides,
});

const view = (props: Partial<Parameters<typeof AutoRouterOverviewView>[0]> = {}) =>
  renderToStaticMarkup(
    <AutoRouterOverviewView
      router="off"
      report={report()}
      failed={false}
      loading={false}
      onRetry={() => {}}
      {...props}
    />
  );

test("kind shares are portions of what was decided, largest first, without empty kinds", () => {
  const shares = autoRouterKindShares(report());
  assert.deepEqual(shares.map((row) => row.key), ["coding", "writing", "general"]);
  assert.equal(shares[0].share, 0.4);
  assert.ok(Math.abs(shares.reduce((sum, row) => sum + row.share, 0) - 1) < 1e-9);
  assert.deepEqual(autoRouterKindShares(report({ byTaskKind: [] })), []);
});

test("optimizer rendering separates known cost, incomplete total, credit ratio and own/proxy evidence", async () => {
  const summary = await verifiedOptimizerSummary();
  const html = renderToStaticMarkup(<OptimizerEvidenceView spentMicroUsd={120} summary={{
    ...summary, candidateCredits: 13.2,
    costCoverage: { ...summary.costCoverage, complete: false, unknownCalls: 1,
      calls: [{ kind: "answer", provider: "p", failed: true, state: "unknown", dispatch: "unknown", reason: "exception" }] },
    quality: { status: "unmeasured" },
    gate: { basis: "direct" },
    evidence: { ownAnswerCases: 2, proxyTowardWinner: 3, proxyTowardLoser: 1, orderDisagreements: 1 },
  }} />);
  assert.match(html, /Recorded optimizer cost/);
  assert.match(html, /0\.000120/);
  assert.match(html, /Total optimizer cost unconfirmed/);
  assert.match(html, /Catalog credit ratio/);
  assert.match(html, /1\.100/);
  assert.match(html, /evaluation incomplete/);
  assert.match(html, /2 own answer comparisons/);
  assert.match(html, /proxy toward winner 3, loser 1/);
  assert.match(html, /answer\/exception: 1/);
  assert.doesNotMatch(html, /invoice|saving|gate failed/i);
  const legacy = renderToStaticMarkup(<OptimizerEvidenceView spentMicroUsd={0} summary={null} />);
  assert.match(legacy, /Holdout and cost coverage unverified/);
  assert.match(legacy, /Total optimizer cost unconfirmed/);
  const complete = renderToStaticMarkup(<OptimizerEvidenceView spentMicroUsd={2} summary={summary} />);
  assert.doesNotMatch(complete, /Total optimizer cost unconfirmed|Holdout and cost coverage unverified/);
  assert.doesNotMatch(complete, /upper bound/);
  // Calls that ended in an exception are shown as an upper bound included in the recorded cost, not as unknown.
  const bounded = renderToStaticMarkup(<OptimizerEvidenceView spentMicroUsd={1_575} summary={{
    ...summary, costCoverage: { ...summary.costCoverage, boundedCalls: 1, boundedMicroUsd: 1_575 },
  }} />);
  assert.match(bounded, /1 calls ended in an exception and are counted at their upper bound, US\$0\.001575, included in the cost above/);
  assert.doesNotMatch(bounded, /Total optimizer cost unconfirmed/);
});

test("the shadow split is agreed, moved and no-candidate, and is null when nothing was recorded", () => {
  const split = autoRouterShadowSplit(report());
  assert.ok(split);
  assert.deepEqual(split.parts.map((part) => [part.key, part.count]), [
    ["agreed", 64],
    ["switched", 36],
    ["noCandidate", 20],
  ]);
  assert.equal(split.total, 120);
  assert.equal(autoRouterShadowSplit(report({ decided: 0, undecided: 0, agreed: 0 })), null);
});

test("the overview draws the flow, four numbers and the split from the shadow report", () => {
  const html = view();
  assert.match(html, /data-testid="admin-auto-router-flow-question"/);
  assert.match(html, /data-testid="admin-auto-router-flow-router"/);
  assert.match(html, /Coding/);
  assert.match(html, /40\.0%/);
  assert.equal(html.match(/<p class="text-sm font-medium text-zinc-400">/g)?.length, 4);
  assert.match(html, /310\.0ms/);
  assert.match(html, /data-testid="admin-auto-router-shadow-summary"/);
  assert.match(html, /role="img" aria-label="Auto would have chosen the same model 53\.3%/);
  // The router is off: the flow says so rather than naming a model.
  assert.match(html, /data-tone="idle"[^>]*>Off</);
});

test("a chosen router model is named in the flow", () => {
  const html = view({ router: { id: "gpt-6-luna", name: "GPT 6 Luna", provider: "openai" } });
  assert.match(html, />GPT 6 Luna</);
  assert.match(html, /data-tone="ok"[^>]*>On</);
});

test("an unread router setting is unknown, never off", () => {
  const html = view({ router: "unknown" });
  assert.match(html, /data-tone="unknown"/);
  assert.doesNotMatch(html, /data-tone="idle"/);
});

test("a failed shadow read is an alert with a retry and every number is unavailable, not zero", () => {
  const html = view({ report: null, failed: true });
  assert.match(html, /role="alert"/);
  assert.match(html, /Try again/);
  assert.equal(html.match(/data-unread="true"/g)?.length, 4);
  assert.doesNotMatch(html, />0</);
});

test("an empty window says so instead of drawing an empty bar", () => {
  const html = view({ report: report({ rows: 0, decided: 0, undecided: 0, agreed: 0, byTaskKind: [] }) });
  assert.match(html, /No decisions were recorded in this window/);
  assert.doesNotMatch(html, /role="img"/);
});

test("optimizer cycle statuses map to tones and an unknown status is idle", () => {
  assert.equal(optimizerCycleTone("running"), "info");
  assert.equal(optimizerCycleTone("passed"), "ok");
  assert.equal(optimizerCycleTone("failed"), "warn");
  assert.equal(optimizerCycleTone("error"), "bad");
  assert.equal(optimizerCycleTone("diagnostic"), "info");
  assert.equal(optimizerCycleTone("something-new"), "idle");
});

test("the routing screen copy has the same keys in English and Korean and no Korean in English", () => {
  const keys = (value: unknown, prefix = ""): string[] =>
    value && typeof value === "object"
      ? Object.entries(value).flatMap(([key, child]) => keys(child, `${prefix}${key}.`))
      : [prefix];
  assert.deepEqual(keys(adminRoutingScreensMessages.ko), keys(adminRoutingScreensMessages.en));
  assert.doesNotMatch(JSON.stringify(adminRoutingScreensMessages.en), /[^\x00-\x7F]/);
});

test("a cost-efficiency diagnostic shows price-blind quality, credits, observed and experiment cost, and why it is not applicable", () => {
  const known = (microUsd: number) => ({ state: "known" as const, microUsd, attempts: 1, failedAttempts: 0 });
  const spend = optimizerSpend(1_000).totals();
  const report = costEfficiencyReport({
    comparisons: [{
      kind: "easy", a: "premium", b: "cheap", verdict: "tie", answerMs: { a: 900, b: 400 },
      costEfficiency: {
        basis: "lower_credit", credits: { a: 9, b: 1 }, estimatedMicroUsd: { a: 200, b: 10 },
        answerCost: { a: known(100), b: known(5) }, quality: "equal", qualityOrders: [null, null],
        constraintFailure: { a: false, b: false }, truncated: { a: false, b: false },
      },
    }, { kind: "hard", a: "cheap", b: null, verdict: "no_alternative" }],
    cases: [], coverage: spend.costCoverage, spentByKind: spend.spentByKind,
    criteria: { ...COST_EFFICIENCY_CRITERIA, status: "proposed_unconfirmed" }, failure: null, summary: undefined,
  });
  const html = renderToStaticMarkup(<CostEfficiencyDiagnosticView report={report} />);
  assert.ok(html.includes("Cost-efficiency diagnostic (diagnostic only)"));
  assert.match(html, /1 savings samples/);
  assert.match(html, /equal 1/);
  assert.match(html, /a credit change is not a saving/);
  assert.ok(html.includes("US$0.000100 → US$0.000005"));
  assert.match(html, /Not applicable as guidance:.*diagnostic only.*criteria not yet confirmed.*too few savings samples/);
  // Model-free totals: no model id reaches the diagnostic block.
  assert.doesNotMatch(html, /\bpremium\b|\bcheap\b/);
  assert.equal(renderToStaticMarkup(<CostEfficiencyDiagnosticView report={undefined} />), "");
  // The owner-confirmed set no longer adds the unconfirmed reason.
  const confirmed = renderToStaticMarkup(<CostEfficiencyDiagnosticView report={{
    ...report, applicability: costEfficiencyReport({
      comparisons: [], cases: [], coverage: spend.costCoverage, spentByKind: spend.spentByKind,
      criteria: COST_EFFICIENCY_CRITERIA, failure: null, summary: undefined,
    }).applicability,
  }} />);
  assert.equal(COST_EFFICIENCY_CRITERIA.status, "confirmed");
  assert.doesNotMatch(confirmed, /criteria not yet confirmed/);
  assert.match(confirmed, /Not applicable as guidance:.*diagnostic only/);
  const serving = summarizeChatServingCost([], { since: "s", until: "u" });
  assert.match(renderToStaticMarkup(<ChatServingCostView summary={serving} />), /answer cost only[\s\S]*unknown, not zero/);
  assert.match(renderToStaticMarkup(<ChatServingCostView summary={null} />), /could not be read/);
});

test("the cost-efficiency and optimizer copy has the same keys in English and Korean", () => {
  const keys = (value: unknown, prefix = ""): string[] =>
    value && typeof value === "object"
      ? Object.entries(value).flatMap(([key, child]) => keys(child, `${prefix}${key}.`))
      : [prefix];
  for (const messages of [costEfficiencyMessages, adminAutoRouterOptimizerMessages]) {
    assert.deepEqual(keys(messages.ko).sort(), keys(messages.en).sort());
    assert.doesNotMatch(JSON.stringify(messages.en), /[가-힣]/);
  }
  assert.ok(adminAutoRouterOptimizerMessages.en.reasons.diagnostic_only);
  assert.ok(adminAutoRouterOptimizerMessages.ko.statuses.diagnostic);
});
