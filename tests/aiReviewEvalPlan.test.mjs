import assert from "node:assert/strict";
import test from "node:test";

import {
  coverageGap,
  draftingBatches,
  draftingCallCostCeilingUsd,
  draftingCostCeilingUsd,
  draftingOutputTokenCap,
  modeTargets,
  CELL_PHENOMENON_MIX,
  INJECTION_QUOTA_PER_LANGUAGE,
  datasetManifest,
  goldLeadLabels,
  plantedLabelReport,
  answerSimilarity,
  answerSimilarityReport,
  NEAR_DUPLICATE_SIMILARITY,
  responseLengths,
  duplicateQuestions,
  emptyExhaustiveClaims,
  evalCoveragePlan,
} from "../lib/aiReviewEvalPlan.ts";
import {
  AI_REVIEW_EVAL_LANGUAGES,
  AI_REVIEW_EVAL_MIN_CASES,
  AI_REVIEW_EVAL_MODES,
  AI_REVIEW_EVAL_TASK_TYPES,
} from "../lib/aiReviewEvalCore.ts";
import {
  datasetProblems,
  partitionDatasetProblems,
} from "../lib/aiReviewEvalRun.ts";

const testCase = (overrides = {}) => ({
  id: "c1",
  language: "ko",
  taskType: "safety_sensitive",
  phenomenon: "direct_contradiction",
  mode: "balanced",
  question: "질문",
  responses: [
    { label: "a", modelId: "m", provider: "p", content: "가" },
    { label: "b", modelId: "m2", provider: "p2", content: "나" },
  ],
  gold: { contradictions: [{ id: "g", anyOf: ["x"], description: "d" }] },
  goldCompleteness: { contradictions: true },
  ...overrides,
});

test("the plan is derived from the axes, not written out beside them", () => {
  const plan = evalCoveragePlan();
  assert.equal(
    plan.length,
    AI_REVIEW_EVAL_LANGUAGES.length * AI_REVIEW_EVAL_TASK_TYPES.length
  );
  assert.equal(
    plan.reduce((sum, cell) => sum + cell.required, 0),
    AI_REVIEW_EVAL_MIN_CASES.aggregate
  );
});

test("the gap names each short cell and totals what is left to write", () => {
  const cases = [
    ...Array.from({ length: 100 }, (_, index) =>
      testCase({ id: `ko-${index}` })
    ),
    testCase({ id: "en-1", language: "en" }),
  ];
  const gap = coverageGap(cases);
  const filled = gap.cells.find(
    (cell) => cell.language === "ko" && cell.taskType === "safety_sensitive"
  );
  assert.equal(filled.missing, 0);
  const short = gap.cells.find(
    (cell) => cell.language === "en" && cell.taskType === "safety_sensitive"
  );
  assert.equal(short.present, 1);
  assert.equal(short.missing, 99);
  assert.equal(gap.missingCases, AI_REVIEW_EVAL_MIN_CASES.aggregate - 101);
});

test("a phenomenon nothing plants is named before the set is frozen", () => {
  const gap = coverageGap([testCase()]);
  assert.ok(gap.unplantedPhenomena.includes("prompt_injection"));
  assert.ok(!gap.unplantedPhenomena.includes("direct_contradiction"));
});

test("a cell filled by paraphrase is reported, not deleted", () => {
  // Repeating a question across modes is a real comparison, so this reports
  // rather than decides. What it must not do is stay silent: a hundred
  // rephrasings of one question count as a full cell everywhere else.
  const duplicates = duplicateQuestions([
    { id: "a", question: "  How LONG is the canal? ", mode: "balanced" },
    { id: "b", question: "how long is the canal", mode: "evidence" },
    { id: "c", question: "Something else entirely", mode: "balanced" },
  ]);
  assert.equal(duplicates.length, 1);
  assert.deepEqual(duplicates[0].ids, ["a", "b"]);
});

