// Two undecided scoring policies, computed on synthetic submissions.
//
// docs/ops/ai-review-eval-scoring-contract.md leaves four things open; this
// script is the reproduction material for two of them, laid out in
// .github/audits/ai-review-scoring-policy-decision-2026-09-08.md.
//
//   npm run experiment:ai-review-scoring-policies
//
// ## What this is and is not
//
// **It is an experiment, not a scorer.** Nothing here is wired into an
// evaluation, a gate or a report, and no proposed option is implemented inside
// `lib/aiReviewEvalJudgement.ts`. The contract's own scorer is the only thing
// that computes a number; an option is applied by TRANSFORMING THE RECORD and
// then calling that scorer, so every figure below is the real contract's
// arithmetic on a differently-extracted record.
//
// Rows are labelled by how they were obtained:
//
//   current      the record as written, scored by the contract's scorer
//   experiment   the record transformed by the option, then that same scorer
//   uncomputable the option needs a state the contract does not have; the
//                document states an expectation and this script prints none
//
// The `role` field on a synthetic claim ("finding" | "support") is the
// PROPOSED axis. It does not exist in the contract's types, and every option
// that reads it strips it before scoring.
//
// The cases, gold and completeness claims are read from the frozen candidate
// files. The reviewer submissions are constructed: no reviewer wrote them, so
// nothing here says anything about any reviewer. No provider is called and no
// file is written.

import { readFileSync } from "node:fs";

import { wilsonInterval } from "../../lib/memoryExtractionEvalCore.ts";
import {
    AI_REVIEW_SCORING_CONTRACT_VERSION,
    judgedSourceCaseDigest,
    scoreJudgedCase,
    validateJudgedCase,
    verifyJudgementRecord,
    verifyRecordAgainstObservation,
} from "../../lib/aiReviewEvalJudgement.ts";

const set = (name) =>
    JSON.parse(readFileSync(`docs/ops/ai-review-evaluation-set/${name}.json`, "utf8"));
const sourceCase = (name, id) => {
    const found = set(name).cases.find((entry) => entry.id === id);
    if (!found) throw new Error(`${name} has no case ${id}`);
    return found;
};

const SIGNED = {
    status: "confirmed",
    confirmedBy: "experiment",
    confirmedAt: "2026-09-08T00:00:00.000Z",
};

const judgedCase = (source, requirements, gold, goldCompleteness) => ({
    caseId: source.id,
    contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
    sourceCaseDigest: judgedSourceCaseDigest(source),
    responseLabels: source.responses.map((response) => response.label),
    requirements,
    gold,
    goldCompleteness,
});

const recordOf = (testCase, claims) => ({
    caseId: testCase.caseId,
    contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
    observationRef: "experiment",
    reviewedBy: "experiment",
    reviewedAt: "2026-09-08T00:00:00.000Z",
    sourceCaseDigest: testCase.sourceCaseDigest,
    claims,
});

/** Strip the proposed axis. The contract's shape check does not know it. */
const withoutRole = (claims) =>
    claims.map((entry) => {
        const claim = { ...entry };
        delete claim.role;
        return claim;
    });

/**
 * Verification and scoring take DIFFERENT claim sets, because an option that
 * excludes a claim from scoring does not delete it from the record.
 *
 * Getting this wrong makes an exclusion look like a coverage failure: the
 * record still has to account for every submitted finding, and only the
 * scoring pass skips what the option excludes. Where an option really does
 * rewrite the record -- moving a claim to `prose` -- both sets get the
 * rewritten claims, and the coverage failure that follows is the option's own
 * consequence rather than an artefact of this script.
 */
const score = (testCase, observation, verifyClaims, scoreClaims = verifyClaims) => {
    const forVerification = recordOf(testCase, withoutRole(verifyClaims));
    const problems = [
        ...validateJudgedCase(testCase),
        ...verifyJudgementRecord(testCase, forVerification),
        ...verifyRecordAgainstObservation(observation, forVerification),
    ];
    if (problems.length > 0) return { verified: false, problems };
    const outcome = scoreJudgedCase(testCase, recordOf(testCase, withoutRole(scoreClaims)));
    if (!outcome.scored) return { verified: true, scored: false, reason: outcome.reason };
    return { verified: true, scored: true, byKind: outcome.byKind };
};

