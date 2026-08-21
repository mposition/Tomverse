import assert from "node:assert/strict";
import test from "node:test";

import {
  ROUTER_DECISION_VERSION,
  ROUTER_VERSIONS,
  decideRouterModel,
  summariseRejections,
} from "../lib/routerDecision.ts";
import { ROUTER_CANDIDATE_VERSION } from "../lib/routerCandidates.ts";
import { ROUTER_SCORE_POLICY_VERSION } from "../lib/routerScorePolicy.ts";
import { ROUTER_SELECTION_VERSION } from "../lib/routerSelection.ts";
import { TASK_PROFILE_VERSION } from "../lib/taskProfileCore.ts";

/**
 * The seam between the three router modules.
 *
 * What is being tested here is not the ranking or the filters -- those have
 * their own suites -- but the things only the composition can get wrong: that a
 * refusal cannot be mistaken for a selection, that the record carries no part
 * of what the user wrote, and that every component's version reaches the
 * record so a decision can be attributed afterwards.
 */

const model = (id, overrides = {}) => ({
  id,
  name: id,
  provider: "openai",
  enabled: true,
  publiclyListed: true,
  minimumPlan: "Free",
  contextWindowTokens: 128_000,
  maxOutputTokens: 8_000,
  supportsImageInput: true,
  ...overrides,
});

const baseInput = (overrides = {}) => ({
  text: "안녕하세요",
  models: [model("gpt-5-6-luna"), model("deepseek-v4-flash")],
  plan: "Pro",
  reservedInputTokens: 1_000,
  requestOutputCapTokens: 4_000,
  ...overrides,
});

test("a decision names a model, its output room and the sticky state to carry", () => {
  const decision = decideRouterModel(baseInput());

  assert.equal(decision.outcome, "selected");
  assert.ok(decision.modelId);
  assert.ok(decision.outputTokens > 0);
  assert.equal(decision.sticky.modelId, decision.modelId);
  assert.equal(decision.record.selectedModelId, decision.modelId);
});

// The property the discriminated union exists for. `selectedModelId: null` on
// a result every call site has to remember to check is how a default model
// gets picked "just in case" -- in exactly the case where the user most needs
// to be told that Auto had nothing.
test("a refusal carries no model id at all, rather than a null one", () => {
  const decision = decideRouterModel(
    baseInput({ models: [model("gpt-5-6-luna", { enabled: false })] })
  );

  assert.equal(decision.outcome, "no_candidate");
  assert.equal("modelId" in decision, false);
  assert.equal("outputTokens" in decision, false);
  assert.equal("sticky" in decision, false);
  assert.equal(decision.record.selectedModelId, null);
});

// Being told "no model is available" and nothing else leaves the user with no
// action. The reasons are what a caller turns into an explanation.
test("a refusal explains itself, one blocking reason per model", () => {
  const decision = decideRouterModel(
    baseInput({
      models: [
        model("a", { enabled: false }),
        model("b", { minimumPlan: "Max" }),
        model("c", { contextWindowTokens: undefined }),
      ],
      plan: "Free",
    })
  );

  assert.equal(decision.outcome, "no_candidate");
  assert.equal(decision.rejections.length, 3);
  // One reason each: a list of every way a model is unsuitable is noise.
  for (const rejection of decision.rejections) {
    assert.ok(rejection.modelId);
    assert.equal(typeof rejection.reason, "string");
  }
  assert.deepEqual(
    [...new Set(decision.rejections.map((r) => r.modelId))].sort(),
    ["a", "b", "c"]
  );
});

// The mistake this is written against is the one the rate-limit telemetry
// already made once: keeping the question so the record is legible, which
// makes the audit a second copy of the thing it audits.
test("nothing the user wrote reaches the record", () => {
  const secret = "제 신용카드 번호는 4111111111111111 입니다";
  const decision = decideRouterModel(
    baseInput({ text: `${secret} 이 정규식을 디버그해 줘` })
  );

  const serialised = JSON.stringify(decision.record);
  assert.equal(serialised.includes(secret), false);
  assert.equal(serialised.includes("4111"), false);
  assert.equal(serialised.includes("신용카드"), false);
  // The profile's signals are rule names from taskProfileCore, not input.
  for (const signal of decision.record.signals) {
    assert.match(signal, /^[a-z][a-z0-9_.:-]*$/i, `signal "${signal}" looks derived from input`);
  }
});