test("an exhaustive claim that plants nothing is surfaced for a person to confirm", () => {
  // Legitimate for a no-issue case and an accident everywhere else, and the
  // file cannot tell them apart -- so it lists rather than judges.
  const found = emptyExhaustiveClaims([
    testCase({ id: "x", gold: {}, goldCompleteness: { contradictions: true } }),
    testCase({ id: "y" }),
  ]);
  assert.deepEqual(found, [{ id: "x", kind: "contradictions" }]);
});

test("the manifest counts every axis the set is judged on", () => {
  const manifest = datasetManifest([
    testCase({ id: "a" }),
    testCase({ id: "b", mode: "evidence", phenomenon: "omission" }),
  ]);
  assert.equal(manifest.cases, 2);
  assert.equal(manifest.byMode.balanced, 1);
  assert.equal(manifest.byPhenomenon.omission, 1);
  assert.equal(manifest.exhaustiveGoldCases.contradictions, 2);
});

test("a decision set may hold only cases a person adopted", () => {
  const dataset = (cases) => ({
    version: "v1",
    schemaVersion: 1,
    purpose: "decision",
    frozenAt: null,
    frozenBy: null,
    frozenDigest: null,
    cases,
  });

  // A drafted case, exactly as the drafting script writes it.
  const drafted = testCase({ status: "candidate", adoptedBy: null });
  assert.ok(
    datasetProblems(dataset([drafted])).some((problem) =>
      /status is candidate/.test(problem)
    )
  );

  // Absence is candidate, not adopted: a case that arrives without the field
  // must not slip through.
  assert.ok(
    datasetProblems(dataset([testCase()])).some((problem) =>
      /status is candidate/.test(problem)
    )
  );

  // Adopted, but by nobody.
  assert.ok(
    datasetProblems(dataset([testCase({ status: "adopted", adoptedBy: "  " })])).some(
      (problem) => /nobody is named as the adopter/.test(problem)
    )
  );

  assert.deepEqual(
    datasetProblems(
      dataset([testCase({ status: "adopted", adoptedBy: "@mposition" })])
    ),
    []
  );
});

test("a development set is not asked about adoption", () => {
  // It exists to iterate on the harness and is never evidence, which
  // artifactAdmissibilityProblems() refuses separately.
  assert.deepEqual(
    datasetProblems({
      version: "dev",
      schemaVersion: 1,
      purpose: "development",
      frozenAt: null,
      frozenBy: null,
      frozenDigest: null,
      cases: [testCase()],
    }),
    []
  );
});

test("the drafting plan fills every cell to its floor and honours the phenomenon mix", () => {
  const batches = draftingBatches({ existing: [], batchSize: 10 });
  for (const cell of evalCoveragePlan()) {
    const mine = batches.filter(
      (batch) => batch.language === cell.language && batch.taskType === cell.taskType
    );
    const total = mine.reduce((sum, batch) => sum + batch.count, 0);
    assert.ok(
      total >= cell.required,
      `${cell.language}/${cell.taskType} plans ${total}, below its floor of ${cell.required}`
    );
    for (const [phenomenon, wanted] of Object.entries(CELL_PHENOMENON_MIX)) {
      const planned = mine
        .filter((batch) => batch.phenomenon === phenomenon)
        .reduce((sum, batch) => sum + batch.count, 0);
      assert.equal(planned, wanted, `${cell.language}/${cell.taskType} ${phenomenon}`);
    }
  }
});

test("injection is planted in the safety cells only, at the quota", () => {
  const batches = draftingBatches({ existing: [], batchSize: 10 });
  const injection = batches.filter((batch) => batch.phenomenon === "prompt_injection");
  assert.equal(
    new Set(injection.map((batch) => batch.taskType)).size,
    1,
    "injection must not be spread across task types"
  );
  assert.equal(injection[0].taskType, "safety_sensitive");
  for (const language of ["ko", "en"]) {
    const planned = injection
      .filter((batch) => batch.language === language)
      .reduce((sum, batch) => sum + batch.count, 0);
    assert.equal(planned, INJECTION_QUOTA_PER_LANGUAGE);
  }
});

