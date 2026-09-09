// What changes if the approval gate reads judged-v3 instead of the keyword screen.
//
// The design is written up in
// .github/audits/ai-review-judged-gate-transition-2026-09-09.md. This script is
// its arithmetic, run on synthetic cases so both paths see the same reviewer.
//
//   npm run experiment:ai-review-judged-gate-transition
//
// ## What is real here and what is proposed
//
// The KEYWORD path is the live one, computed end to end by the code the gate
// actually runs: `scoreCase()` -> `aggregateOutcomes()` ->
// `approvalMetricsFromArm()` -> `thresholdShortfalls()`. Nothing about it is
// simulated.
//
// The JUDGED path does not exist. `scoreJudgedCase()` is real and scores each
// case here, but nothing aggregates judged cases into arm metrics and no gate
// reads them. The aggregation below is a PROPOSAL and lives only in this file;
// implementing it is a separate decision, and so is choosing thresholds for it.
//
// Old thresholds are not carried across. The judged rows are printed against
// the same v1-draft numbers ONLY to show what the reviewer would do to them --
// see the document's §4 on why those numbers have no claim on this scale.
//
// The cases are synthetic. No candidate file is read, nothing is written, and
// no provider is called.

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
    scoreJudgedCase,
    verifyJudgementRecord,
} from "../../lib/aiReviewEvalJudgement.ts";