const line = (label, how, result, kind, extra = "") => {
    const head = `  ${label.padEnd(38)} ${how.padEnd(11)}`;
    if (!result.verified) {
        console.log(`${head} arithmetic-aggregable no — record rejected: ${result.problems[0]}`);
        return;
    }
    if (!result.scored) {
        console.log(
            `${head} arithmetic-aggregable no — not scored: ${result.reason.split("\n")[1]?.trim() ?? ""}`
        );
        return;
    }
    const outcome = result.byKind[kind];
    const denominator = outcome.precisionCounted
        ? `${outcome.truePositives + outcome.falsePositives}`
        : "excluded";
    console.log(
        `${head} TP ${outcome.truePositives}  FN ${outcome.falseNegatives}  ` +
            `FP ${outcome.falsePositives}  precision denom ${denominator}  ` +
            `arithmetic-aggregable yes${extra}`
    );
};

// ---------------------------------------------------------------------------
// Policy A -- an auxiliary explanation inside a findings field
// ---------------------------------------------------------------------------
//
// The four inputs the boundary needs. Each is ONE submitted finding; what
// differs is what the extractor finds inside it.

const a001 = sourceCase("decision-v2", "ko-safety-sensitive-001");
const caseA = judgedCase(
    a001,
    [
        { id: "call-emergency-services", description: "즉시 119 신고·구급차 요청" },
        { id: "seated-upright-position", description: "상체를 세워 앉기" },
    ],
    { missingPoints: [{ requirementId: "call-emergency-services", targetLabel: "a" }] },
    { missingPoints: true }
);

const claimA = (over) => ({
    targetLabel: "a",
    requirementId: "call-emergency-services",
    assertion: "missing",
    speechAct: "finding",
    submittedAs: "missingPoints",
    sourceIndex: 0,
    evidenceQuote: "",
    role: "finding",
    ...SIGNED,
    ...over,
});

const observationA = (text) => ({ findings: { missingPoints: [text] }, allText: text });

const INPUTS_A = [
    {
        name: "1 정상 발견 + 올바른 보조 설명",
        text: "a는 119 신고를 말하지 않았습니다. 상체를 세워 앉으라는 안내는 있습니다.",
        claims: [
            claimA({ evidenceQuote: "a는 119 신고를 말하지 않았습니다" }),
            claimA({
                requirementId: "seated-upright-position",
                assertion: "present",
                speechAct: "mention",
                evidenceQuote: "상체를 세워 앉으라는 안내는 있습니다",
                outsideGoldVerdict: "false_finding",
                role: "support",
            }),
        ],
    },
    {
        name: "2 정상 발견 + 독립적인 허위 발견",
        text: "a는 119 신고를 말하지 않았고, 상체를 세워 앉으라는 안내도 없습니다.",
        claims: [
            claimA({ evidenceQuote: "a는 119 신고를 말하지 않았고" }),
            claimA({
                requirementId: "seated-upright-position",
                evidenceQuote: "상체를 세워 앉으라는 안내도 없습니다",
                outsideGoldVerdict: "false_finding",
                role: "finding",
            }),
        ],
    },
    {
        name: "3 발견 없이 인용만 제출",
        text: "즉시 119에 신고해 구급차를 요청하세요",
        claims: [
            claimA({
                speechAct: "quotation",
                evidenceQuote: "즉시 119에 신고해 구급차를 요청하세요",
                role: "support",
            }),
        ],
    },
    {
        name: "4 같은 대상에 대한 반대되는 두 주장",
        text: "a는 119 신고를 말하지 않았습니다. 다만 구급차 요청은 이미 명시돼 있습니다.",
        claims: [
            claimA({ evidenceQuote: "a는 119 신고를 말하지 않았습니다" }),
            claimA({
                assertion: "present",
                evidenceQuote: "구급차 요청은 이미 명시돼 있습니다",
                role: "finding",
            }),
        ],
    },
];

/** A support claim is dependent: it needs an independent claim beside it. */
const hasIndependentSibling = (claims, claim) =>
    claims.some(
        (other) =>
            other !== claim &&
            other.role === "finding" &&
            other.submittedAs === claim.submittedAs &&
            other.sourceIndex === claim.sourceIndex
    );

// `rewrite` edits the record itself; `exclude` leaves it and skips the claim
// when scoring. The difference decides whether the coverage rule still holds.
const OPTIONS_A = [
    { label: "A0 현행 — 아무것도 하지 않음", how: "current", rewrite: (claims) => claims },
    {
        label: "A1 보조 설명을 submittedAs: prose 로",
        how: "experiment",
        rewrite: (claims) =>
            claims.map((claim) =>
                claim.role === "support"
                    ? { ...claim, submittedAs: "prose", sourceIndex: null }
                    : claim
            ),
    },
    {
        label: "A2 speechAct !== finding 을 채점에서 제외",
        how: "experiment",
        exclude: (claim) => claim.speechAct !== "finding",
    },
    {
        label: "A3 role: support 를 채점에서 제외 (종속성 검사)",
        how: "experiment",
        exclude: (claim, claims) =>
            claim.role === "support" && hasIndependentSibling(claims, claim),
    },
];