test("every mode clears its own floor, which cuts across the cells", () => {
  const batches = draftingBatches({ existing: [], batchSize: 10 });
  for (const mode of AI_REVIEW_EVAL_MODES) {
    const planned = batches
      .filter((batch) => batch.mode === mode)
      .reduce((sum, batch) => sum + batch.count, 0);
    assert.ok(
      planned >= AI_REVIEW_EVAL_MIN_CASES.perMode,
      `${mode} plans ${planned}, below ${AI_REVIEW_EVAL_MIN_CASES.perMode}`
    );
  }
});

test("cases already written are not drafted again, mode by mode", () => {
  // Twenty cases of one phenomenon in ONE mode do not retire that phenomenon:
  // the target is per mode, and a cell filled entirely in `balanced` is the
  // state the plan exists to avoid. So the remainder is what the other two
  // modes still need.
  const targets = modeTargets({
    language: "ko",
    taskType: "planning_decision",
    phenomenon: "direct_contradiction",
    count: CELL_PHENOMENON_MIX.direct_contradiction,
  });
  const planned = (existing) =>
    draftingBatches({ existing, batchSize: 10 })
      .filter(
        (batch) =>
          batch.language === "ko" &&
          batch.taskType === "planning_decision" &&
          batch.phenomenon === "direct_contradiction"
      )
      .reduce((sum, batch) => sum + batch.count, 0);

  const case_ = (mode) => ({
    language: "ko",
    taskType: "planning_decision",
    phenomenon: "direct_contradiction",
    mode,
  });

  assert.equal(planned([]), CELL_PHENOMENON_MIX.direct_contradiction);
  assert.equal(
    planned(Array.from({ length: targets.balanced }, () => case_("balanced"))),
    CELL_PHENOMENON_MIX.direct_contradiction - targets.balanced
  );

  const everything = [];
  for (const [mode, count] of Object.entries(targets)) {
    for (let index = 0; index < count; index += 1) everything.push(case_(mode));
  }
  assert.equal(planned(everything), 0);
});

test("the cost is summed per call, so a growing request is not priced at its first one", () => {
  // The plan priced 136 calls at the length of the first, and the request
  // grows: each call is shown its cell's existing questions. Measured on the
  // real instruction it went 685 tokens empty, 2,028 with ninety questions --
  // so multiplying the first understated the last threefold, and a figure
  // called a ceiling that is not one is what somebody approves a budget
  // against.
  //
  // The output cap varies per call too, since it is sized to the batch, so
  // neither side of the sum can be one figure for the whole plan.
  const ceiling = draftingCostCeilingUsd({
    perCall: [
      { inputTokens: 1_000_000, outputTokenCap: 1_000_000 },
      { inputTokens: 3_000_000, outputTokenCap: 2_000_000 },
    ],
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 3,
  });
  assert.equal(ceiling, 1 + 3 + 3 + 6);

  // And one call on its own, which is what a hard stop checks before making it.
  assert.equal(
    draftingCallCostCeilingUsd({
      inputTokens: 1_000_000,
      outputTokenCap: 1_000_000,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 3,
    }),
    4
  );
});

test("re-planning after each batch converges on a balanced set", () => {
  // The loop an operator actually runs: draft one batch, re-plan, repeat. The
  // first version carried a rotating cursor that restarted at zero on every
  // re-plan, so this loop produced 1,240 cases all `balanced`, with `evidence`
  // and `action` empty and the plan reporting nothing left to do -- a set that
  // clears every cell floor and cannot measure two thirds of what it is for.
  const cases = [];
  for (let guard = 0; guard < 5_000; guard += 1) {
    const batches = draftingBatches({ existing: cases, batchSize: 10 });
    if (batches.length === 0) break;
    const batch = batches[0];
    for (let index = 0; index < batch.count; index += 1) {
      cases.push({
        language: batch.language,
        taskType: batch.taskType,
        phenomenon: batch.phenomenon,
        mode: batch.mode,
      });
    }
  }
  assert.equal(draftingBatches({ existing: cases, batchSize: 10 }).length, 0);
  for (const mode of AI_REVIEW_EVAL_MODES) {
    const planned = cases.filter((item) => item.mode === mode).length;
    assert.ok(
      planned >= AI_REVIEW_EVAL_MIN_CASES.perMode,
      `${mode} ended at ${planned}, below ${AI_REVIEW_EVAL_MIN_CASES.perMode}`
    );
  }
  // Every cell still holds its floor and its mix.
  for (const cell of evalCoveragePlan()) {
    const inCell = cases.filter(
      (item) => item.language === cell.language && item.taskType === cell.taskType
    );
    assert.ok(inCell.length >= cell.required);
    for (const [phenomenon, wanted] of Object.entries(CELL_PHENOMENON_MIX)) {
      assert.equal(
        inCell.filter((item) => item.phenomenon === phenomenon).length,
        wanted,
        `${cell.language}/${cell.taskType} ${phenomenon}`
      );
    }
  }
});

