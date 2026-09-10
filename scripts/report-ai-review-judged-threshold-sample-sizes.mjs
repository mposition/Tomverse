// What a candidate ceiling costs, in cases judged and failures tolerated.
//
// Written up in
// .github/audits/ai-review-judged-gate-transition-decision-2026-09-10.md §3.
//
//   npm run report:ai-review-judged-threshold-sample-sizes
//
// ## What this is
//
// Arithmetic, not a recommendation. The two metrics approved on 2026-09-09 are
// error rates read from a Wilson 95% UPPER bound, so a run passes a ceiling `c`
// with `k` failures in `n` cases when `wilsonUpper(k, n) <= c`. That one
// inequality decides both questions a person choosing a ceiling has to answer:
//
//   * how many cases must be judged before a clean run can clear it at all,
//   * and how many failures a run of a given size may carry.
//
// **No number here is approved, and none is proposed.** The `0.10` in
// `lib/aiReviewQualityThresholds.ts` is an unsigned draft; it appears below as
// one candidate among several and carries no more weight than the others.
//
// Nothing is read from the network, no provider is called, and nothing is
// written.

import { wilsonInterval } from "../lib/memoryExtractionEvalCore.ts";
import { AI_REVIEW_EVAL_MIN_CASES } from "../lib/aiReviewEvalCore.ts";

/** Candidate ceilings. Spread deliberately wider than any number in the tree. */
const CEILINGS = [0.02, 0.05, 0.1, 0.15, 0.2, 0.3];

/** Failure counts a person might plan for. */
const FAILURES = [0, 1, 2, 3, 5, 10];

/** Sample sizes a judged run could plausibly reach, plus the keyword minimums. */
const SAMPLES = [30, 60, 100, 200, 300, 600, 1_200];

const passes = (failures, cases, ceiling) =>
    cases > 0 && wilsonInterval(failures, cases).upper <= ceiling;

/** The smallest n at which `failures` failures still clear `ceiling`. */
const minimumCases = (failures, ceiling) => {
    // Monotone in n for fixed k, so a scan is enough and its bound is stated:
    // above this the answer is "more than a judged run can reach", which is
    // the useful answer rather than a number nobody will act on.
    for (let cases = Math.max(failures, 1); cases <= 20_000; cases += 1) {
        if (passes(failures, cases, ceiling)) return cases;
    }
    return null;
};

/** The most failures `cases` can carry under `ceiling`. */
const maximumFailures = (cases, ceiling) => {
    if (!passes(0, cases, ceiling)) return null;
    let best = 0;
    for (let failures = 1; failures <= cases; failures += 1) {
        if (!passes(failures, cases, ceiling)) break;
        best = failures;
    }
    return best;
};

const width = (text) =>
    [...String(text)].reduce(
        (total, character) =>
            total +
            (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(
                character
            )
                ? 2
                : 1),
        0
    );
const cell = (text, size) => `${text}${" ".repeat(Math.max(1, size - width(text)))}`;
const row = (values, sizes) =>
    console.log("  " + values.map((value, index) => cell(String(value), sizes[index])).join(""));
const heading = (text) => console.log(`\n=== ${text} ===`);
const rule = (sizes) => console.log("  " + "-".repeat(sizes.reduce((a, b) => a + b, 0)));

console.log(
    "AI Review judged-v3 — 승인된 두 지표의 임계값 후보별 산술\n" +
        "\n" +
        "  두 지표는 모두 **오류율**이고 게이트는 Wilson 95% **상한**을 읽는다.\n" +
        "  그래서 판정은 하나다 — `wilsonUpper(실패, 표본) <= 임계값`.\n" +
        "\n" +
        "  **어떤 숫자도 승인된 것이 아니고, 권고하지도 않는다.**\n" +
        "  `lib/aiReviewQualityThresholds.ts`의 `0.10`은 서명되지 않은 초안이며,\n" +
        "  아래에서 여러 후보 중 하나로만 등장한다."
);

// ---------------------------------------------------------------------------

heading("1. 실패 k건을 허용하려면 최소 몇 건을 판정해야 하는가");
console.log(
    "  각 칸은 **그 실패 수를 안고도 임계값을 통과할 수 있는 가장 작은 표본**이다.\n" +
        "  `—`는 20,000건 안에 없다는 뜻이다.\n"
);
const sizes1 = [12, ...FAILURES.map(() => 11)];
row(["임계값", ...FAILURES.map((k) => `실패 ${k}`)], sizes1);
rule(sizes1);
for (const ceiling of CEILINGS) {
    row(
        [
            ceiling.toFixed(2),
            ...FAILURES.map((failures) => {
                const cases = minimumCases(failures, ceiling);
                return cases === null ? "—" : `${cases}건`;
            }),
        ],
        sizes1
    );
}
console.log(
    "\n  **0 실패 열이 하한이다.** 완벽한 실행조차 그 표본에 이르지 못하면 임계값을\n" +
        "  통과할 수 없다 — 측정이 부족해서이지 품질 때문이 아니다."
);

// ---------------------------------------------------------------------------