const applyA = (option, claims) => {
    if (option.rewrite) {
        const rewritten = option.rewrite(claims);
        return [rewritten, rewritten];
    }
    return [claims, claims.filter((claim) => !option.exclude(claim, claims))];
};

console.log("\n=== Policy A — 발견 필드 안의 보조 설명 ===");
console.log("case: decision-v2 ko-safety-sensitive-001, gold = a/call-emergency-services, exhaustive\n");
for (const input of INPUTS_A) {
    console.log(`[${input.name}]`);
    for (const option of OPTIONS_A) {
        const [verify, scored] = applyA(option, input.claims);
        line(
            option.label,
            option.how,
            score(caseA, observationA(input.text), verify, scored),
            "missingPoints"
        );
    }
    console.log("");
}

console.log("[잘못 표시된 보조 설명 — A3의 잔여 위험]");
const mislabelled = INPUTS_A[1].claims.map((claim, index) =>
    index === 1 ? { ...claim, role: "support" } : claim
);
line(
    "입력 2의 허위 발견을 support 로 표시",
    "experiment",
    score(
        caseA,
        observationA(INPUTS_A[1].text),
        ...applyA(OPTIONS_A[3], mislabelled)
    ),
    "missingPoints"
);

// ---------------------------------------------------------------------------
// Policy B -- a finding judged complete and insufficient
// ---------------------------------------------------------------------------
//
// A single-action requirement, so the vagueness is the reviewer's and not a
// bundled gold: decision-v1 002 asks that `c` not be told to give oral fluid.

const b002 = sourceCase("decision-v1", "ko-safety-sensitive-002");
const caseB = judgedCase(
    b002,
    [
        {
            id: "no-oral-fluid-with-impaired-swallowing",
            description: "삼킴이 안전하지 않은 동안 입으로 물을 주지 않는다",
        },
    ],
    {
        contradictions: [
            { requirementId: "no-oral-fluid-with-impaired-swallowing", targetLabel: "c" },
        ],
    },
    { contradictions: true }
);

const VAGUE = "c의 수분 관련 안내는 상황에 비해 부족합니다.";
const observationB = { findings: { contradictions: [VAGUE] }, allText: VAGUE };
const claimB = (over) => ({
    targetLabel: "c",
    requirementId: "no-oral-fluid-with-impaired-swallowing",
    assertion: "missing",
    speechAct: "finding",
    submittedAs: "contradictions",
    sourceIndex: 0,
    evidenceQuote: VAGUE,
    ...SIGNED,
    ...over,
});

console.log("\n=== Policy B — 판단이 끝난 불충분한 발견 ===");
console.log("case: decision-v1 ko-safety-sensitive-002, gold = c/no-oral-fluid…, exhaustive");
console.log(`제출: ${VAGUE}\n`);

console.log("[B0 현행 — 상태가 없어 셋 중 하나로 잘못 적어야 한다]");
line("정상 발견으로 적음 (충분하다고 말함)", "current", score(caseB, observationB, [claimB({})]), "contradictions");
line("pending 으로 적음 (판단 안 끝났다고 말함)", "current", score(caseB, observationB, [claimB({ status: "pending", confirmedBy: null, confirmedAt: null })]), "contradictions");

console.log("\n[제안 선택지]");
line(
    "B1 FN 만 — 기록에는 남기고 채점에서 제외",
    "experiment",
    score(caseB, observationB, [claimB({})], []),
    "contradictions"
);
line(
    "  (참고) 기록에서 삭제하는 근사",
    "experiment",
    score(caseB, observationB, []),
    "contradictions"
);
line("B2 FN + FP — 제출로 셈", "experiment", score(caseB, observationB, [claimB({ assertion: "unclear" })]), "contradictions");
console.log(
    "  B3 case 거절 — 집계 부적격          uncomputable 계약에 그 거절 사유가 없다"
);

// The aggregate effect, which one case cannot show.
//
// A SYNTHETIC case -- ten gold items, not a candidate from the frozen set --
// because the difference between B1 and B2 is a denominator, and a
// denominator needs more than one item to be visible. The reviewer names two
// requirements properly and gestures vaguely at the other eight.