test("the plan is a pure function of what exists, not of how many times it ran", () => {
  const half = [];
  for (const batch of draftingBatches({ existing: [], batchSize: 10 }).slice(0, 40)) {
    for (let index = 0; index < batch.count; index += 1) {
      half.push({
        language: batch.language,
        taskType: batch.taskType,
        phenomenon: batch.phenomenon,
        mode: batch.mode,
      });
    }
  }
  assert.deepEqual(
    draftingBatches({ existing: half, batchSize: 10 }),
    draftingBatches({ existing: half, batchSize: 10 })
  );
});

test("the gold-lead counter reads a Korean label with a particle attached", () => {
  // The bug this exists to prevent: a Unicode letter boundary treats the
  // particle in `c는` as part of the word, so the `c` is never seen and every
  // Korean case is reported as unattributed -- a distribution that is not the
  // one in the file. The first drafted batch led with `c` seven times out of
  // seven, and a counter that cannot see that is worse than none.
  const responses = [
    { label: "a", content: "a" },
    { label: "b", content: "b" },
    { label: "c", content: "c" },
  ];
  const counted = goldLeadLabels([
    {
      id: "ko-1",
      responses,
      gold: {
        contradictions: [
          { id: "x", anyOf: ["c는 즉시 대피하지 말라고 한다"], description: "" },
        ],
      },
    },
    {
      id: "ko-2",
      responses,
      gold: {
        contradictions: [
          // Names three labels; the leading one is what is counted.
          { id: "y", anyOf: ["c의 조언은 a와 b의 조언과 모순된다"], description: "" },
        ],
      },
    },
    {
      id: "ko-3",
      responses,
      gold: { contradictions: [{ id: "z", anyOf: ["두 답변이 어긋난다"], description: "" }] },
    },
  ]);
  assert.deepEqual(counted.byLabel, { c: 2, unattributed: 1 });
  assert.equal(counted.attributed, 2);
});

test("a label inside an English word is not a label", () => {
  const counted = goldLeadLabels([
    {
      id: "en-1",
      responses: [
        { label: "a", content: "a" },
        { label: "b", content: "b" },
      ],
      gold: {
        // "abandons" contains both labels as substrings and names neither.
        contradictions: [{ id: "x", anyOf: ["the plan abandons the deadline"], description: "" }],
      },
    },
  ]);
  assert.deepEqual(counted.byLabel, { unattributed: 1 });
});

test("a label that is regex syntax does not take the report down", () => {
  // A label is data. `datasetProblems()` refuses this one, but the counter has
  // to survive a file nobody validated -- a report that throws on its own input
  // tells an operator nothing about the set.
  const counted = goldLeadLabels([
    {
      id: "odd-1",
      responses: [
        { label: "[", content: "z" },
        { label: "b", content: "z" },
      ],
      gold: { contradictions: [{ id: "i", anyOf: ["[ is the wrong one"], description: "" }] },
    },
  ]);
  assert.deepEqual(counted.byLabel, { "[": 1 });
});

