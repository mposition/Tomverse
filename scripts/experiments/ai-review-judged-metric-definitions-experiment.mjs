// What the two undefined metrics would say, under each candidate definition.
//
// Written up in
// .github/audits/ai-review-judged-metric-definitions-2026-09-09.md.
//
//   npm run experiment:ai-review-judged-metric-definitions
//
// ## What this is
//
// A definition experiment, not a measurement. Every case here is SYNTHETIC:
// this file wrote the questions, the answers, the reviewer output and the
// judgements, so no number below says anything about any reviewer. What the
// numbers do is separate candidate definitions that agree on ordinary cases
// and disagree on the ones that decide the choice.
//
// The frozen candidate sets are read only to report what population each
// definition would have on them. Nothing is written anywhere, no provider is
// called and no ledger line exists.
//
// ## The two questions
//
// `falseConsensusRate` is named for a claim the reviewer makes and computed
// from whether it matched anything -- two different things.
// `inventedIssueRate` counts submissions rather than reading them, so a
// reviewer that is right about a case classified as having no issue is
// recorded as having invented one.

import { readFileSync } from "node:fs";

import {
    AI_REVIEW_EVAL_FINDING_KINDS,
    AI_REVIEW_EVAL_NEGATIVE_PHENOMENA,
} from "../../lib/aiReviewEvalCore.ts";
import {
    AI_REVIEW_SCORING_CONTRACT_VERSION,
    judgedScoredClaims,
    judgedSourceCaseDigest,
    observationRefFor,
    scoreJudgedCase,
} from "../../lib/aiReviewEvalJudgement.ts";

const SIGNER = "SYNTHETIC-DEFINITION-EXPERIMENT (not a person)";
const AT = "2026-09-09T00:00:00.000Z";

const heading = (text) => console.log(`\n=== ${text} ===`);
const rule = (width) => console.log("  " + "-".repeat(width));

/**
 * Pad to a COLUMN width, counting Korean and other wide glyphs as two.
 *
 * `padEnd` counts code units, so a header of Korean labels and a body of
 * ASCII ids drifted apart by one column per syllable and the table stopped
 * lining up at all.
 */
const width = (text) =>
    [...String(text)].reduce(
        (total, character) =>
            total + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(character) ? 2 : 1),
        0
    );
const cell = (text, size) => `${text}${" ".repeat(Math.max(1, size - width(text)))}`;
const row = (values, sizes) =>
    console.log("  " + values.map((value, index) => cell(String(value), sizes[index])).join(""));

// ---------------------------------------------------------------------------
// The synthetic cases
//
// Each one is here because it separates two candidate definitions. The
// ordinary cases (1, 4) are included so the separating ones are visible as
// exceptions rather than as the whole population.
// ---------------------------------------------------------------------------

const REQ = { id: "deadline", description: "the statutory deadline" };

