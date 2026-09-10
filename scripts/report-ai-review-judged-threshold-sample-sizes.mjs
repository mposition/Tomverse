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

heading("3. 이 표본이 무엇을 뜻하는가 — 판정은 사람이 한다");
console.log(
    `  키워드 경로의 표본 하한은 합계 ${AI_REVIEW_EVAL_MIN_CASES.aggregate}건,\n` +
        `  언어별 ${AI_REVIEW_EVAL_MIN_CASES.perLanguage}건,\n` +
        `  언어×과제 cell별 ${AI_REVIEW_EVAL_MIN_CASES.perLanguageTaskTypeCell}건이다\n` +
        "  (`AI_REVIEW_EVAL_MIN_CASES`).\n" +
        "\n" +
        "  **judged 경로에서 그 숫자는 사람이 읽어야 하는 case 수다.** 키워드 경로는\n" +
        "  용어 목록이 세므로 표본을 늘리는 비용이 provider 호출비뿐이지만, judged\n" +
        "  경로의 1건은 제출된 발견마다 claim을 쓰고 서명하는 사람의 일이다.\n" +
        "\n" +
        "  그래서 임계값 선택은 품질 기준 선택이면서 **판정 예산 선택**이다. 위 두 표가\n" +
        "  그 환율이고, 어느 칸을 고를지는 사람이 정한다."
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
        "  case다. 같은 실행에서 앞의 분모는 뒤의 분모보다 작으므로, 같은 임계값이라도\n" +
        "  **앞쪽이 먼저 표본 부족에 걸린다.**\n" +
        "\n" +
        "  그리고 `inventedFindingRateNegativeSubset`의 분모는 음성 phenomenon case\n" +
        "  뿐이다. `decision-v2`에는 그것이 **0건**이므로, 그 부분집합에 임계값을 걸면\n" +
        "  오늘의 후보 set으로는 **어떤 실행도 통과하지 못한다** — 품질이 아니라 구성의\n" +
        "  문제이고, set을 고치는 것은 별개 결정이다."
);

console.log(
    "\nNothing was written, no provider was called, and no threshold was set:\n" +
        "this is the arithmetic a person needs in order to choose one."
);