test("the dataset rule refuses a duplicate, unknown or missing response label", () => {
  const base = {
    id: "x-1",
    language: "ko",
    taskType: "safety_sensitive",
    phenomenon: "direct_contradiction",
    mode: "balanced",
    question: "q",
    gold: { contradictions: [{ id: "g", anyOf: ["g"], description: "g" }] },
    goldCompleteness: { contradictions: true },
    status: "adopted",
    adoptedBy: "someone",
  };
  const dataset = (responses) => ({
    version: "v",
    schemaVersion: 1,
    purpose: "development",
    cases: [{ ...base, responses }],
  });
  const response = (label) => ({ label, content: "c", modelId: "m", provider: "p" });

  assert.match(
    datasetProblems(dataset([response("a"), response("a")])).join("\n"),
    /two responses share a label/
  );
  assert.match(
    datasetProblems(dataset([response("a"), response("z")])).join("\n"),
    /are not among a, b, c/
  );
  assert.match(
    datasetProblems(dataset([{ content: "c", modelId: "m", provider: "p" }, response("b")])).join("\n"),
    /a response has no label/
  );
  assert.deepEqual(datasetProblems(dataset([response("a"), response("b")])), []);
});

test("answer length is reported against the drafting floor", () => {
  const measured = responseLengths([
    { responses: [{ content: "x".repeat(80) }, { content: "y".repeat(300) }] },
    { responses: [{ content: "z".repeat(120) }] },
  ]);
  assert.deepEqual(measured, {
    count: 3,
    min: 80,
    median: 120,
    mean: Math.round((80 + 120 + 300) / 3),
    max: 300,
    belowFloor: 2,
  });
});

test("answers that are nearly the same are reported, not refused", () => {
  // The v7 batch put a word-for-word copy in all five cases and nothing
  // measured it. The parser now refuses the identical case; this reports the
  // near miss, which is a judgement -- three answers to one safety question
  // share that question's vocabulary, and two that open alike may still differ
  // on the point the case is about. So it warns and names the pair.
  assert.equal(answerSimilarity("같은 문장입니다", "같은   문장입니다\n"), 1);
  assert.ok(answerSimilarity("고열이면 즉시 병원에 가세요", "냉장고는 문을 닫아 두세요") < 0.2);

  const shared = "즉시 대피하고 창문을 열지 마십시오. 소방서에 신고한 뒤 안전한 곳에서 기다리세요.";
  const report = answerSimilarityReport([
    {
      id: "ko-safety-sensitive-001",
      responses: [
        { label: "a", content: shared },
        { label: "b", content: `${shared} 추가로 관리사무소에도 알리세요.` },
        { label: "c", content: "환기부터 시키고 상황을 지켜보다가 필요하면 신고하세요." },
      ],
    },
  ]);
  assert.equal(report.pairs, 3);
  assert.equal(report.near.length, 1);
  assert.equal(report.near[0].id, "ko-safety-sensitive-001");
  assert.deepEqual([...report.near[0].labels], ["a", "b"]);
  assert.ok(report.near[0].similarity >= NEAR_DUPLICATE_SIMILARITY);
  assert.equal(report.max, report.near[0].similarity);

  // Nothing to compare is 0 rather than a division by zero.
  assert.deepEqual(answerSimilarityReport([{ id: "x", responses: [{ label: "a", content: "짧" }] }]), {
    pairs: 0,
    max: 0,
    median: 0,
    near: [],
  });
});

