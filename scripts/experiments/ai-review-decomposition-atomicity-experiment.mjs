// The two policies the scoring contract still leaves open, computed.
//
// docs/ops/ai-review-eval-scoring-contract.md §5 lists them: what counts as one
// independent assertion when a submission names several things, and whether a
// gold requirement may bundle more than one action. The comparison is written
// up in .github/audits/ai-review-decomposition-atomicity-2026-09-09.md.
//
//   npm run experiment:ai-review-decomposition-atomicity
//
// ## What this is
//
// An experiment, not a scorer. No proposed rule is implemented in
// `lib/aiReviewEvalJudgement.ts`; each option is applied by EXTRACTING THE
// RECORD DIFFERENTLY -- which is what these policies actually govern -- and the
// contract's own scorer produces every number.
//
//   baseline     the record as a submission-unit extractor would write it
//   experiment   the record as the proposed rule would have it extracted
//   observation  a measurement over the real candidate files, not a score
//
// The two policies do not take the same inputs, and saying so matters.
//
// Policy C runs on a SYNTHETIC source case: how many claims come out of one
// submission is a structural question, and a real answer with a gold invented
// to suit it reads as a finding somebody verified. Policy D runs on a real
// candidate, because there the semantics are the question.
//
// Those candidate files are NOT frozen: `frozenAt`, `frozenBy` and
// `frozenDigest` are all null and every case is still `candidate`. Nothing
// here edits them.
//
// Every reviewer submission is constructed. No reviewer wrote them, so nothing
// here says anything about any reviewer. No provider is called, no file
// written.

import { readFileSync } from "node:fs";

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
    confirmedAt: "2026-09-09T00:00:00.000Z",
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

const score = (testCase, observation, claims) => {
    const record = {
        caseId: testCase.caseId,
        contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
        observationRef: "experiment",
        reviewedBy: "experiment",
        reviewedAt: "2026-09-09T00:00:00.000Z",
        sourceCaseDigest: testCase.sourceCaseDigest,
        claims,
    };
    const problems = [
        ...validateJudgedCase(testCase),
        ...verifyJudgementRecord(testCase, record),
        ...verifyRecordAgainstObservation(observation, record),
    ];
    if (problems.length > 0) return { verified: false, problems };
    const outcome = scoreJudgedCase(testCase, record);
    return outcome.scored
        ? { verified: true, scored: true, byKind: outcome.byKind }
        : { verified: true, scored: false, reason: outcome.reason };
};

const line = (label, how, result, kind) => {
    const head = `  ${label.padEnd(42)} ${how.padEnd(11)}`;
    if (!result.verified) return console.log(`${head} record rejected: ${result.problems[0]}`);
    if (!result.scored) {
        return console.log(`${head} not scored: ${result.reason.split("\n")[1]?.trim() ?? ""}`);
    }
    const outcome = result.byKind[kind];
    const gold = outcome.truePositives + outcome.falseNegatives;
    console.log(
        `${head} TP ${outcome.truePositives}  FN ${outcome.falseNegatives}  ` +
            `FP ${outcome.falsePositives}  dup ${outcome.duplicates}  ` +
            `recall ${gold === 0 ? "n/a" : (outcome.truePositives / gold).toFixed(2)}`
    );
};

// ---------------------------------------------------------------------------
// Policy C -- what counts as one independent assertion
// ---------------------------------------------------------------------------

// A SYNTHETIC source case, not a frozen candidate.
//
// The first draft used decision-v2 001 and registered "a omits the
// do-not-drive-yourself requirement" as gold so that a submission could name
// two correct findings. `a` says `혼자 운전하지 말고`. The row was labelled a
// correct finding confirmed against a real candidate, and it was neither.
//
// This question is structural -- how many claims come out of one submission --
// and it does not need real text to be answered. Synthetic text cannot be
// mistaken for a finding somebody verified, which is exactly the mistake that
// was made. The frozen candidates are used where the semantics matter
// (Policy D below), and are not edited by anything here.
const syntheticSource = {
    id: "synthetic-decomposition",
    question: "합성 질문: 분해 단위 실험용. 후보 세트가 아니다.",
    responses: [
        { label: "a", content: "합성 답변 a." },
        { label: "c", content: "합성 답변 c." },
    ],
};
const REQS_C = [
    { id: "req-alpha", description: "합성 요구 alpha" },
    { id: "req-beta", description: "합성 요구 beta" },
    { id: "req-gamma", description: "합성 요구 gamma" },
];
// Each input gets the gold it needs. Sharing one gold across all of them would
// make some rows say "wrong finding" where the question is "lost finding", and
// those are the two different costs this policy is choosing between.
const caseC = (gold) =>
    judgedCase(syntheticSource, REQS_C, { missingPoints: gold }, { missingPoints: true });
const goldFor = (...pairs) =>
    pairs.map(([requirementId, targetLabel]) => ({ requirementId, targetLabel }));

