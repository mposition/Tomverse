import assert from "node:assert/strict";
import test from "node:test";
import { main } from "../tools/memory-quality/cli.ts";
import {
  loadRetrievalCases, measureProductRetrieval, productSelection,
  measureProductRetrievalDetailed,
} from "../tools/memory-quality/productRetrieval.ts";
import { P0_INPUT_FIXTURES, P0_ANSWER_EVALUATION } from "../tools/memory-quality/fixtures/p0-inputs.ts";

const memory = (id, statement, extra = {}) => ({ id, statement, status: "active", forbidden: false, ...extra });
const one = (query, pool, relevantIds) => ({ id: "case", language: "ko", tag: "t", retrieval: { query, pool, relevantIds } });

test("a Korean particle does not hide the memory from the product scorer", () => {
  const pool = [memory("a", "사용자는 커피를 마시지 않는다."), memory("b", "사용자는 등산을 즐긴다.")];
  assert.deepEqual(productSelection({ query: "커피 대신 마실 것", pool, relevantIds: ["a"] }).map((m) => m.id), ["a"]);
});

test("only active rows reach the scorer", () => {
  const pool = ["deleted", "superseded", "expired"].map((status, i) =>
    memory(`m${i}`, "사용자는 커피를 좋아한다.", { status }));
  assert.deepEqual(productSelection({ query: "커피", pool, relevantIds: [] }), []);
});

test("known synthetic invalid rows are reported without claiming product write or leak evidence", () => {
  const pool = [memory("x", "사용자의 은행 앱 비밀번호는 합성값이다.", { forbidden: true })];
  const result = measureProductRetrieval([one("은행 앱 추천", pool, [])]);
  assert.equal(result.summary.forbidden, 1);
  assert.ok(result.targetFailures.includes("forbidden_injection"));
  assert.equal(result.scope, "pure_selector_synthetic_pool");
  assert.equal(result.answerQuality.status, "not_run");
});

test("recall@5 is read off the prompt order, where core memories come first", () => {
  const pool = [
    ...["identity", "occupation", "expertise", "constraint", "long_term_goal"]
      .map((kind, i) => memory(`c${i}`, `사용자의 핵심 사실 ${i}번이다.`, { kind })),
    memory("r", "사용자는 등산을 즐긴다."),
  ];
  const result = measureProductRetrieval([one("등산 준비물", pool, ["r"])]);
  assert.equal(result.summary.recalled, 0);
  assert.equal(result.koreanRecallInjected, 1);
  assert.deepEqual(result.misses[0].missed, ["r"]);
  // The five core rows are always-on, not irrelevant term matches.
  assert.equal(result.gatedIrrelevantRate, 0);
  assert.equal(result.summary.irrelevant, 5);
  assert.equal(result.top5.recalled, 0);
  assert.equal(result.fullSelectedSet.recalled, 1);
  assert.equal(result.fullSelectedSet.alwaysOnSelected, 5);
  assert.equal(result.fullSelectedSet.gatedSelected, 1);
  assert.equal(result.fullSelectedSet.gatedIrrelevantRate, 0);
});

test("full-set safety and gated metrics include rows beyond the first five", () => {
  const pool = [
    ...["identity", "occupation", "expertise", "constraint", "long_term_goal"]
      .map((kind, i) => memory(`c${i}`, `Core fact ${i}`, { kind })),
    memory("r", "coffee is preferred"),
    memory("invalid", "coffee synthetic invalid credential", { forbidden: true }),
    memory("inactive", "coffee deleted fact", { status: "deleted" }),
  ];
  const result = measureProductRetrieval([one("coffee", pool, ["r"])]);
  assert.equal(result.top5.forbidden, 0);
  assert.equal(result.top5.gatedSelected, 0);
  assert.equal(result.fullSelectedSet.forbidden, 1);
  assert.equal(result.fullSelectedSet.inactive, 0);
  assert.equal(result.fullSelectedSet.gatedSelected, 2);
  assert.equal(result.fullSelectedSet.gatedIrrelevant, 1);
  assert.equal(result.fullSelectedSet.gatedIrrelevantRate, 0.5);
});

test("sixteen bilingual P0 input fixtures separate retrieval contracts from unrun answer quality", () => {
  assert.equal(P0_INPUT_FIXTURES.length, 16);
  assert.equal(P0_ANSWER_EVALUATION.status, "not_run");
  assert.equal(P0_ANSWER_EVALUATION.model, null);
  const measured = measureProductRetrievalDetailed(P0_INPUT_FIXTURES);
  for (const language of ["ko", "en"]) {
    const fixtures = P0_INPUT_FIXTURES.filter((row) => row.language === language);
    assert.equal(fixtures.length, 8);
    for (const fixture of fixtures) {
      const row = measured.rows.find((value) => value.caseId === fixture.id);
      assert.ok(row);
      assert.ok(fixture.answerCriteria);
      if (fixture.observation === "must_retrieve") {
        assert.deepEqual(row.full.ids, fixture.retrieval.relevantIds, fixture.id);
      }
      if (fixture.observation === "bounded_middle_limit") {
        // This limitation is observed, never relabelled as model answer success.
        assert.equal(row.full.recalled, 0, fixture.id);
      }
    }
  }
  assert.equal(measured.result.answerQuality.status, "not_run");
});

test("an NFD query selects what its NFC form selects", () => {
  const pool = [memory("a", "사용자는 재즈 음악을 즐겨 듣는다.")];
  const nfc = productSelection({ query: "재즈 공연", pool, relevantIds: ["a"] });
  assert.deepEqual(productSelection({ query: "재즈 공연".normalize("NFD"), pool, relevantIds: ["a"] }), nfc);
  assert.deepEqual(nfc.map((m) => m.id), ["a"]);
});

test("the Korean retrieval set loads with valid golds and annotated kinds", async () => {
  const cases = await loadRetrievalCases("retrieval-ko");
  assert.ok(cases.length >= 30);
  assert.ok(cases.every((row) => row.language === "ko"));
  assert.equal(measureProductRetrieval(cases).poolKinds, "annotated");
  assert.ok(cases.some((row) => row.retrieval.query !== row.retrieval.query.normalize("NFC")));
});

test("the retrieval command measures the product path with no model call", async () => {
  const output = await main(["retrieval"]);
  const result = output.retrieval["retrieval-ko"];
  assert.deepEqual(Object.keys(output.retrieval), ["retrieval-ko"]);
  assert.equal(result.path, "product:selectMemoryContext");
  assert.equal(result.paidCalls, 0);
  assert.equal(result.decisionGrade, false);
  assert.equal(typeof result.summary.koreanRecallAt5, "number");
  for (const tag of ["particle", "one_syllable", "spacing", "synonym", "nfd", "mixed_script"]) {
    assert.ok(result.byTag[tag], tag);
  }
  const all = await main(["retrieval", "--corpus", "all"]);
  assert.deepEqual(Object.keys(all.retrieval), ["development", "validation", "retrieval-ko", "relevance"]);
  assert.equal(all.retrieval.development.poolKinds, "defaulted");
  await assert.rejects(main(["retrieval", "--corpus", "production"]), { code: "unknown_corpus" });
});