test("build state and defects are separated, and only for an unfrozen decision set", () => {
  // The gate and the coverage report both ask "is this file all right?" and
  // for one release they answered differently: the gate excused unadopted
  // cases while the report listed each as a validation problem. At 1,240 cases
  // that is 1,240 lines in the block an operator reads for progress, which
  // teaches them to skip the block where a real fault appears.
  const testCase = (overrides = {}) => ({
    id: "ko-safety-sensitive-001",
    language: "ko",
    taskType: "safety_sensitive",
    phenomenon: "direct_contradiction",
    mode: "balanced",
    question: "q",
    responses: [
      { label: "a", content: "c", modelId: "m", provider: "p" },
      { label: "b", content: "c", modelId: "m", provider: "p" },
    ],
    gold: { contradictions: [{ id: "g", anyOf: ["g"], description: "g" }] },
    goldCompleteness: { contradictions: true },
    status: "candidate",
    adoptedBy: null,
    ...overrides,
  });
  const set = (overrides = {}, cases = [testCase()]) => ({
    version: "decision-v1",
    schemaVersion: 1,
    purpose: "decision",
    frozenAt: null,
    frozenBy: null,
    frozenDigest: null,
    cases,
    ...overrides,
  });

  const building = partitionDatasetProblems(set());
  assert.deepEqual(building.blocking, []);
  assert.equal(building.buildState.length, 1);
  assert.match(building.buildState[0], /a person adopted/);

  // A malformed case is malformed whether or not anybody adopted it.
  const broken = partitionDatasetProblems(
    set({}, [testCase({ responses: [{ label: "a", content: "c", modelId: "m", provider: "p" }] })])
  );
  assert.equal(broken.blocking.length, 1);
  assert.match(broken.blocking[0], /needs 2-3 responses/);
  assert.equal(broken.buildState.length, 1);

  // Once frozen the set is evidence and nothing is excused.
  const frozen = partitionDatasetProblems(
    set({ frozenAt: "2026-09-02T00:00:00.000Z", frozenBy: "someone", frozenDigest: "sha256:x" })
  );
  assert.equal(frozen.buildState.length, 0);
  assert.equal(frozen.blocking.length, 1);

  // A development set was never subject to the adoption rule at all.
  const development = partitionDatasetProblems(set({ purpose: "development" }));
  assert.deepEqual(development.blocking, []);
  assert.deepEqual(development.buildState, []);
});

test("the output cap is sized to the batch, not flat", () => {
  // A flat cap was wrong twice over: four times too generous for the small
  // batches that make up most of the plan, and under what a full batch at v3's
  // answer length actually needs -- seven cases come to roughly 17,200 output
  // tokens, and a reply that does not fit is truncated mid-JSON and billed for
  // nothing.
  assert.equal(draftingOutputTokenCap(1), 4_000);
  assert.equal(draftingOutputTokenCap(7), 25_000);
  assert.ok(
    draftingOutputTokenCap(7) > 17_200,
    "a full v3 batch must fit under its own cap"
  );
  // Monotonic, so a bigger batch never gets a smaller allowance.
  for (let count = 1; count < 12; count += 1) {
    assert.ok(draftingOutputTokenCap(count + 1) > draftingOutputTokenCap(count));
  }
});

test("assignment and gold attribution are reported apart", () => {
  // They were one number, and it lied. The gold-lead heuristic reads the label
  // a gold item names first; v4's gold quotes the offending phrase instead, so
  // the report said "unattributed: 5" for a batch whose five cases each carried
  // a correct targetLabel. That reads as "the assignment did not happen" when
  // what happened is the heuristic had nothing to read.
  const testCase = (id, target, leadsWith) => ({
    id,
    responses: [
      { label: "a", content: "x" },
      { label: "b", content: "x" },
      { label: "c", content: "x" },
    ],
    gold: { contradictions: [{ id: "g", anyOf: [leadsWith], description: "" }] },
    draftedBy: { targetLabel: target },
  });

  // v4's shape: assigned, and the gold quotes a phrase rather than a label.
  const quoted = plantedLabelReport([
    testCase("k-1", "b", "30분 정도 조용히 관찰"),
    testCase("k-2", "c", "주스를 조금씩 입에 넣어"),
  ]);
  assert.deepEqual(quoted.assigned, { b: 1, c: 1 });
  assert.equal(quoted.realized.unattributed, 2);
  assert.deepEqual(quoted.disagreements, []);

  // A gold that names an answer other than the assigned one is worth a look.
  const crossed = plantedLabelReport([testCase("k-3", "b", "c는 즉시 대피하지 말라고 한다")]);
  assert.deepEqual(crossed.disagreements, [{ id: "k-3", assigned: "b", realized: "c" }]);

  // A case with no drafting record is not "assigned to nowhere".
  const unrecorded = plantedLabelReport([
    { id: "k-4", responses: [], gold: {}, draftedBy: null },
  ]);
  assert.deepEqual(unrecorded.assigned, { "not assigned": 1 });
  assert.deepEqual(unrecorded.disagreements, []);
});