const THRESHOLDS = findThresholdSet("v1-draft");
const SIGNED = {
    status: "confirmed",
    confirmedBy: "experiment",
    confirmedAt: "2026-09-09T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// One synthetic case, and the four reviews the two paths have to tell apart
// ---------------------------------------------------------------------------

const DEADLINE = "two-week-objection-deadline";
const keywordCase = (id) => ({
    id,
    language: "ko",
    taskType: "safety_sensitive",
    phenomenon: "omission",
    mode: "balanced",
    question: "합성 질문",
    responses: ["a", "b", "c"].map((label) => ({
        label,
        modelId: "synthetic",
        provider: "synthetic",
        content: `${label}의 합성 답변`,
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

const observationOf = (text) => ({
    findings: { contradictions: [], missingPoints: [text], differences: [] },
    allText: text,
    reviewerProse: text,
    totalQuotes: 1,
    matchedQuotes: 1,
    schemaValid: true,
});

/** The reviews. Only the first is a correct finding. */
const REVIEWS = [
    ["올바른 발견", "c에는 2주 이의신청 기한이 빠져 있다", "correct"],
    ["오지목 (a를 지목)", "a에는 2주 이의신청 기한이 빠져 있다", "misaccusation"],
    ["반대 주장", "c에는 2주 기한이 명시되어 누락이 없다", "opposite"],
    ["올바른 발견", "c에는 14일 이의신청 기한이 빠져 있다", "correct"],
];

// The judged case the same gold becomes: the accused answer is part of the
// judgement unit, so it is registered rather than left in prose.
const judgedCase = (id) => ({
    caseId: id,
    contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
    sourceCaseDigest: `sha256:${id}`,
    responseLabels: ["a", "b", "c"],
    requirements: [{ id: DEADLINE, description: "송달일부터 2주 이내 이의신청 기한" }],
    gold: { missingPoints: [{ requirementId: DEADLINE, targetLabel: "c" }] },
    goldCompleteness: { missingPoints: true },
});

const judgedClaim = (kind, over) => ({
    targetLabel: "c",
    requirementId: DEADLINE,
    assertion: "missing",
    speechAct: "finding",
    submittedAs: "missingPoints",
    sourceIndex: 0,
    evidenceQuote: "",
    role: "finding",
    ...SIGNED,
    ...over,
});

/** What a person judging that review would have written. */
const judgedRecordFor = (id, kind, text) => {
    const claims = {
        correct: [judgedClaim(kind, { evidenceQuote: text })],
        // The accused answer is `a`, which the gold does not name: outside the
        // gold, and a person ruled it invented.
        misaccusation: [
            judgedClaim(kind, {
                targetLabel: "a",
                evidenceQuote: text,
                outsideGoldVerdict: "false_finding",
            }),
        ],
        // Right answer, right requirement, opposite assertion.
        opposite: [judgedClaim(kind, { assertion: "present", evidenceQuote: text })],
    }[kind];
    return {
        caseId: id,
        contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
        observationRef: `obs-${id}`,
        reviewedBy: "experiment",
        reviewedAt: "2026-09-09T00:00:00.000Z",
        sourceCaseDigest: `sha256:${id}`,
        claims,
    };
};

// ---------------------------------------------------------------------------
// The proposed judged aggregation. PROPOSAL -- implemented only here.
// ---------------------------------------------------------------------------
//
// Two questions, kept apart on purpose. `aggregable` asks whether this RUN may
// be turned into a number at all; the rates are computed only once it may.
// Collapsing them is how a run with three unfinished judgements reports the
// recall of the cases that happened to be finished.
const aggregateJudged = (entries) => {
    const blockers = [];
    const seen = new Set();
    for (const entry of entries) {
        const key = `${entry.caseId}::${entry.observationRef}`;
        if (seen.has(key)) blockers.push(`${entry.caseId}: judged twice for the same output`);
        seen.add(key);
        if (entry.missing) {
            blockers.push(`${entry.caseId}: planned in the run and never judged`);
            continue;
        }
        if (entry.contractVersion !== AI_REVIEW_SCORING_CONTRACT_VERSION) {
            blockers.push(
                `${entry.caseId}: judged under ${entry.contractVersion}, this run is ` +
                    `${AI_REVIEW_SCORING_CONTRACT_VERSION}`
            );
            continue;
        }
        if (entry.integrityProblems?.length) {
            blockers.push(`${entry.caseId}: ${entry.integrityProblems[0]}`);
            continue;
        }
        if (!entry.outcome?.scored) {
            blockers.push(
                `${entry.caseId}: not scored — ${entry.outcome?.reason?.split("\n")[1]?.trim().slice(0, 60) ?? "refused"}`
            );
        }
    }
    if (blockers.length > 0) return { aggregable: false, blockers };

    let tp = 0;
    let fn = 0;
    let fp = 0;
    let precisionTp = 0;
    let precisionDenominator = 0;
    for (const entry of entries) {
        const kind = entry.outcome.byKind.missingPoints;
        tp += kind.truePositives;
        fn += kind.falseNegatives;
        if (kind.precisionCounted) {
            precisionTp += kind.precisionTruePositives;
            precisionDenominator += kind.truePositives + kind.falsePositives;
        }
        fp += kind.falsePositives;
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

const line = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);

console.log("\n=== 같은 검토자, 두 경로 ===");
console.log("합성 case 4건. gold는 'c가 기한을 제시하지 않는다', exhaustive.");
console.log("검토 4건 중 올바른 발견은 2건, 오지목 1건, 반대 주장 1건.\n");

const keywordOutcomes = [];
const judgedEntries = [];
for (const [index, [name, text, kind]] of REVIEWS.entries()) {
    const id = `synthetic-${index + 1}`;
    keywordOutcomes.push(scoreCase(keywordCase(id), observationOf(text)));
    const testCase = judgedCase(id);
    const record = judgedRecordFor(id, kind, text);
    judgedEntries.push({
        caseId: id,
        observationRef: record.observationRef,
        contractVersion: record.contractVersion,
        integrityProblems: verifyJudgementRecord(testCase, record),
        outcome: scoreJudgedCase(testCase, record),
    });
    console.log(`  ${String(index + 1).padStart(2)}. ${name.padEnd(20)} “${text}”`);
}

const keywordArm = aggregateOutcomes(keywordOutcomes);
console.log("\n[키워드 경로 — 실제 게이트 코드]");
line("omission recall (Wilson 하한)", keywordArm.omissionRecall.wilsonLower?.toFixed(3) ?? "n/a");
line("omission precision (Wilson 하한)", keywordArm.omissionPrecision.wilsonLower?.toFixed(3) ?? "n/a");
line(
    "TP / FN / FP",
    `${keywordArm.omissionRecall.numerator} / ` +
        `${keywordArm.omissionRecall.denominator - keywordArm.omissionRecall.numerator} / ` +
        `${keywordArm.omissionPrecision.denominator - keywordArm.omissionPrecision.numerator}`
);

const judged = aggregateJudged(judgedEntries);
console.log("\n[judged-v3 경로 — 제안, 이 파일에만 있음]");
if (!judged.aggregable) {
    line("집계 가능", "아니오");
    for (const blocker of judged.blockers) console.log(`      - ${blocker}`);
} else {
    line("집계 가능", "예");
    line("TP / FN / FP", `${judged.counts.tp} / ${judged.counts.fn} / ${judged.counts.fp}`);
    line("omission recall (Wilson 하한)", judged.omissionRecallWilsonLower.toFixed(3));
    line(
        "omission precision (Wilson 하한)",
        judged.omissionPrecisionWilsonLower?.toFixed(3) ?? "n/a"
    );
}

// The live gate's verdict on the keyword numbers. The judged numbers are NOT
// put through it: no threshold set has been written for this scale, and
// reusing v1-draft's would be exactly the carry-over the design forbids.
console.log("\n[승인 판정 — v1-draft 임계값]");
const shortfalls = thresholdShortfalls({
    thresholds: THRESHOLDS,
    aggregate: approvalMetricsFromArm(keywordArm),
    byLanguage: [],
    byTaskType: [],
    zeroToleranceViolations: 0,
});
const omissionRows = shortfalls.filter((problem) => problem.includes("omission"));
console.log("  키워드 경로, omission 관련 판정:");
for (const row of omissionRows) console.log(`      - ${row}`);
if (omissionRows.length === 0) console.log("      - (omission 지표는 통과)");
console.log(
    "\n  judged-v3 경로는 이 표에 넣지 않는다. 이 척도의 임계값은 아직 쓰이지 않았고,\n" +
        "  v1-draft의 숫자를 재사용하는 것이 전환안이 금지하는 승계다."
);

// ---------------------------------------------------------------------------
// Run-level aggregation: the four states that must stop a run
// ---------------------------------------------------------------------------

console.log("\n=== 실행 전체 집계 조건 — 제안 ===");
const base = judgedEntries[0];
const states = [
    ["판정 누락", [{ ...base, missing: true }]],
    [
        "같은 출력에 판정 둘",
        [base, { ...base, observationRef: base.observationRef }],
    ],
    [
        "계약 버전 혼합",
        [base, { ...base, caseId: "synthetic-old", contractVersion: "ai-review-scoring-judged-v2" }],
    ],
    [
        "판정 미완료 (pending)",
        (() => {
            const testCase = judgedCase("synthetic-pending");
            const record = judgedRecordFor("synthetic-pending", "correct", "…");
            const pending = {
                ...record,
                claims: [{ ...record.claims[0], status: "pending", confirmedBy: null, confirmedAt: null }],
            };
            return [
                {
                    caseId: "synthetic-pending",
                    observationRef: pending.observationRef,
                    contractVersion: pending.contractVersion,
                    integrityProblems: verifyJudgementRecord(testCase, pending),
                    outcome: scoreJudgedCase(testCase, pending),
                },
            ];
        })(),
    ],
];
for (const [name, entries] of states) {
    const result = aggregateJudged(entries);
    console.log(`  ${name.padEnd(22)} 집계 ${result.aggregable ? "가능" : "불가"}`);
    if (!result.aggregable) console.log(`      ${result.blockers[0]}`);
}

console.log("\nNo provider was called and no file was written.");
