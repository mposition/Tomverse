import assert from "node:assert/strict";
import test from "node:test";

import {
  coverageGap,
  draftingBatches,
  draftingCallCostCeilingUsd,
  draftingCostCeilingUsd,
  modeTargets,
  CELL_PHENOMENON_MIX,
  INJECTION_QUOTA_PER_LANGUAGE,
  datasetManifest,
  goldLeadLabels,
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
import { datasetProblems } from "../lib/aiReviewEvalRun.ts";

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
  const ceiling = draftingCostCeilingUsd({
    inputTokensPerCall: [1_000_000, 3_000_000],
    outputTokenCapPerCall: 1_000_000,
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 3,
  });
  assert.equal(ceiling, 1 + 3 + 3 + 3);

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