/** @type {readonly {id: string, why: string, phenomenon: string, gold: object, goldCompleteness: object, submissions: object, claims: readonly object[]}[]} */
const CASES = [
    {
        id: "syn-01-named",
        why: "심은 항목을 정확히 보고했다 — 모든 정의가 같은 답을 낸다",
        phenomenon: "omission",
        gold: { missingPoints: [{ requirementId: REQ.id, targetLabel: "c" }] },
        goldCompleteness: { missingPoints: true },
        submissions: { missingPoints: ["[SYN] c omits the two-week deadline"] },
        claims: [
            {
                submittedAs: "missingPoints",
                sourceIndex: 0,
                targetLabel: "c",
                requirementId: REQ.id,
                assertion: "missing",
                speechAct: "finding",
            },
        ],
    },
    {
        id: "syn-02-vague",
        why: "요구를 겨눴으나 아무것도 짚지 않았다 — TP 0이지만 '아무것도 말하지 않았다'와 다르다",
        phenomenon: "omission",
        gold: { missingPoints: [{ requirementId: REQ.id, targetLabel: "c" }] },
        goldCompleteness: { missingPoints: true },
        submissions: { missingPoints: ["[SYN] c's procedural advice feels thin"] },
        claims: [
            {
                submittedAs: "missingPoints",
                sourceIndex: 0,
                targetLabel: "c",
                requirementId: REQ.id,
                assertion: "missing",
                speechAct: "finding",
                sufficiency: "insufficient",
            },
        ],
    },
    {
        id: "syn-03-quoted",
        why: "인용을 발견 필드에 넣었다 — FP 1이지만 지어낸 것이 아니다",
        phenomenon: "omission",
        gold: { missingPoints: [{ requirementId: REQ.id, targetLabel: "c" }] },
        goldCompleteness: { missingPoints: true },
        submissions: { missingPoints: ['[SYN] c says "제출하세요" about the deadline'] },
        claims: [
            {
                submittedAs: "missingPoints",
                sourceIndex: 0,
                targetLabel: "c",
                requirementId: REQ.id,
                assertion: "missing",
                speechAct: "quotation",
            },
        ],
    },
    {
        id: "syn-04-negative-quiet",
        why: "문제 없는 case에서 아무것도 보고하지 않았다 — 모든 정의가 같은 답을 낸다",
        phenomenon: "no_issue",
        gold: {},
        goldCompleteness: {},
        submissions: {},
        claims: [],
    },
    {
        id: "syn-05-negative-invented",
        why: "문제 없는 case에서 없는 것을 보고했다 — **FP 합계는 0이다**(gold가 exhaustive가 아니므로)",
        phenomenon: "no_issue",
        gold: {},
        goldCompleteness: {},
        submissions: { contradictions: ["[SYN] a and b disagree about the fee"] },
        claims: [
            {
                submittedAs: "contradictions",
                sourceIndex: 0,
                targetLabel: "a",
                requirementId: "fee-amount",
                assertion: "missing",
                speechAct: "finding",
                outsideGoldVerdict: "false_finding",
            },
        ],
    },
    {
        id: "syn-06-negative-right",
        why: "문제 없다고 분류된 case에서 **옳은** 지적을 했다 — 옛 정의는 '지어냈다'로 센다",
        phenomenon: "no_issue",
        gold: {},
        goldCompleteness: {},
        submissions: { contradictions: ["[SYN] a and b give different filing offices"] },
        claims: [
            {
                submittedAs: "contradictions",
                sourceIndex: 0,
                targetLabel: "a",
                requirementId: "filing-office",
                assertion: "missing",
                speechAct: "finding",
                outsideGoldVerdict: "gold_incomplete",
            },
        ],
    },
    {
        id: "syn-07-planted-and-invented",
        why: "심은 항목이 있는 case에서 없는 것을 보고했다 — 옛 정의는 세지 않는다(음성 case가 아니므로)",
        phenomenon: "omission",
        gold: { missingPoints: [{ requirementId: REQ.id, targetLabel: "c" }] },
        goldCompleteness: { missingPoints: false },
        submissions: {
            missingPoints: ["[SYN] c omits the two-week deadline"],
            contradictions: ["[SYN] a and b disagree about the fee"],
        },
        claims: [
            {
                submittedAs: "missingPoints",
                sourceIndex: 0,
                targetLabel: "c",
                requirementId: REQ.id,
                assertion: "missing",
                speechAct: "finding",
            },
            {
                submittedAs: "contradictions",
                sourceIndex: 0,
                targetLabel: "a",
                requirementId: "fee-amount",
                assertion: "missing",
                speechAct: "finding",
                outsideGoldVerdict: "false_finding",
            },
        ],
    },
    {
        id: "syn-08-support-verdict",
        why: "정상 발견 옆의 `support` claim에 false_finding — 채점에서 제외되는데 순진한 집계는 센다",
        phenomenon: "omission",
        gold: { missingPoints: [{ requirementId: REQ.id, targetLabel: "c" }] },
        goldCompleteness: { missingPoints: true },
        submissions: {
            missingPoints: ["[SYN] c omits the two-week deadline; the fee also differs"],
        },
        claims: [
            {
                submittedAs: "missingPoints",
                sourceIndex: 0,
                targetLabel: "c",
                requirementId: REQ.id,
                assertion: "missing",
                speechAct: "finding",
            },
            {
                submittedAs: "missingPoints",
                sourceIndex: 0,
                targetLabel: "a",
                requirementId: "fee-amount",
                assertion: "missing",
                speechAct: "finding",
                role: "support",
                outsideGoldVerdict: "false_finding",
            },
        ],
    },
    {
        id: "syn-09-quotation-verdict",
        why: "인용에 false_finding — 제출 품질 문제이지 지어낸 발견이 아닌데 순진한 집계는 센다",
        phenomenon: "omission",
        gold: { missingPoints: [{ requirementId: REQ.id, targetLabel: "c" }] },
        goldCompleteness: { missingPoints: true },
        submissions: {
            missingPoints: ["[SYN] c omits the two-week deadline"],
            contradictions: ['[SYN] a says "the fee is 10,000 won"'],
        },
        claims: [
            {
                submittedAs: "missingPoints",
                sourceIndex: 0,
                targetLabel: "c",
                requirementId: REQ.id,
                assertion: "missing",
                speechAct: "finding",
            },
            {
                submittedAs: "contradictions",
                sourceIndex: 0,
                targetLabel: "a",
                requirementId: "fee-amount",
                assertion: "missing",
                speechAct: "quotation",
                outsideGoldVerdict: "false_finding",
            },
        ],
    },
    {
        id: "syn-10-lone-support",
        why: "옆에 독립 발견이 없는 단독 `support` — 제외 사유가 없어 모집단에 남고, 같은 세 조건을 충족한다",
        phenomenon: "no_issue",
        gold: {},
        goldCompleteness: {},
        submissions: { contradictions: ["[SYN] a and b disagree about the fee"] },
        claims: [
            {
                submittedAs: "contradictions",
                sourceIndex: 0,
                targetLabel: "a",
                requirementId: "fee-amount",
                assertion: "missing",
                speechAct: "finding",
                role: "support",
                outsideGoldVerdict: "false_finding",
            },
        ],
    },
    {
        id: "syn-11-negative-exhaustive",
        why: "음성 case를 **exhaustive 빈 gold**로 등록하면 FP가 1이다 — FP 0의 원인은 음성 분류가 아니다",
        phenomenon: "no_issue",
        gold: { contradictions: [] },
        goldCompleteness: { contradictions: true },
        submissions: { contradictions: ["[SYN] a and b disagree about the fee"] },
        claims: [
            {
                submittedAs: "contradictions",
                sourceIndex: 0,
                targetLabel: "a",
                requirementId: "fee-amount",
                assertion: "missing",
                speechAct: "finding",
                outsideGoldVerdict: "false_finding",
            },
        ],
    },
];

