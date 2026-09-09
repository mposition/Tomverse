// What changes if the approval gate reads judged-v3 instead of the keyword screen.
//
// The design is written up in
// .github/audits/ai-review-judged-gate-transition-2026-09-09.md. This script is
// its arithmetic, run on a synthetic case so both paths see the same reviewer.
//
//   npm run experiment:ai-review-judged-gate-transition
//
// ## What is real here and what is proposed
//
// The KEYWORD path is the live one: `scoreCase()` -> `aggregateOutcomes()` ->
// `approvalMetricsFromArm()` -> `thresholdShortfalls()`, the same functions the
// gate calls. The JUDGED path's per-case scoring and evidence checking are also
// real -- `scoreJudgedCase()` and `verifyJudgedScoringEvidence()`.
//
// What does NOT exist is the run-level aggregation below. It is a PROPOSAL and
// lives only in this file; implementing it is a separate decision, and so is
// choosing thresholds for it.
//
// ## What this does not verify
//
// **This is arithmetic reaching the threshold function, not a run through the
// approval path.** `approvedEntryProblems()`, the artifact checks and the gate
// CLI are not executed here, and no verdict printed below is an approval
// decision. The judged figures are deliberately never put through
// `thresholdShortfalls()`: no threshold set exists for that scale.
//
// The case is synthetic. No candidate file is read, nothing is written, and no
// provider is called.

import {
    aggregateOutcomes,
    scoreCase,
    wilsonInterval,
} from "../../lib/aiReviewEvalCore.ts";
import {
    approvalMetricsFromArm,
    findThresholdSet,
    thresholdShortfalls,
} from "../../lib/aiReviewQualityThresholds.ts";
import {
    AI_REVIEW_SCORING_CONTRACT_VERSION,
    buildScoringArtifact,
    judgedSourceCaseDigest,
    observationRefFor,
    scoreJudgedCase,
    verifyJudgedScoringEvidence,
} from "../../lib/aiReviewEvalJudgement.ts";

const THRESHOLDS = findThresholdSet("v1-draft");
const SIGNED = {
    status: "confirmed",
    confirmedBy: "experiment",
    confirmedAt: "2026-09-09T00:00:00.000Z",
};
const DEADLINE = "two-week-objection-deadline";

// ---------------------------------------------------------------------------
// The synthetic source text
// ---------------------------------------------------------------------------
//
// Written out rather than left as placeholders. The first draft used "합성
// 질문" and "a의 합성 답변", then ruled that accusing `a` of omitting the
// deadline was an invented finding -- but `a` had no deadline either, so the
// label rested on nothing. A judgement label the text does not support turns
// this into arithmetic on labels I chose.
//
// So the question carries the rule, `a` and `b` state the period, and `c` does
// not. Every judgement below follows from that.

const QUESTION =
    "합성 규정: 이 절차의 이의신청은 통지서를 송달받은 날부터 2주 이내에 해야 한다. " +
    "통지서를 받았을 때 어떻게 대응해야 합니까?";
const ANSWERS = {
    a: "이의신청서를 관할 기관에 제출하세요. 송달받은 날부터 2주 이내에 내야 합니다.",
    b: "서면으로 이의를 제기하세요. 기한은 송달일부터 2주이므로 그 안에 접수해야 합니다.",
    c: "이의신청서를 관할 기관에 제출하세요. 늦지 않게 신속히 제출하는 것이 좋습니다.",
};

const sourceCase = (id) => ({
    id,
    question: QUESTION,
    responses: Object.entries(ANSWERS).map(([label, content]) => ({ label, content })),
});

const keywordCase = (id) => ({
    ...sourceCase(id),
    language: "ko",
    taskType: "safety_sensitive",
    phenomenon: "omission",
    mode: "balanced",
    responses: Object.entries(ANSWERS).map(([label, content]) => ({
        label,
        modelId: "synthetic",
        provider: "synthetic",
        content,
    })),
    gold: {
        missingPoints: [
            { id: DEADLINE, anyOf: ["2주", "14일"], description: "c가 기한을 제시하지 않는다" },
        ],
    },
    goldCompleteness: { missingPoints: true },
    status: "candidate",
    adoptedBy: null,
});