const claimC = (over) => ({
    targetLabel: "a",
    requirementId: "req-alpha",
    assertion: "missing",
    speechAct: "finding",
    submittedAs: "missingPoints",
    sourceIndex: 0,
    evidenceQuote: "",
    role: "finding",
    ...SIGNED,
    ...over,
});
const obsC = (text) => ({ findings: { missingPoints: [text] }, allText: text });

console.log("\n=== Policy C — 무엇이 하나의 독립 주장인가 ===");
console.log("case: 합성 원문 (후보 세트 아님). gold는 입력마다 다르다.\n");

const TWO_REQS = "a는 alpha를 말하지 않았고 beta에 대한 안내도 없습니다.";
const halfOne = claimC({ evidenceQuote: "a는 alpha를 말하지 않았고" });
const halfTwo = (over) =>
    claimC({ requirementId: "req-beta", evidenceQuote: "beta에 대한 안내도 없습니다", ...over });

console.log("[1a 한 제출, 한 답변, 두 요구 — 둘 다 gold]");
console.log(`    “${TWO_REQS}”   gold: a/alpha, a/beta`);
const goldBoth = goldFor(["req-alpha", "a"], ["req-beta", "a"]);
line("C0 제출 단위 — 대표 하나만", "baseline", score(caseC(goldBoth), obsC(TWO_REQS), [halfOne]), "missingPoints");
line(
    "C1 요구 단위 — 삼중항마다 claim",
    "experiment",
    score(caseC(goldBoth), obsC(TWO_REQS), [halfOne, halfTwo({})]),
    "missingPoints"
);

console.log("\n[1b 같은 제출, 뒤 반쪽이 지어낸 것]");
console.log(`    “${TWO_REQS}”   gold: a/alpha 만`);
const goldOne = goldFor(["req-alpha", "a"]);
line("C0 제출 단위 — 대표 하나만", "baseline", score(caseC(goldOne), obsC(TWO_REQS), [halfOne]), "missingPoints");
line(
    "C1 요구 단위 — 삼중항마다 claim",
    "experiment",
    score(caseC(goldOne), obsC(TWO_REQS), [halfOne, halfTwo({ outsideGoldVerdict: "false_finding" })]),
    "missingPoints"
);

const TWO_LABELS = "a와 c 모두 beta를 말하지 않습니다.";
console.log("\n[2 한 제출, 두 답변, 한 요구 — 둘 다 gold]");
console.log(`    “${TWO_LABELS}”   gold: a/beta, c/beta`);
const goldLabels = goldFor(["req-beta", "a"], ["req-beta", "c"]);
const betaClaim = (label) =>
    claimC({ targetLabel: label, requirementId: "req-beta", evidenceQuote: TWO_LABELS });
line("C0 제출 단위 — 대표 하나만 (c 쪽)", "baseline", score(caseC(goldLabels), obsC(TWO_LABELS), [betaClaim("c")]), "missingPoints");
line(
    "C1 요구 단위 — 답변마다 claim",
    "experiment",
    score(caseC(goldLabels), obsC(TWO_LABELS), [betaClaim("c"), betaClaim("a")]),
    "missingPoints"
);

// C1 vs C2 on the SAME triple, three times: a true finding, a confirmed false
// one, and one judged insufficient. Only the first goes down the duplicate
// branch, so "C2 changes nothing but `duplicates`" is true of that row alone.
const repeat = (label, gold, first, second) => {
    const text = "a는 X가 없습니다. 같은 이야기를 다시 적습니다.";
    const observation = obsC(text);
    console.log(`\n[3${label}]`);
    line(
        "C1 요구 단위 — claim 하나",
        "experiment",
        score(caseC(gold), observation, [first]),
        "missingPoints"
    );
    line(
        "C2 명제 단위 — claim 둘",
        "experiment",
        score(caseC(gold), observation, [first, second]),
        "missingPoints"
    );
};
const withQuote = (over) => claimC({ evidenceQuote: "a는 X가 없습니다", ...over });
const again = (over) => claimC({ evidenceQuote: "같은 이야기를 다시 적습니다", ...over });

console.log("\n[3 같은 삼중항을 두 번 — 무엇을 반복했는가에 따라 다르다]");
repeat("a 참인 발견을 반복", goldOne, withQuote({}), again({}));
repeat(
    "b 확정된 허위 발견을 반복",
    goldFor(["req-gamma", "a"]),
    withQuote({ outsideGoldVerdict: "false_finding" }),
    again({ outsideGoldVerdict: "false_finding" })
);
repeat(
    "c 불충분한 발견을 반복",
    goldOne,
    withQuote({ sufficiency: "insufficient" }),
    again({ sufficiency: "insufficient" })
);