// ---------------------------------------------------------------------------
// Score them
// ---------------------------------------------------------------------------

/** The dataset case a person would have read. Synthetic, and says so. */
const sourceCaseFor = (definition) => ({
    id: definition.id,
    question: `[SYNTHETIC] ${definition.id}`,
    responses: ["a", "b", "c"].map((label) => ({
        label,
        content: `[SYNTHETIC] answer ${label} of ${definition.id}`,
    })),
});

const observationFor = (definition) => {
    const findings = Object.fromEntries(
        AI_REVIEW_EVAL_FINDING_KINDS.map((kind) => [
            kind,
            definition.submissions[kind] ?? [],
        ])
    );
    const allText = AI_REVIEW_EVAL_FINDING_KINDS.flatMap((kind) => findings[kind]).join(
        "\n"
    );
    return {
        findings,
        allText,
        reviewerProse: allText,
        totalQuotes: 0,
        matchedQuotes: 0,
        schemaValid: true,
    };
};

const scoreOne = (definition) => {
    const sourceCase = sourceCaseFor(definition);
    const observation = observationFor(definition);
    const testCase = {
        caseId: definition.id,
        contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
        sourceCaseDigest: judgedSourceCaseDigest(sourceCase),
        responseLabels: sourceCase.responses.map((response) => response.label),
        requirements: [
            REQ,
            { id: "fee-amount", description: "the filing fee" },
            { id: "filing-office", description: "where to file" },
        ],
        gold: definition.gold,
        goldCompleteness: definition.goldCompleteness,
    };
    const record = {
        caseId: definition.id,
        contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
        observationRef: observationRefFor(observation),
        reviewedBy: SIGNER,
        reviewedAt: AT,
        sourceCaseDigest: testCase.sourceCaseDigest,
        claims: definition.claims.map((claim) => ({
            ...claim,
            evidenceQuote: definition.submissions[claim.submittedAs][claim.sourceIndex],
            status: "confirmed",
            confirmedBy: SIGNER,
            confirmedAt: AT,
        })),
    };
    const outcome = scoreJudgedCase(testCase, record, { observation });
    if (!outcome.scored) throw new Error(`${definition.id}\n${outcome.reason}`);
    return { definition, testCase, record, outcome };
};