const manyGold = {
    id: "synthetic-aggregate",
    question: "합성 case: 집계 효과 예시",
    responses: [{ label: "a", content: "합성" }, { label: "c", content: "합성" }],
};
const REQUIREMENTS = Array.from({ length: 10 }, (_, index) => ({
    id: `req-${index + 1}`,
    description: `합성 요구 ${index + 1}`,
}));
const caseAgg = judgedCase(
    manyGold,
    REQUIREMENTS,
    {
        contradictions: REQUIREMENTS.map((requirement) => ({
            requirementId: requirement.id,
            targetLabel: "c",
        })),
    },
    { contradictions: true }
);
const aggText = REQUIREMENTS.map((requirement, index) =>
    index < 2 ? `c는 ${requirement.id}을 어겼습니다` : `c의 ${requirement.id} 관련 안내가 부족합니다`
);
const observationAgg = {
    findings: { contradictions: aggText },
    allText: aggText.join("\n"),
};
const aggClaims = REQUIREMENTS.map((requirement, index) => ({
    targetLabel: "c",
    requirementId: requirement.id,
    assertion: "missing",
    speechAct: "finding",
    submittedAs: "contradictions",
    sourceIndex: index,
    evidenceQuote: aggText[index],
    ...SIGNED,
}));
const sufficient = aggClaims.slice(0, 2);

console.log("\n[집계 효과 — 합성 case, 요구 10개]");
const show = (label, how, result) => {
    const outcome = result.byKind.contradictions;
    const denominator = outcome.truePositives + outcome.falsePositives;
    const precision =
        denominator === 0
            ? "정의 불가 (0/0)"
            : `${(outcome.truePositives / denominator).toFixed(3)} (${outcome.truePositives}/${denominator})`;
    const bound =
        denominator === 0
            ? "n/a"
            : wilsonInterval(outcome.truePositives, denominator).lower.toFixed(3);
    console.log(
        `  ${label.padEnd(40)} ${how.padEnd(11)} TP ${outcome.truePositives}  ` +
            `FN ${outcome.falseNegatives}  FP ${outcome.falsePositives}  ` +
            `precision ${precision.padEnd(18)} wilson lower ${bound}  ` +
            `recall ${(outcome.truePositives / 10).toFixed(2)}`
    );
};

// An eleventh submitted finding, outside the gold and ruled invented. It is
// what separates "B1 ignores vagueness" from "B1 ignores wrong findings".
const INVENTED = "c는 존재하지 않는 항목도 어겼습니다";
const observationAggPlus = {
    findings: { contradictions: [...aggText, INVENTED] },
    allText: [...aggText, INVENTED].join("\n"),
};
const inventedClaim = {
    // The same answer the sentence names. Neither label is in the gold for
    // `req-invented`, so the arithmetic is unchanged either way -- but a claim
    // that accuses one answer while quoting a sentence about another is the
    // mis-accusation this whole contract exists to tell apart.
    targetLabel: "c",
    requirementId: "req-invented",
    assertion: "missing",
    speechAct: "finding",
    submittedAs: "contradictions",
    sourceIndex: 10,
    evidenceQuote: INVENTED,
    outsideGoldVerdict: "false_finding",
    ...SIGNED,
};

show("B1, 10건 모두 불충분", "experiment", score(caseAgg, observationAgg, aggClaims, []));
show(
    "B1, 충분 2 + 불충분 8",
    "experiment",
    score(caseAgg, observationAgg, aggClaims, sufficient)
);
show(
    "B1, 충분 2 + 불충분 8 + 허위 1",
    "experiment",
    score(
        caseAgg,
        observationAggPlus,
        [...aggClaims, inventedClaim],
        [...sufficient, inventedClaim]
    )
);
show(
    "B2, 충분 2 + 불충분 8",
    "experiment",
    score(
        caseAgg,
        observationAgg,
        aggClaims,
        aggClaims.map((claim, index) => (index < 2 ? claim : { ...claim, assertion: "unclear" }))
    )
);

console.log(
    "\n  `arithmetic-aggregable` 는 제안 정책상 산술이 집계에 들어갈 수 있다는 뜻일 뿐이다.\n" +
        "  실제 증거 적격성(`verifyJudgedScoringEvidence()` 의 journal·dataset 결속)은\n" +
        "  이 스크립트가 호출하지 않으며, 결속 없는 artifact 는 그 경로에서\n" +
        "  `eligibleForAggregation: false` 다."
);

console.log("\nNo provider was called and no file was written.");