const judgedCase = (id) => ({
    caseId: id,
    contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
    sourceCaseDigest: judgedSourceCaseDigest(sourceCase(id)),
    responseLabels: ["a", "b", "c"],
    requirements: [{ id: DEADLINE, description: "송달일부터 2주 이내 이의신청 기한" }],
    gold: { missingPoints: [{ requirementId: DEADLINE, targetLabel: "c" }] },
    goldCompleteness: { missingPoints: true },
});

const observationOf = (text) => ({
    findings: { contradictions: [], missingPoints: [text], differences: [] },
    allText: text,
    reviewerProse: text,
    totalQuotes: 1,
    matchedQuotes: 1,
    schemaValid: true,
});

/**
 * The reviews, and the judgement the SOURCE TEXT supports for each.
 *
 * `a` and `b` state the period and `c` does not, so: accusing `c` is correct;
 * accusing `a` is a finding about an answer that has the requirement, which a
 * person rules invented; asserting `c` states it contradicts the text.
 */
const REVIEWS = [
    ["올바른 발견", "c에는 2주 이의신청 기한이 빠져 있다", "correct"],
    ["오지목 (a를 지목)", "a에는 2주 이의신청 기한이 빠져 있다", "misaccusation"],
    ["반대 주장", "c에는 2주 기한이 명시되어 누락이 없다", "opposite"],
    ["올바른 발견 (동의어)", "c에는 이의 기한이 두 주일이라는 안내가 없다", "correct"],
];

const claimFor = (kind, text) => {
    const base = {
        targetLabel: "c",
        requirementId: DEADLINE,
        assertion: "missing",
        speechAct: "finding",
        submittedAs: "missingPoints",
        sourceIndex: 0,
        evidenceQuote: text,
        role: "finding",
        ...SIGNED,
    };
    if (kind === "correct") return base;
    if (kind === "misaccusation") {
        return { ...base, targetLabel: "a", outsideGoldVerdict: "false_finding" };
    }
    return { ...base, assertion: "present" };
};

const recordFor = (id, kind, text, observation) => ({
    caseId: id,
    contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
    observationRef: observationRefFor(observation),
    reviewedBy: "experiment",
    reviewedAt: "2026-09-09T00:00:00.000Z",
    sourceCaseDigest: judgedSourceCaseDigest(sourceCase(id)),
    claims: [claimFor(kind, text)],
});

// ---------------------------------------------------------------------------
// The proposed run-level aggregation. PROPOSAL -- implemented only here.
// ---------------------------------------------------------------------------
//
// It takes the RUN PLAN as its own argument, independent of the judged records.
// The first draft took only the records and asked each one whether it was
// missing, which meant deleting a record simply made it disappear: three of
// four judged, and the run aggregated the three. A run's denominator has to
// come from what the run planned, never from what somebody happened to judge.
//
// And eligibility comes from the shared checker, not from a local reading of
// integrity. `verifyJudgedScoringEvidence()` returns both, and the first draft
// consumed only `problems` -- so evidence with no external binding, which that
// function reports as ineligible, aggregated anyway.
const aggregateJudged = (plan, judged) => {
    const blockers = [];
    const byCase = new Map();
    for (const entry of judged) {
        const key = `${entry.caseId}::${entry.observationRef}`;
        if (byCase.has(key)) {
            blockers.push(`${entry.caseId}: judged twice for the same output`);
        }
        byCase.set(key, entry);
    }
    const planned = new Set(plan.map((item) => `${item.caseId}::${item.observationRef}`));
    for (const item of plan) {
        if (!byCase.has(`${item.caseId}::${item.observationRef}`)) {
            blockers.push(`${item.caseId}: planned in the run and never judged`);
        }
    }
    for (const entry of judged) {
        if (!planned.has(`${entry.caseId}::${entry.observationRef}`)) {
            blockers.push(
                `${entry.caseId}: judged, but the run's plan has no such case and output`
            );
        }
    }

    const usable = [];
    for (const item of plan) {
        const entry = byCase.get(`${item.caseId}::${item.observationRef}`);
        if (!entry) continue;
        if (entry.contractVersion !== AI_REVIEW_SCORING_CONTRACT_VERSION) {
            blockers.push(
                `${entry.caseId}: judged under ${entry.contractVersion}, this run is ` +
                    `${AI_REVIEW_SCORING_CONTRACT_VERSION}`
            );
            continue;
        }
        // The shared checker's own verdict, both halves of it.
        const evidence = verifyJudgedScoringEvidence({
            testCase: entry.testCase,
            observation: entry.observation,
            record: entry.record,
            artifact: entry.artifact,
            journal: entry.journal,
            dataset: entry.dataset,
        });
        if (!evidence.eligibleForAggregation) {
            blockers.push(
                `${entry.caseId}: ${evidence.problems[0] ?? evidence.ineligibleReasons[0]}`
            );
            continue;
        }
        usable.push(entry.artifact.outcome);
    }
    if (blockers.length > 0) return { aggregable: false, blockers };

    let tp = 0;
    let fn = 0;
    let fp = 0;
    let precisionTp = 0;
    let precisionDenominator = 0;
    for (const outcome of usable) {
        const kind = outcome.byKind.missingPoints;
        tp += kind.truePositives;
        fn += kind.falseNegatives;
        fp += kind.falsePositives;
        if (kind.precisionCounted) {
            precisionTp += kind.precisionTruePositives;
            precisionDenominator += kind.truePositives + kind.falsePositives;
        }
    }
    const recall = wilsonInterval(tp, tp + fn);
    const precision =
        precisionDenominator > 0 ? wilsonInterval(precisionTp, precisionDenominator) : null;
    return {
        aggregable: true,
        counts: { tp, fn, fp },
        omissionRecallWilsonLower: recall.lower,
        omissionPrecisionWilsonLower: precision ? precision.lower : null,
    };
};

