# Auto cost-efficiency diagnostic

Local implementation on `origin/develop` `dfe689790` (2026-11-23), compared
with the analysis baseline `origin/main` `5c434da84` (2026-11-22). Between the
two, the only change in the optimizer files was the synthetic menu's
signed-in file context in `autoCandidateMenu`, which this change keeps (it
moved into `buildAutoCandidateMenu`). The P0 behaviour recorded in
`docs/ops/auto-router-quality-cost-p0-validation.md` is reused, not rebuilt.

This is code behaviour and a run plan. No paid evaluation, provider call,
live optimizer cycle or production read was made. Nothing here shows that a
cheaper model is good enough or that total cost falls.

## Implemented behaviour

- **Objective.** `runOptimizerCycle` takes `objective: "chat_cost_efficiency"`.
  Absent, every target (routing, coding, rewrite) runs the existing
  routing-quality cycle unchanged. The new objective is
  `diagnostic_only` (`COST_EFFICIENCY_OBJECTIVE`, candidate policy
  `auto-cost-challenger-v1`, judge rubric `auto-quality-blind-judge-v1`).
- **Challenger.** Inside the existing one slot and the offered menu (plan,
  context, capability, health and unreliable-model filters unchanged):
  `lower_credit` first, then `lower_estimated_provider_cost` (same credits,
  lower estimate at the reserved input and 1 000 output tokens for every
  model; unpriced or fallback-priced estimates are null, never zero), else the
  existing same/next-higher draw as `quality_comparison`, which is never a
  savings sample. Ties break by credits, id and case position. No model is a
  fixed winner.
- **Judge.** The same two orders and the same ordered-judgement cache, in
  place of the price-aware judge, never in addition. It reads the bounded
  message the answering models received (up to 4 000/600 characters, head and
  tail) instead of the existing 2 000/400 excerpt that drops a long message's
  middle, and answers up to 16 000 characters with a truncation flag. No
  credits or model names. Structured `quality` A/B/equal/insufficient plus a
  constraint failure per answer. Orders combine to a/b/equal only when they
  agree; insufficient, order disagreement and a missing verdict stay
  separate. A case with an expected answer is also graded by the existing
  `router-development-exact-json-v1` grader.
- **Cost attribution.** Evaluation calls carry objective/case/model/arm/try
  identity in the existing coverage. Each answer's tries, failed tries and
  known or unknown spend are kept; a replay that reuses a direct comparison's
  answer is marked and not paid twice. Routing-cycle calls (synthesis,
  generation, router, answers, judges) are priced by
  `calculateProviderUsageCost` with the reported cache-read and cache-write
  lines -- the router call now passes its reported cache split through -- and
  an unpriced cache write is unknown. Unknown cost still stops new
  scheduling and drains in-flight work. An answer that ends in an exception
  is counted at its upper bound (`bounded`) and the run goes on; the report
  shows bounded calls and their total apart from known spend.
- **Report.** `summary.costEfficiency` (`auto-cost-efficiency-report-v1`):
  candidate diagnosis (savings samples by basis, quality tally, critical
  regressions, exact results, credits, observed answer cost pairs with
  `lower_observed_provider_cost` counts, answer latency), the frozen baseline
  against the proposal on the same holdout (changed picks only; an unchanged
  pick is not a second observation), partial serving cost (router per arm and
  changed answers; Refiner, app search, tools, attachments and Memory
  excluded), experiment cost (all calls, failed, retried, unknown, not
  started), `taskCost: unlinked`, and applicability reasons. A credit change
  or ratio is never reported as a saving.
- **Real Chat serving cost.** `readAutoChatServingCost` joins
  `AutoRouterDecision.traceId` → `ChatCreditReservation.traceId` (source
  `chat`) → `resolvedAttemptCosts`, with `RoutingRun` and the
  `${traceId}:server` latency sample, for the last 7 days (100 traces).
  Coverage is `answer_cost_only`: router tokens have no price snapshot,
  Refiner and app-managed search are unattributed, native search is inside
  the attempt cost. No new ledger and no daily-bucket inference.
- **Holdout.** The diagnostic splits by family (conversation id; a synthetic
  message alone), so a conversation never straddles the halves. Guidance is
  still frozen before any holdout call, and no current or earlier comparison
  enters the generator.
- **Replayed menus.** Every optimizer cycle (routing and diagnostic) replays
  a recorded decision's menu against today's catalogue: a candidate that is
  no longer enabled, deleted or unpriced is dropped before the router sees
  it, and a decision left with fewer than two candidates is not loaded. An
  answer that was never sent (`no_dispatch`) is not retried, and a pair
  missing either answer is counted as "without both answers", never as a
  known US$0 cost pair.
