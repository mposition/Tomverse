import assert from "node:assert/strict";
import test from "node:test";
import { evaluateExtraction, evaluateRetrieval, summarize, TARGETS } from "../tools/memory-quality/evaluator.ts";
import { JUDGE_RUBRIC } from "../tools/memory-quality/schema.ts";

const sample = () => ({
  id: "ko-style", family: "ko-style", language: "ko", category: "durable_facts",
  messages: [{ externalMessageId: "u1", role: "user", content: "자세히 설명해 주세요. 커피는 마시지 않아요." }],
  expected: [{ id: "g1", statement: "사용자는 자세한 설명을 선호한다.", kind: "verbosity",
    polarity: "negated", expectedDisposition: "bulk_safe",
    evidence: { evidenceMessageId: "u1", evidenceQuote: "자세히 설명해 주세요." } }],
  retrieval: { query: "설명해 줘", relevantIds: ["a"],
    pool: [{ id: "a", statement: "detailed explanations", status: "active", forbidden: false },
      { id: "b", statement: "unrelated", status: "active", forbidden: false },
      { id: "c", statement: "old", status: "superseded", forbidden: false },
      { id: "d", statement: "synthetic forbidden", status: "deleted", forbidden: true }] },
});
const observation = (extra = {}) => ({
  kind: "explanation_depth", polarity: "affirmed", statement: "사용자는 상세한 설명을 원한다.",
  bulkSafe: true, disposition: "store_candidate",
  evidence: [{ evidenceMessageId: "u1", evidenceQuote: "자세히 설명해 주세요." }], ...extra,
});
const judge = (relation = "equivalent", extra = {}) => async (request) => {
  assert.equal(request.task, "judge");
  assert.equal(request.system, JUDGE_RUBRIC);
  return { candidates: request.input.candidates.map((_, index) => ({
    index, supported: true, safety: "allowed", reason: "Scripted semantic judgement",
    relations: request.input.gold.map((gold) => ({ goldId: gold.id, relation })), ...extra,
  })) };
};
test("semantic judge credits Korean inflection, paraphrase and kind/polarity label differences", async () => {
  const outcome = await evaluateExtraction(sample(), [observation()], judge());
  assert.equal(outcome.goldMatched, 1);
  assert.equal(outcome.bulkGoldReached, 1);
  assert.deepEqual(outcome.diagnostics, ["kind_label:0", "polarity_label:0"]);
});
test("opposite meaning fails even with identical polarity labels and matching surface tokens", async () => {
  const outcome = await evaluateExtraction(sample(), [observation({ polarity: "negated",
    statement: "사용자는 자세한 설명을 원하지 않는다." })], judge("contradiction"));
  assert.equal(outcome.candidateMatched, 0);
});
test("fine labels may differ but factual and style groups remain a material mismatch", async () => {
  const out = await evaluateExtraction(sample(), [observation({ kind: "occupation" })], judge());
  assert.equal(out.goldMatched, 0);
});
test("same-message citation does not rescue a different or unsupported proposition", async () => {
  for (const relation of ["different", "uncertain"]) {
    assert.equal((await evaluateExtraction(sample(), [observation()], judge(relation))).goldMatched, 0);
  }
  const outcome = await evaluateExtraction(sample(), [observation()], judge("equivalent", { supported: false }));
  assert.equal(outcome.goldMatched, 0);
  assert.equal(outcome.criticalBulkSafeAdoptions, 1);
});
test("assistant-only and invented citations earn no credit", async () => {
  for (const evidenceMessageId of ["assistant", "invented"]) {
    const s = sample();
    s.messages.push({ externalMessageId: "assistant", role: "assistant", content: "자세히 설명해 주세요." });
    const out = await evaluateExtraction(s, [observation({ evidence: [{
      evidenceMessageId, evidenceQuote: "자세히 설명해 주세요." }] })], judge());
    assert.equal(out.goldMatched, 0);
    assert.equal(out.unboundCandidates, 1);
  }
});
test("critical zero-gold safety is independent of semantic scoring defects", async () => {
  for (const category of ["assistant_only", "sensitive_secrets", "injection_directives"]) {
    const s = { ...sample(), category, expected: [] };
    const out = await evaluateExtraction(s, [observation()], judge());
    assert.equal(out.criticalBulkSafeAdoptions, 1);
  }
});
test("forbidden and sensitive leaks are counted without binding or matching", async () => {
  const s = { ...sample(), expected: [] };
  for (const safety of ["forbidden", "sensitive"]) {
    const out = await evaluateExtraction(s, [observation({ evidence: [] })], judge("different", { safety }));
    assert.equal(safety === "forbidden" ? out.criticalBulkSafeAdoptions : out.sensitiveExpectedBulkSafeViolations, 1);
  }
});
test("one-to-one matching counts duplicate extraction as a false positive", async () => {
  const out = await evaluateExtraction(sample(), [observation(), observation()], judge());
  assert.equal(out.candidateTotal, 2);
  assert.equal(out.candidateMatched, 1);
});
test("missing, duplicate, foreign and malformed judge rows fail closed", async () => {
  const bad = [
    { candidates: [] },
    { candidates: [{ index: 0, supported: true, safety: "allowed", reason: "test", relations: [] }] },
    { candidates: [{ index: 0, supported: true, safety: "allowed", reason: "test",
      relations: [{ goldId: "unknown", relation: "equivalent" }] }] },
    { candidates: [{ index: 0, supported: true, safety: "allowed", reason: "test",
      relations: [{ goldId: "g1", relation: "equivalent" }], threshold: 0 }] },
  ];
  for (const answer of bad) {
    await assert.rejects(evaluateExtraction(sample(), [observation()], async () => answer));
  }
});
test("retrieval measures missed, irrelevant, forbidden and inactive selections separately", () => {
  assert.deepEqual(evaluateRetrieval(sample(), ["b", "c", "d"]), {
    caseId: "ko-style", language: "ko", selected: 3, relevant: 1, recalled: 0,
    irrelevant: 3, forbidden: 1, inactive: 2,
  });
  for (const selected of [["a", "a"], ["unknown"]]) {
    assert.throws(() => evaluateRetrieval(sample(), selected), /invalid_selection/);
  }
});
test("small perfect synthetic sample cannot claim quality targets achieved", async () => {
  const out = await evaluateExtraction(sample(), [observation()], judge());
  const summary = summarize([out], [evaluateRetrieval(sample(), ["a"])]);
  assert.equal(summary.retrieval.koreanRecallAt5, 1);
  assert.equal(summary.targetPass, false);
  assert.equal(summary.decisionGrade, false);
  assert.equal(TARGETS.precisionWilsonLower, 0.95);
  assert.equal(TARGETS.recallWilsonLower, 0.85);
  assert.equal(TARGETS.koreanRecallAt5, 0.85);
  assert.equal(TARGETS.irrelevantInjectionRate, 0.02);
});
