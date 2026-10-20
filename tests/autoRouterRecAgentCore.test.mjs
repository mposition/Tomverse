import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_ROUTER_REC_AGENT_SECRET_ENV,
  isAutoRouterRecAgentAuthorized,
  parseRecAgentSwitch,
} from "../lib/autoRouterRecAgentCore.ts";
import {
  REC_AGENT_LEASE_MS,
  actionableRecommendations,
  admitRecommendationPrUrl,
  displayedRecommendationStatus,
  nextClaimableRecommendation,
  openRecommendations,
  recommendationResultDecision,
  recommendationStatusEntries,
  withRecommendationStatus,
} from "../lib/autoRouterRecommendationsCore.ts";

const NOW = Date.parse("2026-10-20T10:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

const summaryWith = (recommendations, recommendationStatus) => ({
  report: { findings: ["router timeouts are frequent"], recommendations },
  ...(recommendationStatus ? { recommendationStatus } : {}),
});

const code = (text) => ({ kind: "code", text });
const setting = (text) => ({ kind: "setting", text });
const guidance = (text) => ({ kind: "guidance", text });

test("only the bearer of a long enough shared secret is the coding agent", () => {
  const secret = "s".repeat(40);
  const env = { [AUTO_ROUTER_REC_AGENT_SECRET_ENV]: secret };
  assert.equal(isAutoRouterRecAgentAuthorized(`Bearer ${secret}`, env), true);
  assert.equal(isAutoRouterRecAgentAuthorized(`Bearer ${secret}x`, env), false);
  assert.equal(isAutoRouterRecAgentAuthorized(secret, env), false);
  assert.equal(isAutoRouterRecAgentAuthorized(null, env), false);
  assert.equal(isAutoRouterRecAgentAuthorized("Bearer ", env), false);
  // An unset or short secret admits nobody, not everybody.
  assert.equal(isAutoRouterRecAgentAuthorized("Bearer ", {}), false);
  assert.equal(isAutoRouterRecAgentAuthorized("Bearer short", { [AUTO_ROUTER_REC_AGENT_SECRET_ENV]: "short" }), false);
});

test("the agent switch is on only when stored on", () => {
  assert.equal(parseRecAgentSwitch(JSON.stringify({ enabled: true })), true);
  assert.equal(parseRecAgentSwitch(JSON.stringify({ enabled: "true" })), false);
  assert.equal(parseRecAgentSwitch("not json"), false);
  assert.equal(parseRecAgentSwitch(null), false);
  assert.equal(parseRecAgentSwitch(undefined), false);
});

test("a PR link is admitted only for the one repository", () => {
  assert.equal(
    admitRecommendationPrUrl("https://github.com/mposition/Tomverse/pull/2831"),
    "https://github.com/mposition/Tomverse/pull/2831"
  );
  for (const bad of [
    "https://github.com/mposition/Tomverse/pull/0",
    "https://github.com/someone/Tomverse/pull/1",
    "https://github.com/mposition/Tomverse/pull/12/files",
    "http://github.com/mposition/Tomverse/pull/1",
    "https://github.com.evil/mposition/Tomverse/pull/1",
    "javascript:alert(1)",
    42,
  ]) {
    assert.equal(admitRecommendationPrUrl(bad), null, String(bad));
  }
});

test("a claim shows as claimed during its lease and as needs_lookup after, never as open", () => {
  const claimed = { status: "claimed", at: iso(NOW), by: "auto-router-rec-agent", leaseUntil: iso(NOW + REC_AGENT_LEASE_MS) };
  assert.equal(displayedRecommendationStatus(claimed, NOW + 1000), "claimed");
  assert.equal(displayedRecommendationStatus(claimed, NOW + REC_AGENT_LEASE_MS), "needs_lookup");
  assert.equal(displayedRecommendationStatus({ ...claimed, leaseUntil: undefined }, NOW), "needs_lookup");
  assert.equal(displayedRecommendationStatus(undefined, NOW), "open");
  // An expired claim is still in the inbox for a person to look at.
  const summary = summaryWith([code("retry on a same-credit model")], { 0: claimed });
  const later = NOW + REC_AGENT_LEASE_MS + 1;
  assert.equal(actionableRecommendations(summary, later)[0].status, "needs_lookup");
  assert.equal(openRecommendations([{ id: "c1", createdAt: iso(NOW), summary }], later).length, 1);
});

test("the agent takes the oldest open code recommendation, never a setting, guidance or a taken one", () => {
  const older = {
    id: "older",
    createdAt: iso(NOW - 2 * 86_400_000),
    summary: summaryWith(
      [guidance("prefer terra"), setting("raise the timeout"), code("first code"), code("second code")],
      { 2: { status: "done", at: iso(NOW), by: "u1" } }
    ),
  };
  const newer = {
    id: "newer",
    createdAt: iso(NOW - 86_400_000),
    summary: summaryWith([code("newer code")]),
  };
  const first = nextClaimableRecommendation([newer, older], NOW);
  assert.equal(first?.cycleId, "older");
  assert.equal(first?.index, 3);
  assert.equal(first?.text, "second code");

  const taken = {
    ...older,
    summary: withRecommendationStatus(older.summary, 3, {
      status: "claimed",
      at: iso(NOW),
      by: "auto-router-rec-agent",
      leaseUntil: iso(NOW + REC_AGENT_LEASE_MS),
    }),
  };
  assert.equal(nextClaimableRecommendation([newer, taken], NOW)?.cycleId, "newer");
  // An expired claim is needs_lookup, so it is not offered again either.
  assert.equal(nextClaimableRecommendation([taken], NOW + REC_AGENT_LEASE_MS + 1), null);
  assert.equal(nextClaimableRecommendation([], NOW), null);
});

test("only the claim a result names takes it; the same result again is a replay; anything else is refused", () => {
  const CLAIM = "11111111-1111-4111-8111-111111111111";
  const claimed = { status: "claimed", at: iso(NOW), by: "auto-router-rec-agent", leaseUntil: iso(NOW - 1), claimId: CLAIM };
  const pr = { claimId: CLAIM, outcome: "pr_opened", prUrl: "https://github.com/mposition/Tomverse/pull/9" };
  const failed = { claimId: CLAIM, outcome: "failed", reason: "tests" };
  // A late result of an earlier claim never lands on a later one.
  const earlier = "22222222-2222-4222-8222-222222222222";
  assert.equal(recommendationResultDecision(claimed, { ...pr, claimId: earlier }), "not_claimed");
  assert.equal(recommendationResultDecision({ ...claimed, claimId: undefined }, pr), "not_claimed");
  // An expired claim still takes the result: it is what happened.
  assert.equal(recommendationResultDecision(claimed, pr), "apply");
  assert.equal(recommendationResultDecision(claimed, failed), "apply");
  const opened = { status: "pr_opened", at: iso(NOW), by: "auto-router-rec-agent", prUrl: pr.prUrl, claimId: CLAIM };
  assert.equal(recommendationResultDecision(opened, pr), "replay");
  assert.equal(recommendationResultDecision(opened, { ...pr, prUrl: `${pr.prUrl}0` }), "not_claimed");
  assert.equal(recommendationResultDecision(opened, failed), "not_claimed");
  assert.equal(recommendationResultDecision(opened, { ...pr, claimId: earlier }), "not_claimed");
  const fail = { status: "failed", at: iso(NOW), by: "auto-router-rec-agent", reason: "tests", claimId: CLAIM };
  assert.equal(recommendationResultDecision(fail, failed), "replay");
  assert.equal(recommendationResultDecision(fail, { claimId: CLAIM, outcome: "failed", reason: "timeout" }), "not_claimed");
  // An operator's reopen or close is never overwritten.
  assert.equal(recommendationResultDecision(undefined, pr), "not_claimed");
  assert.equal(recommendationResultDecision({ status: "open", at: iso(NOW), by: "u1" }, pr), "not_claimed");
  assert.equal(recommendationResultDecision({ status: "dismissed", at: iso(NOW), by: "u1" }, pr), "not_claimed");
});

test("stored agent fields round-trip, and a reason outside the closed list is dropped", () => {
  const summary = summaryWith([code("x")], {
    0: { status: "failed", at: iso(NOW), by: "auto-router-rec-agent", reason: "free text from somewhere" },
  });
  const entry = recommendationStatusEntries(summary).get(0);
  assert.equal(entry?.status, "failed");
  assert.equal(entry?.reason, undefined);
  const opened = summaryWith([code("x")], {
    0: { status: "pr_opened", at: iso(NOW), by: "auto-router-rec-agent", prUrl: "https://github.com/mposition/Tomverse/pull/5" },
  });
  assert.equal(actionableRecommendations(opened, NOW)[0].prUrl, "https://github.com/mposition/Tomverse/pull/5");
});