- **Boundaries.** `optimizerPromotionEligibility` refuses any summary with an
  objective or a cost-efficiency report (`diagnostic_only`), before every
  other check, for manual and system promotion; the status is `diagnostic`,
  never `passed`. The run skips `applyCycleTunableChanges` and automatic
  promotion, and `actionableRecommendations` returns nothing for it, so the
  recommendation agent and sends cannot act on it. The daily schedule never
  starts one. A person starts it from Admin › Routing only while
  `AUTO_ROUTER_COST_EFFICIENCY_DIAGNOSTIC=on` (default off), under the
  existing optimizer model approval, run/day/month ceilings and audit entry
  (`metadata.objective`). Legacy cycles, active guidance, CAS and rollback are
  unchanged. Its answer failures do not feed the routing cycle's
  unreliable-model exclusion, so the existing cycle's challenger draws are
  unchanged.
- **Admin.** Each diagnostic cycle shows the report block; the routing tile
  shows the real serving-cost report. Copy is in
  `lib/adminMessages/costEfficiency.ts` (en/ko).

## Dry run

`npm run benchmark:auto-cost-efficiency:dry-run -- [--output=NEW_PATH]
[--optimizer-model=ID] [--router-model=ID]` — local PC, PowerShell, this
repository; no database, credential, network or provider client. It builds
the manifest from the static catalogue (`lib/models.ts`; a live run's manifest
uses the runtime registry) and runs the real cycle with deterministic mock
calls over the tool-free KO/EN fixtures (`tests/fixtures/autoQualityCostCases.mjs`;
tool, freshness and long-tail delivery cases need Chat E2E) and the
development corpus (`development-v1.json`, exact answers).

Result on this commit (mock): 40 cases, 21 train / 19 holdout, 11/10
families; planned calls generate 1, route 38, answer ≤152, judge 76; worst
case US$100.09, almost all from every answer retried on the dearest model at
its output cap. The binding limit is the existing US$25 actual-spend run
ceiling. The mock's wrong calculation on the lowest tier is caught (exact
11/11 vs 10/11, one critical regression). These numbers describe the code
path only; mock quality and mock spend are not evidence.

## Run plan (paid; one dev run approved and run 2026-11-23)

Approved by the owner on 2026-11-23: one person-started diagnostic on the
**dev** environment's Admin › Routing, with the switch set on the dev
environment's web app service (`Tomverse`) only -- the Admin start and the
background run both happen in that process; the `Auto Router Optimizer` cron
service never starts a diagnostic and needs no change -- the existing optimizer
and router models, and the existing caps. Sample: recent picked decisions
plus synthetic messages to 24, family split. Before the run, the owner fixes
the criteria; the run records them and their digest; results never change
them. Values (`auto-cost-efficiency-criteria-v1`, confirmed 2026-11-23): at
least 10 savings samples, 0 critical regressions, current pick better in at
most 10% of judged savings samples, at most 20% undecided, at most 10%
cheaper-model answer failures, latency reported only, order disagreement
never counted as equal.

A small sample can report `observed_no_regression`, not non-inferiority.
After the run: read the report, then decide separately whether a guidance
change is worth an ordinary routing cycle; nothing is applied automatically.

**Dev run, 2026-11-23 20:47 AEST: not evidence.** Dev had never run with the
routing switch on, so its 24 picked decisions were old and no synthetic
messages were added. Their recorded menus still named models since retired
or disabled there (`gpt-5-4-mini`, `gpt-5-6-luna`, `gpt-5-6-terra`,
`gemini-2-5-flash`): 36 answer calls were `no_dispatch` (`model_unavailable`),
including retries, 9 answers were sent, and one pair was judged. Known spend
US$0.157, no unknown cost. Only 1 savings sample, so nothing was measured
against the criteria. The replayed-menu filter above is the fix. The owner
chose production, where the routing switch is live, for the next run; that
run needs its own approval.

**Dev run 2, 2026-11-23 22:18 AEST: not evidence.** After the replayed-menu
filter: no unsent answers, 10 savings samples (all same-credit, lower
estimated provider cost), the price-blind judge returned real verdicts. It
stopped as `cost_unknown` when two `deepseek-v4-pro` answers failed (an
`AI_APICallError` with no status after about 48 s, and the 120 s reasoning
timeout), before the guidance comparison. US$0.244. The bounded answer cost
above is the fix; deepseek-v4-pro Chat itself works in production (streamed).

## What remains unmeasured

Real model quality and cost of cheaper candidates, total serving cost
(router, Refiner, app search not attributed), task cost across regenerations,
statistical non-inferiority, invoice reconciliation, tool and attachment
paths, and any production saving. Signed-in affordability, reservation
reconciliation, prices, credits and providers are unchanged.