const scored = CASES.map(scoreOne);

// ---------------------------------------------------------------------------
// The per-case facts every candidate definition reads
// ---------------------------------------------------------------------------

const sum = (outcome, field) =>
    AI_REVIEW_EVAL_FINDING_KINDS.reduce((total, kind) => total + outcome.byKind[kind][field], 0);

const factsFor = ({ definition, testCase, record, outcome }) => {
    const claims = record.claims;
    const planted = AI_REVIEW_EVAL_FINDING_KINDS.reduce(
        (total, kind) => total + (testCase.gold[kind]?.length ?? 0),
        0
    );
    return {
        id: definition.id,
        why: definition.why,
        negative: AI_REVIEW_EVAL_NEGATIVE_PHENOMENA.includes(definition.phenomenon),
        planted,
        truePositives: sum(outcome, "truePositives"),
        insufficient: sum(outcome, "insufficientFindings"),
        falsePositives: sum(outcome, "falsePositives"),
        goldGaps: sum(outcome, "goldGaps"),
        // Not `claims.filter(verdict === "false_finding")`. That reads the raw
        // record, which still holds the two things the contract already
        // excluded: supporting material sitting inside another finding, and a
        // quotation filed into a findings field. Both were counted as findings
        // the reviewer invented while the document said they were not.
        //
        // `judgedScoredClaims()` is the population the score itself was
        // computed from, and the two further conditions are what "a finding
        // the reviewer put forward and made up" means:
        //   * `speechAct === "finding"` -- a quotation, hypothetical or
        //     passing mention in a findings field is a submission-quality
        //     failure, and it is already counted as a false positive.
        //   * `status === "confirmed"` -- a pending claim is not a judgement;
        //     a case holding one is not scored at all, so this can only
        //     matter to a caller reading an unscored record.
        // `outsideGoldVerdict` needs no separate outside-the-gold test:
        // `verifyJudgementRecord()` refuses the field on a claim the gold
        // does contain, so on a verified record its presence IS that fact.
        falseFindings: judgedScoredClaims(record).filter(
            (claim) =>
                claim.speechAct === "finding" &&
                claim.status === "confirmed" &&
                claim.outsideGoldVerdict === "false_finding"
        ).length,
        /** The same count taken the naive way, to show what it lets through. */
        falseFindingsUnfiltered: claims.filter(
            (claim) => claim.outsideGoldVerdict === "false_finding"
        ).length,
        // What the current invented-issue rule reads: how many items were
        // submitted as contradictions, whatever they say.
        reportedContradictions: (definition.submissions.contradictions ?? []).length,
    };
};

const facts = scored.map(factsFor);