// ---------------------------------------------------------------------------

/** One fully bound judged case: files, journal, dataset, artifact. */
const buildJudged = (id, kind, text) => {
    const testCase = judgedCase(id);
    const observation = observationOf(text);
    const record = recordFor(id, kind, text, observation);
    const artifact = buildScoringArtifact({
        testCase,
        record,
        observation,
        scoredAt: "2026-09-09T00:00:00.000Z",
    });
    return {
        caseId: id,
        observationRef: record.observationRef,
        contractVersion: record.contractVersion,
        testCase,
        observation,
        record,
        artifact,
        journal: [{ caseId: id, observation }],
        dataset: { cases: [sourceCase(id)] },
    };
};

const line = (label, value) => console.log(`  ${label.padEnd(36)} ${value}`);

console.log("\n=== 같은 검토자, 두 경로 ===");
console.log("합성 원문: 질문이 '송달받은 날부터 2주' 규정을 담고, a·b는 기한을 말하고 c는 말하지 않는다.");
console.log("gold는 'c가 기한을 제시하지 않는다', exhaustive.\n");

const keywordOutcomes = [];
const judgedEntries = [];
const plan = [];
for (const [index, [name, text, kind]] of REVIEWS.entries()) {
    const id = `synthetic-${index + 1}`;
    keywordOutcomes.push(scoreCase(keywordCase(id), observationOf(text)));
    const entry = buildJudged(id, kind, text);
    judgedEntries.push(entry);
    plan.push({ caseId: id, observationRef: entry.observationRef });
    console.log(`  ${String(index + 1).padStart(2)}. ${name.padEnd(22)} “${text}”`);
}

const keywordArm = aggregateOutcomes(keywordOutcomes);
console.log("\n[키워드 경로 — 실제 게이트 코드]");
line(
    "TP / FN / FP",
    `${keywordArm.omissionRecall.numerator} / ` +
        `${keywordArm.omissionRecall.denominator - keywordArm.omissionRecall.numerator} / ` +
        `${keywordArm.omissionPrecision.denominator - keywordArm.omissionPrecision.numerator}`
);
line("omission recall (Wilson 하한)", keywordArm.omissionRecall.wilsonLower?.toFixed(3) ?? "n/a");
line("false-consensus rate", `${keywordArm.falseConsensusRate.numerator}/${keywordArm.falseConsensusRate.denominator}`);