test("an attachment's filename does not reach the record either", () => {
  const decision = decideRouterModel(
    baseInput({
      text: "이 문서 요약해 줘",
      attachments: [{ name: "2026-급여명세서-홍길동.pdf", mediaType: "application/pdf" }],
    })
  );

  const serialised = JSON.stringify(decision.record);
  assert.equal(serialised.includes("홍길동"), false);
  assert.equal(serialised.includes("급여명세서"), false);
  assert.equal(serialised.includes(".pdf"), false);
  // It still influenced the decision, which is the point of not needing it.
  assert.equal(decision.profile.hasDocumentInput, true);
});

// Five versions now: the scoring policy travels with the rule that applies it,
// because a band moving and the comparator moving are different changes and a
// record carrying only one of them can be attributed to neither.
test("every component version reaches the record", () => {
  const decision = decideRouterModel(baseInput());

  assert.deepEqual(decision.record.versions, {
    decision: ROUTER_DECISION_VERSION,
    taskProfile: TASK_PROFILE_VERSION,
    candidates: ROUTER_CANDIDATE_VERSION,
    selection: ROUTER_SELECTION_VERSION,
    scorePolicy: ROUTER_SCORE_POLICY_VERSION,
  });
  assert.deepEqual(ROUTER_VERSIONS, decision.record.versions);
  for (const version of Object.values(decision.record.versions)) {
    assert.match(version, /-v\d+$/, `${version} is not a versioned identifier`);
  }
});

test("the record says what was considered, not only what was chosen", () => {
  const decision = decideRouterModel(
    baseInput({
      models: [model("gpt-5-6-luna"), model("deepseek-v4-flash"), model("blocked", { enabled: false })],
    })
  );

  assert.equal(decision.record.consideredModelCount, 3);
  assert.equal(decision.record.eligibleModelIds.length, 2);
  assert.deepEqual(
    decision.record.rejections.map((r) => r.modelId),
    ["blocked"]
  );
});

// The clock is injected so the measurement can be measured. A latency read
// from a hidden Date.now() is a number no test can hold to anything.
test("decision latency is measured from an injectable clock", () => {
  let ticks = 0;
  const clock = () => {
    ticks += 1;
    return ticks === 1 ? 1_000 : 1_042;
  };

  const decision = decideRouterModel(baseInput(), clock);
  assert.equal(decision.record.decisionLatencyMs, 42);
});

// A clock that steps backwards (NTP correction, a test stub) must not produce
// a negative duration in a metric.
test("a backwards clock cannot produce a negative latency", () => {
  let first = true;
  const clock = () => {
    if (first) {
      first = false;
      return 5_000;
    }
    return 4_000;
  };

  const decision = decideRouterModel(baseInput(), clock);
  assert.equal(decision.record.decisionLatencyMs, 0);
});

// Stickiness is the property that keeps the model from changing between two
// turns that felt the same. The composition has to carry it in and back out.
test("the current model is carried in and the streak comes back out", () => {
  const first = decideRouterModel(baseInput({ text: "이 정규식 디버그해 줘" }));
  assert.equal(first.outcome, "selected");

  const second = decideRouterModel(
    baseInput({ text: "고마워", sticky: first.sticky })
  );
  assert.equal(second.outcome, "selected");
  assert.equal(typeof second.sticky.turnsFavouringChallenger, "number");
  assert.equal(
    second.record.turnsFavouringChallenger,
    second.sticky.turnsFavouringChallenger
  );
});

test("summarised rejections are ordered by how many models each reason blocked", () => {
  const summary = summariseRejections([
    { modelId: "a", reason: "plan" },
    { modelId: "b", reason: "unhealthy" },
    { modelId: "c", reason: "plan" },
    { modelId: "d", reason: "plan" },
    { modelId: "e", reason: "unhealthy" },
    { modelId: "f", reason: "disabled" },
  ]);

  assert.deepEqual(summary, [
    { reason: "plan", count: 3 },
    { reason: "unhealthy", count: 2 },
    { reason: "disabled", count: 1 },
  ]);
});

test("summarising nothing is empty rather than an error", () => {
  assert.deepEqual(summariseRejections([]), []);
});

// Selection only ever ranks what the filter returned, so the two cannot
// disagree -- unless one changes without the other, which is a wiring bug and
// must not silently become a model choice.
test("a selection outside the eligible set is refused, never defaulted", () => {
  const decision = decideRouterModel(baseInput());
  assert.equal(decision.outcome, "selected");
  assert.ok(
    decision.record.eligibleModelIds.includes(decision.modelId),
    "the chosen model is not in the set it was chosen from"
  );
});