heading("1. 합성 case별 사실 — 어느 정의도 아직 적용하지 않았다");
console.log(
    `  이 ${CASES.length}건은 전부 이 파일이 쓴 것이다. 어떤 검토자에 대해서도 아무 말을 하지 않는다.\n`
);
const COLUMNS = [
    ["case", 29],
    ["음성", 7],
    ["심은", 7],
    ["TP", 5],
    ["불충분", 9],
    ["FP", 5],
    ["gold gap", 10],
    ["false_finding", 15],
    ["순진한 집계", 13],
    ["제출(모순)", 12],
];
const SIZES = COLUMNS.map(([, size]) => size);
row(COLUMNS.map(([name]) => name), SIZES);
rule(SIZES.reduce((total, size) => total + size, 0));
for (const fact of facts) {
    row(
        [
            fact.id,
            fact.negative ? "예" : "아니오",
            fact.planted,
            fact.truePositives,
            fact.insufficient,
            fact.falsePositives,
            fact.goldGaps,
            fact.falseFindings,
            fact.falseFindingsUnfiltered,
            fact.reportedContradictions,
        ],
        SIZES
    );
}
console.log("");
for (const fact of facts) console.log(`  ${cell(fact.id, 29)}${fact.why}`);

// ---------------------------------------------------------------------------
// The candidate definitions
// ---------------------------------------------------------------------------

const asRate = (numerator, denominator) =>
    denominator === 0
        ? `— (분모 0)`
        : `${numerator}/${denominator} = ${(numerator / denominator).toFixed(3)}`;

heading("2. false-consensus 후보 정의");
console.log(
    "  이름이 말하는 '합의라고 주장했다'는 어느 후보도 재지 않는다. 그 판정 축이\n" +
        "  judged-v3에 없기 때문이며, 그것이 이름을 바꾸는 이유다.\n"
);

const consensusCandidates = [
    {
        key: "A1",
        label: "심은 항목을 하나도 보고하지 못한 case 비율 (TP 합계 = 0)",
        applies: (fact) => !fact.negative && fact.planted > 0,
        hit: (fact) => fact.truePositives === 0,
    },
    {
        key: "A2",
        label: "위와 같되, 겨누기라도 한 case는 제외 (TP = 0 그리고 불충분 = 0)",
        applies: (fact) => !fact.negative && fact.planted > 0,
        hit: (fact) => fact.truePositives === 0 && fact.insufficient === 0,
    },
];
for (const candidate of consensusCandidates) {
    const applicable = facts.filter(candidate.applies);
    const hits = applicable.filter(candidate.hit);
    console.log(`  ${candidate.key}  ${candidate.label}`);
    console.log(
        `      ${asRate(hits.length, applicable.length)}   해당: ${
            hits.map((fact) => fact.id).join(", ") || "(없음)"
        }`
    );
}
console.log(
    "\n  두 후보는 syn-02에서만 갈린다. A1은 '겨눴으나 짚지 못한 것'도 보고 실패로\n" +
        "  세고, A2는 세지 않는다. 어느 쪽을 고르든 나머지 한쪽은 **별도 진단 수치**로\n" +
        "  남겨야 두 상태가 한 숫자 안에서 사라지지 않는다."
);

heading("3. invented-issue 후보 정의");
console.log(
    "  **부분집합은 분자와 분모를 함께 제한한다.** 전체 분자를 음성 분모로 나누면\n" +
        "  어느 모집단에 대한 비율도 아닌 숫자가 나온다.\n"
);
const inventedCandidates = [
    {
        key: "현행",
        label: "음성 case에서 모순을 하나라도 제출했는가 (내용을 읽지 않음)",
        applies: (fact) => fact.negative,
        hit: (fact) => fact.reportedContradictions > 0,
    },
    {
        key: "B1",
        label: "확정 false_finding ≥ 1인 case 비율 — 음성 case만",
        applies: (fact) => fact.negative,
        hit: (fact) => fact.falseFindings > 0,
    },
    {
        key: "B2",
        label: "확정 false_finding ≥ 1인 case 비율 — 채점된 모든 case (권고)",
        applies: () => true,
        hit: (fact) => fact.falseFindings > 0,
    },
    {
        key: "B2음성",
        label: "B2의 음성 부분집합 — 분자·분모 **둘 다** 음성으로 제한",
        applies: (fact) => fact.negative,
        hit: (fact) => fact.falseFindings > 0,
    },
    {
        key: "B2순진",
        label: "B2를 순진하게 집계 — role·speechAct를 읽지 않음 (거부 후보)",
        applies: () => true,
        hit: (fact) => fact.falseFindingsUnfiltered > 0,
    },
    {
        key: "B3",
        label: "FP가 하나라도 있는 case 비율 — 음성 case만 (거부 후보)",
        applies: (fact) => fact.negative,
        hit: (fact) => fact.falsePositives > 0,
    },
];
for (const candidate of inventedCandidates) {
    const applicable = facts.filter(candidate.applies);
    const hits = applicable.filter(candidate.hit);
    console.log(`  ${cell(candidate.key, 9)}${candidate.label}`);
    console.log(
        `        ${asRate(hits.length, applicable.length)}   해당: ${
            hits.map((fact) => fact.id).join(", ") || "(없음)"
        }`
    );
}

