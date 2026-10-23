import assert from "node:assert/strict";
import test from "node:test";
import { createScriptedAdapters, loadFixtures } from "../tools/memory-quality/mock.ts";
import { BASELINE, compare, runQualityLoop, validateCorpora } from "../tools/memory-quality/runner.ts";
import { digest } from "../tools/memory-quality/schema.ts";

const store = () => {
  const events = [];
  return { events, record: async (event) => { events.push(structuredClone(event)); }, stopped: async () => false };
};
async function run(extra = {}) {
  return runQualityLoop({ ...await loadFixtures(), ...await createScriptedAdapters(), store: store(), ...extra });
}
test("whole loop analyzes, proposes, evaluates, checks regression, freezes, validates and records", async () => {
  const log = store();
  const result = await run({ store: log });
  assert.equal(result.recommendation, "human_review_candidate", JSON.stringify(log.events));
  assert.equal(result.stopReason, "duplicate_candidate");
  assert.equal(result.promoted, false);
  assert.equal(result.paidCalls, 0);
  assert.equal(result.measuredQualityAchieved, false);
  assert.equal(result.decisionGrade, false);
  const types = log.events.map((e) => e.type);
  for (const type of ["started", "baseline", "candidate", "development_evaluation", "candidate_frozen",
    "validation_evaluation", "finished"]) assert.ok(types.includes(type), type);
  const validation = log.events.find((e) => e.type === "validation_evaluation");
  assert.equal(validation.evaluation.summary.retrieval.koreanRecallAt5, 1);
  assert.equal(validation.evaluation.summary.retrieval.irrelevantInjectionRate, 0);
  assert.equal(validation.evaluation.summary.extraction.criticalBulkSafeAdoptions, 0);
  assert.equal(validation.evaluation.summary.targetPass, false);
});
test("proposer receives development only and cannot mutate canonical gold or targets", async () => {
  const fixtures = await loadFixtures(), before = digest(fixtures);
  const adapters = await createScriptedAdapters();
  const validationIds = new Set(fixtures.validation.cases.map((row) => row.id));
  let proposals = 0, validationCalls = 0;
  const model = async (request) => {
    if (validationIds.has(request.input.caseId)) validationCalls++;
    if (request.task === "propose") {
      proposals++;
      assert.equal(validationCalls, 0);
      assert.equal(request.input.development.split, "development");
      assert.equal(request.input.validation, undefined);
      const result = await adapters.model(request);
      request.input.development.cases[0].expected = [];
      return result;
    }
    return adapters.model(request);
  };
  const result = await runQualityLoop({ ...fixtures, ...adapters, model, store: store() });
  assert.equal(result.recommendation, "human_review_candidate");
  assert.equal(digest(fixtures), before);
  assert.ok(proposals > 0);
});
test("candidate output cannot write gold, thresholds, model or authority", async () => {
  const adapters = await createScriptedAdapters();
  const result = await run({ model: async (request) => request.task === "propose"
    ? { analysis: "Attempted score manipulation", candidate: BASELINE, targets: { precision: 0 } }
    : adapters.model(request) });
  assert.equal(result.stopReason, "invalid_model_output");
  assert.equal(result.recommendation, "none");
});
test("no-op candidate terminates without exposing validation", async () => {
  const adapters = await createScriptedAdapters(), log = store();
  const result = await run({ store: log, model: async (request) => request.task === "propose"
    ? { analysis: "No change", candidate: BASELINE } : adapters.model(request) });
  assert.equal(result.stopReason, "duplicate_candidate");
  assert.equal(log.events.some((event) => event.type === "validation_evaluation"), false);
});
test("operator stop, call limit and deadline are durable terminal reasons", async () => {
  assert.equal((await run({ store: { ...store(), stopped: async () => true } })).stopReason, "operator_stop");
  assert.equal((await run({ maxCalls: 1 })).stopReason, "call_limit");
  assert.equal((await run({ timeoutMs: 25, model: async () => new Promise(() => {}) })).stopReason, "deadline");
});
test("invalid evaluation stops before proposing instead of creating an easy baseline", async () => {
  const log = store();
  const result = await run({ store: log, judge: async () => ({ candidates: [{ invalid: true }] }) });
  assert.equal(result.stopReason, "evaluation_invalid");
  assert.equal(log.events.some((event) => event.type === "candidate"), false);
  assert.equal(log.events.find((event) => event.type === "invalid_evaluation").evaluation.cases[0].extraction.failure,
    "evaluation_invalid");
});
test("case regression blocks candidate even if aggregate improves elsewhere", async () => {
  const log = store();
  await run({ store: log });
  const baseline = log.events.find((event) => event.type === "baseline").evaluation;
  const better = structuredClone(log.events.find((event) => event.type === "development_evaluation").evaluation);
  better.cases[0].extraction.goldMatched = 0;
  const result = compare(baseline, better);
  assert.equal(result.accepted, false);
  assert.ok(result.regressions.includes("recall:0"));
});
test("development and validation reject repeated ids, families and renamed duplicate source", async () => {
  for (const variant of ["id", "family", "source"]) {
    const { development, validation } = await loadFixtures();
    if (variant === "source") validation.cases[0].messages = development.cases[0].messages;
    else validation.cases[0][variant] = development.cases[0][variant];
    assert.throws(() => validateCorpora(development, validation), /split_overlap/);
  }
});
test("validation regression is recorded and never used for another proposal", async () => {
  const fixtures = await loadFixtures(), adapters = await createScriptedAdapters(), log = store();
  const validationIds = new Set(fixtures.validation.cases.map((row) => row.id));
  let exposed = false;
  const model = async (request) => {
    if (validationIds.has(request.input.caseId)) exposed = true;
    if (request.task === "propose") assert.equal(exposed, false);
    const answer = await adapters.model(request);
    if (request.task === "select" && request.input.caseId === "ko-transit" &&
        !request.system.startsWith(BASELINE.retrieval)) return { ids: ["x"] };
    return answer;
  };
  const result = await runQualityLoop({ ...fixtures, ...adapters, model, store: log });
  assert.equal(result.recommendation, "validation_rejected");
  assert.equal(log.events.filter((event) => event.type === "validation_evaluation").length, 1);
});
test("non-synthetic sources, invalid gold anchors and inactive relevance gold are rejected", async () => {
  for (const change of [
    (dev) => { dev.source = "user_memory"; },
    (dev) => { dev.cases[0].expected[0].evidence.evidenceQuote = "invented quote"; },
    (dev) => { dev.cases[0].retrieval.relevantIds = ["d"]; },
  ]) {
    const { development, validation } = await loadFixtures();
    change(development);
    assert.throws(() => validateCorpora(development, validation));
  }
});
test("a holdout tie cannot become an improved-candidate recommendation", async () => {
  const fixtures = await loadFixtures(), adapters = await createScriptedAdapters(), log = store();
  const validationIds = new Set(fixtures.validation.cases.map((row) => row.id));
  const improved = (await adapters.model({ task: "propose" })).candidate;
  const model = async (request) => {
    if (validationIds.has(request.input.caseId)) {
      if (request.task === "extract") request.system = request.system.replace(BASELINE.extraction, improved.extraction);
      if (request.task === "select") request.system = request.system.replace(BASELINE.retrieval, improved.retrieval);
    }
    return adapters.model(request);
  };
  const result = await runQualityLoop({ ...fixtures, ...adapters, model, store: log });
  assert.equal(result.recommendation, "validation_no_improvement");
});
test("passing an offline mode label never certifies an injected adapter as zero paid calls", async () => {
  const adapters = await createScriptedAdapters();
  const result = await run({ mode: "mock", model: async (request) => adapters.model(request) });
  assert.equal(result.paidCalls, null);
});