const UNREGISTERED = "a는 delta와 epsilon에 대한 안내가 없습니다.";
console.log("\n[4 gold 밖 내용 — 배정하는 id 개수만 다름]");
console.log(`    “${UNREGISTERED}”   gold: a/alpha 만`);
line(
    "id 하나로 배정",
    "experiment",
    score(caseC(goldOne), obsC(UNREGISTERED), [
        claimC({ requirementId: "delta-and-epsilon", evidenceQuote: UNREGISTERED, outsideGoldVerdict: "false_finding" }),
    ]),
    "missingPoints"
);
line(
    "id 둘로 배정 (delta / epsilon)",
    "experiment",
    score(caseC(goldOne), obsC(UNREGISTERED), [
        claimC({ requirementId: "delta", evidenceQuote: "a는 delta와", outsideGoldVerdict: "false_finding" }),
        claimC({ requirementId: "epsilon", evidenceQuote: "epsilon에 대한 안내가 없습니다", outsideGoldVerdict: "false_finding" }),
    ]),
    "missingPoints"
);

// ---------------------------------------------------------------------------
// Policy D -- may a gold requirement bundle more than one action
// ---------------------------------------------------------------------------

const d005 = sourceCase("decision-v2", "ko-safety-sensitive-005");
const HALF = "b는 지급정지 요청을 말하지 않았습니다.";
const obsD = { findings: { missingPoints: [HALF] }, allText: HALF };
const claimD = (over) => ({
    targetLabel: "b",
    requirementId: "contact-bank-payment-hold",
    assertion: "missing",
    speechAct: "finding",
    submittedAs: "missingPoints",
    sourceIndex: 0,
    evidenceQuote: HALF,
    role: "finding",
    ...SIGNED,
    ...over,
});

console.log("\n=== Policy D — gold 요구가 여러 행동을 묶어도 되는가 ===");
console.log("case: decision-v2 ko-safety-sensitive-005, exhaustive");
console.log(`제출: ${HALF}  (검토자의 행동은 두 줄에서 동일하다)\n`);

const bundled = judgedCase(
    d005,
    [{ id: "contact-bank-payment-hold", description: "은행 연락 + 지급정지 + 추가 출금 차단" }],
    { missingPoints: [{ requirementId: "contact-bank-payment-hold", targetLabel: "b" }] },
    { missingPoints: true }
);
const split = judgedCase(
    d005,
    [
        { id: "bank-payment-hold", description: "은행에 지급정지 요청" },
        { id: "block-further-withdrawal", description: "자기 계좌의 추가 출금 차단" },
    ],
    {
        missingPoints: [
            { requirementId: "bank-payment-hold", targetLabel: "b" },
            { requirementId: "block-further-withdrawal", targetLabel: "b" },
        ],
    },
    { missingPoints: true }
);

// Two axes, not one. The registration is the question, but the row also
// carries a `sufficiency` judgement -- absent means `sufficient`, so a bundled
// gold only pays a perfect score once somebody has decided the half-report
// reported the requirement. Reading the first row as "bundling alone buys a
// perfect score" overstates it, and B2 is the axis that says so.
console.log("[등록 방식 × 충분성 판정]");
for (const [label, sufficiency] of [
    ["충분하다고 판정", "sufficient"],
    ["불충분하다고 판정", "insufficient"],
]) {
    line(
        `D0 묶인 gold (요구 1개), ${label}`,
        "baseline",
        score(bundled, obsD, [claimD({ sufficiency })]),
        "missingPoints"
    );
    line(
        `D1 원자적 gold (요구 2개)〔가정〕, ${label}`,
        "experiment",
        score(split, obsD, [claimD({ requirementId: "bank-payment-hold", sufficiency })]),
        "missingPoints"
    );
}

// ---------------------------------------------------------------------------
// Can bundling be detected mechanically? A measurement, not a score.
// ---------------------------------------------------------------------------
//
// The repository's standing rule is that a check nobody can compute is not
// made into a check. So before proposing one, measure the obvious signal: a
// conjunction in the requirement's own description.

console.log("\n=== 기계 검사가 가능한가 — 실제 후보 gold 9건에 대한 관측 ===");
const CONJUNCTIONS = ["와 ", "과 ", " 및 ", "그리고", ", "];
let fired = 0;
let total = 0;
for (const name of ["decision-v1", "decision-v2"]) {
    for (const entry of set(name).cases) {
        for (const items of Object.values(entry.gold)) {
            for (const item of items) {
                total += 1;
                const hits = CONJUNCTIONS.filter((token) => item.description.includes(token));
                if (hits.length > 0) fired += 1;
                console.log(
                    `  ${item.id.padEnd(38)} ${hits.length > 0 ? "FIRES" : "     "}  ` +
                        `${hits.length > 0 ? hits.map((h) => JSON.stringify(h)).join(" ") : ""}`
                );
            }
        }
    }
}
console.log(`\n  접속 신호가 걸린 gold: ${fired} / ${total}`);
console.log(
    "  이 중 여러 요구를 묶은 것으로 확인된 것은 contact-bank-payment-hold 하나이며,\n" +
        "  그 확인도 미서명 검토 초안의 판정이다. 신호는 둘을 가르지 못한다."
);

console.log("\nNo provider was called and no file was written.");