// The wrong subset, computed rather than described: the recommended
// numerator over the negative denominator. Printed because "the same
// numerator with the negative denominator" was written into the decision
// draft as if it were a subset, and it is not a proportion of anything.
const negativeFacts = facts.filter((fact) => fact.negative);
const allHits = facts.filter((fact) => fact.falseFindings > 0).length;
console.log(
    `\n  (잘못된 부분집합) 전체 분자 ÷ 음성 분모 = ` +
        `${asRate(allHits, negativeFacts.length)} — 이 비율의 모집단은 존재하지 않는다.`
);

console.log(
    "\n  갈리는 자리.\n" +
        "    syn-06  현행은 '지어냈다'로 세고, 나머지는 세지 않는다 — 옳은 지적이었고\n" +
        "            틀린 것은 case의 분류다(gold gap 1).\n" +
        "    syn-05  B3가 0을 낸다. 이 case의 gold가 exhaustive가 아니므로 FP가\n" +
        "            세어지지 않는다 — 지어낸 발견이 FP 합계에서 사라진다.\n" +
        "    syn-11  같은 음성 fixture를 exhaustive 빈 gold로 등록하면 FP는 1이다.\n" +
        "            **FP 0의 원인은 음성 분류가 아니라 비완전 gold다.**\n" +
        "    syn-07  양성 case의 지어낸 발견을 B2만 센다.\n" +
        "    syn-08  정상 발견 옆의 `support`에 붙은 verdict를 B2순진만 센다.\n" +
        "    syn-09  인용에 붙은 verdict를 B2순진만 센다."
);

// ---------------------------------------------------------------------------
// What population each definition would have on the sets in the tree
// ---------------------------------------------------------------------------

heading("4. 트리의 후보 set에서 각 정의가 갖는 분모");
console.log(
    "  숫자를 내지 않는다. **분모가 0이면 그 정의는 그 set에서 아무 말도 하지 못한다**는\n" +
        "  사실만 보고한다.\n"
);
const SETS = ["decision-v2", "decision-v1", "development-v0"];
const SET_SIZES = [17, 8, 7, 13, 10, 10];
row(["set", "cases", "음성", "양성 + 심음", "B1 분모", "B2 분모"], SET_SIZES);
rule(SET_SIZES.reduce((total, size) => total + size, 0));
for (const name of SETS) {
    const set = JSON.parse(
        readFileSync(`docs/ops/ai-review-evaluation-set/${name}.json`, "utf8")
    );
    const cases = set.cases ?? [];
    const negative = cases.filter((item) =>
        AI_REVIEW_EVAL_NEGATIVE_PHENOMENA.includes(item.phenomenon)
    ).length;
    const plantedPositive = cases.filter(
        (item) =>
            !AI_REVIEW_EVAL_NEGATIVE_PHENOMENA.includes(item.phenomenon) &&
            AI_REVIEW_EVAL_FINDING_KINDS.some((kind) => (item.gold?.[kind]?.length ?? 0) > 0)
    ).length;
    row([name, cases.length, negative, plantedPositive, negative, cases.length], SET_SIZES);
}
console.log(
    "\n  decision-v2에는 음성 phenomenon case가 없다. **현행 정의와 B1은 오늘의 후보\n" +
        "  set에서 숫자를 만들 수 없다** — 0%가 아니라 분모 0이다."
);

console.log(
    "\nNothing was written. No provider was called, no candidate set was edited and\n" +
        "no threshold was set: this compares definitions, and a person chooses."
);