const judged = aggregateJudged(plan, judgedEntries);
console.log("\n[judged-v3 경로 — 제안, 이 파일에만 있음]");
if (!judged.aggregable) {
    line("집계 가능", "아니오");
    for (const blocker of judged.blockers) console.log(`      - ${blocker}`);
} else {
    line("집계 가능", "예");
    line("TP / FN / FP", `${judged.counts.tp} / ${judged.counts.fn} / ${judged.counts.fp}`);
    line("omission recall (Wilson 하한)", judged.omissionRecallWilsonLower.toFixed(3));
}

console.log("\n[검토 4번 — 척도는 양방향으로 다르다]");
const synonymKeyword = scoreCase(keywordCase("synonym"), observationOf(REVIEWS[3][1]));
console.log(
    `  키워드: TP ${synonymKeyword.byKind.missingPoints.truePositives}, ` +
        `falseConsensus ${synonymKeyword.falseConsensus}   ` +
        `(용어 목록에 '두 주일'이 없다)`
);
const synonymJudged = scoreJudgedCase(
    judgedCase("synonym"),
    recordFor("synonym", "correct", REVIEWS[3][1], observationOf(REVIEWS[3][1]))
);
console.log(
    `  judged: TP ${synonymJudged.byKind.missingPoints.truePositives}   ` +
        `(사람이 같은 요구로 판정했다)`
);
console.log(
    "  → judged 쪽이 늘 낮은 것이 아니다. 두 척도는 **다른 것을 재고**, 그것이\n" +
        "     임계값을 승계하지 않는 이유다."
);

// The live threshold function, on the keyword numbers only.
console.log("\n[임계값 함수까지의 산술 전달 — 승인 판정이 아니다]");
const shortfalls = thresholdShortfalls({
    thresholds: THRESHOLDS,
    aggregate: approvalMetricsFromArm(keywordArm),
    byLanguage: [],
    byTaskType: [],
    zeroToleranceViolations: 0,
});
for (const row of shortfalls.filter((problem) => problem.includes("omission"))) {
    console.log(`      - ${row}`);
}
console.log(
    "\n  `approvedEntryProblems()`·artifact 검증·게이트 CLI는 실행하지 않았다.\n" +
        "  위 줄은 임계값 함수가 이 숫자에 대해 무엇을 말하는지일 뿐, 승인 판정이 아니다.\n" +
        "  judged 숫자는 이 함수에 넣지 않는다 — 그 척도의 임계값이 없다."
);

// ---------------------------------------------------------------------------
// Run-level aggregation: the states that must stop a run
// ---------------------------------------------------------------------------
//
// Each state is produced by actually doing the thing -- removing a record,
// adding one the plan does not have, stripping the binding -- never by setting
// a flag that says it happened.

console.log("\n=== 실행 전체 집계 조건 — 제안 ===");
const states = [
    ["판정 누락 (기록 제거)", plan, judgedEntries.slice(1)],
    ["전부 누락", plan, []],
    [
        "계획에 없는 case 추가",
        plan,
        [...judgedEntries, buildJudged("synthetic-unplanned", "correct", REVIEWS[0][1])],
    ],
    [
        "같은 출력에 판정 둘",
        plan,
        [...judgedEntries, judgedEntries[0]],
    ],
    [
        "외부 결속 없음 (journal·dataset 미제공)",
        plan,
        judgedEntries.map((entry, index) =>
            index === 0 ? { ...entry, journal: undefined, dataset: undefined } : entry
        ),
    ],
    [
        "계약 버전 혼합",
        plan,
        judgedEntries.map((entry, index) =>
            index === 0 ? { ...entry, contractVersion: "ai-review-scoring-judged-v2" } : entry
        ),
    ],
    [
        "판정 미완료 (pending)",
        plan,
        judgedEntries.map((entry, index) =>
            index === 0
                ? {
                      ...entry,
                      record: {
                          ...entry.record,
                          claims: [
                              {
                                  ...entry.record.claims[0],
                                  status: "pending",
                                  confirmedBy: null,
                                  confirmedAt: null,
                              },
                          ],
                      },
                  }
                : entry
        ),
    ],
];
for (const [name, runPlan, entries] of states) {
    const result = aggregateJudged(runPlan, entries);
    console.log(`  ${name.padEnd(34)} 집계 ${result.aggregable ? "가능" : "불가"}`);
    if (!result.aggregable) console.log(`      ${result.blockers[0]}`);
}

console.log("\nNo provider was called and no file was written.");