heading("2. 표본 n이면 실패를 몇 건까지 안을 수 있는가");
console.log("  `—`는 그 표본으로는 **0 실패로도** 통과가 불가능하다는 뜻이다.\n");
const sizes2 = [10, ...CEILINGS.map(() => 9)];
row(["표본", ...CEILINGS.map((c) => c.toFixed(2))], sizes2);
rule(sizes2);
for (const cases of SAMPLES) {
    row(
        [
            `${cases}건`,
            ...CEILINGS.map((ceiling) => {
                const failures = maximumFailures(cases, ceiling);
                return failures === null ? "—" : `${failures}건`;
            }),
        ],
        sizes2
    );
}

// ---------------------------------------------------------------------------

heading("3. 위 두 표는 통과 가능성이고, 판정 예산이 아니다");
console.log(
    "  위 수를 전체 판정 예산으로 읽으면 안 된다. 예컨대 0.10의 35건은 **한 실행의\n" +
        "  한 지표가 무실패로 그 상한을 만족할 수 있는 최소 분모**이고, 승인에 필요한\n" +
        "  판정량이 아니다.\n" +
        "\n" +
        "  전체 판정량은 기존 조건이 정하며 **임계값과 무관하다.**\n" +
        `    - 실행당 합계 ${AI_REVIEW_EVAL_MIN_CASES.aggregate}건 ` +
        `(언어별 ${AI_REVIEW_EVAL_MIN_CASES.perLanguage}, ` +
        `언어×과제 cell별 ${AI_REVIEW_EVAL_MIN_CASES.perLanguageTaskTypeCell})\n` +
        "    - 계획 전체가 판정되어야 집계 가능 (누락은 거절)\n" +
        "    - reviewer pair마다 독립 실행 2회 (서로 다른 run ordinal)\n" +
        `\n  그래서 최소 규모라도 pair당 ${AI_REVIEW_EVAL_MIN_CASES.aggregate * 2}건의 ` +
        "case별 출력 판정이 필요하다.\n" +
        `  고유 문제가 ${AI_REVIEW_EVAL_MIN_CASES.aggregate * 2}개라는 뜻은 아니다 — ` +
        `같은 ${AI_REVIEW_EVAL_MIN_CASES.aggregate}건의\n  출력을 두 실행에 대해 각각 판정한다.\n` +
        "\n" +
        "  **임계값을 완화해도 이 작업량은 줄지 않는다.** 임계값이 바꾸는 것은 판정을\n" +
        "  마친 실행이 통과하는지이고, 판정해야 하는 case 수는 표본 하한과 '계획 전체'\n" +
        "  조건이 정한다.\n" +
        "\n" +
        "  그 위에서, judged 1건은 제출된 발견마다 claim을 쓰고 서명하는 **사람의 일**\n" +
        "  이다. 키워드 경로에서 표본을 늘리는 비용은 provider 호출비뿐이다."
);

const sizes3 = [12, 16, 22];
console.log("");
row(["임계값", "0 실패 최소 표본", "그 표본의 허용 실패"], sizes3);
rule(sizes3);
for (const ceiling of CEILINGS) {
    const minimum = minimumCases(0, ceiling);
    row(
        [
            ceiling.toFixed(2),
            minimum === null ? "—" : `${minimum}건`,
            minimum === null ? "—" : `${maximumFailures(minimum, ceiling)}건`,
        ],
        sizes3
    );
}

console.log(
    "\n  **두 지표는 분모가 다르다.** `missedEveryPlantedIssueRate`의 분모는 심은\n" +
        "  항목이 있는 비음성 case이고, `inventedFindingRate`의 분모는 채점된 모든\n" +
        "  case다. 앞의 분모는 뒤의 분모보다 **작거나 같으므로**(모두 심은 항목 있는\n" +
        "  비음성 case이면 같다), 같은 임계값이라도 **앞쪽이 먼저 표본 부족에 걸릴 수\n" +
        "  있다** — 반드시 그렇다는 것은 아니다.\n" +
        "\n" +
        "  그리고 `inventedFindingRateNegativeSubset`의 분모는 음성 phenomenon case\n" +
        "  뿐이다. `decision-v2`에는 그것이 **0건**이므로, 그 부분집합에 임계값을 걸면\n" +
        "  오늘의 후보 set으로는 **어떤 실행도 통과하지 못한다** — 품질이 아니라 구성의\n" +
        "  문제이고, set을 고치는 것은 별개 결정이다."
);

console.log(
    "\n  **그리고 고를 숫자는 aggregate 상한 둘만이 아니다.** 같은 두 지표에\n" +
        "  `maxLanguageArmGap`(초안 0.05)과 `maxTaskTypeArmShortfall`(초안 0.10)이\n" +
        "  함께 걸린다 — 과제 arm의 상한은 `aggregate + 0.10`이므로 aggregate를 0.10으로\n" +
        "  고르면 과제 arm은 0.20이 된다. 그 둘도 서명되지 않은 초안값이고, 새 척도에\n" +
        "  그대로 쓸지는 별개 결정이다."
);

console.log(
    "\nNothing was written, no provider was called, and no threshold was set:\n" +
        "this is the arithmetic a person needs in order to choose one."
);
