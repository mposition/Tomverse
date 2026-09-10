// The denominators a complete judged run would have, with no score in sight.
//
// .github/audits/ai-review-judged-gate-transition-decision-2026-09-10.md §3.6.
//
//   npm run report:ai-review-judged-denominators -- \
//     --dataset=<frozen evaluation set .json> [--cases=<directory of judged case.json>]
//
// ## Why this exists as a separate command
//
// .github/audits/ai-review-judged-gate-transition-decision-2026-09-10.md §3.6
// fixes the order: the thresholds are chosen from sample composition and
// the error level that is acceptable, then the run happens. Sample composition
// is a fact about the frozen set; a reviewer's score is not. The trouble is
// that `report:ai-review-judged-run` prints both, so running it before the
// numbers are signed shows exactly what that section forbids -- and no
// reordering of
// its output fixes that, because the scores are what it exists to report.
//
// So this command reads **only** the frozen set and, optionally, the judged
// cases' gold. It never reads a reviewer's output, a judgement record or a
// score, and `tests/aiReviewJudgedDenominators.test.mjs` asserts statically
// that it has no means to: the requirement cannot be exercised by any input,
// only by refusing the caller the files.
//
// ## What it prints, and what that is worth
//
// Denominators, per metric, for the whole set and per arm -- and, at each one,
// how many failures each candidate ceiling would tolerate. No numerator, no
// rate, no Wilson bound on an observed value.
//
// **These are the denominators of a COMPLETE run.** A run that leaves a case
// unjudged is not aggregable at all, so in any run whose numbers could reach a
// gate, the denominators are these. That is why they can be known in advance.
//
// Nothing is written and no provider is called.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
    AI_REVIEW_EVAL_FINDING_KINDS,
    AI_REVIEW_EVAL_LANGUAGES,
    AI_REVIEW_EVAL_NEGATIVE_PHENOMENA,
    AI_REVIEW_EVAL_TASK_TYPES,
} from "../lib/aiReviewEvalCore.ts";
import { datasetProblems, freezeDrift } from "../lib/aiReviewEvalRun.ts";
import { wilsonInterval } from "../lib/memoryExtractionEvalCore.ts";

const CEILINGS = [0.02, 0.05, 0.1, 0.15, 0.2, 0.3];

const argValue = (name) => {
    const args = process.argv.slice(2);
    const inline = args.find((argument) => argument.startsWith(`--${name}=`));
    if (inline !== undefined) return inline.slice(name.length + 3);
    const at = args.indexOf(`--${name}`);
    if (at === -1) return undefined;
    const next = args[at + 1];
    return next === undefined || next.startsWith("--") ? undefined : next;
};

const die = (message) => {
    console.error(message);
    process.exit(1);
};

const datasetPath = argValue("dataset");
if (!datasetPath) {
    die(
        "usage: npm run report:ai-review-judged-denominators -- " +
            "--dataset=<set .json> [--cases=<directory>]"
    );
}

const readJson = (path, what) => {
    const resolved = resolve(process.cwd(), path);
    if (!existsSync(resolved)) die(`${what} does not exist: ${path}`);
    try {
        return JSON.parse(readFileSync(resolved, "utf8"));
    } catch (error) {
        die(`${what} is not valid JSON (${path}): ${error.message}`);
    }
    return undefined;
};

const dataset = readJson(datasetPath, "the frozen dataset");

// The same admission the aggregator runs, for the same reason: a set that is
// not structurally sound, or not the set it says it was frozen as, is not a
// sample composition anybody can choose a threshold from.
const problems = [...datasetProblems(dataset)];
if (problems.length === 0) {
    const drift = freezeDrift(dataset);
    if (drift) problems.push(drift);
}
if (problems.length > 0) {
    console.log("the dataset cannot be read as a confirmed sample:");
    for (const problem of problems) console.log(`  - ${problem}`);
    console.log(
        "\nNo denominator is printed. A composition that is not pinned is not one a\n" +
            "threshold can be chosen from."
    );
    process.exit(0);
}

// ---------------------------------------------------------------------------
// The judged gold, when the caller has it
//
// A judged case states its own gold -- which requirement is missing from which
// answer -- and that is NOT the dataset's keyword gold: the two are authored
// separately and can hold different numbers of items. The missed-everything
// denominator counts cases whose JUDGED gold plants something, so without these
// files it can only be bounded, not known.
//
// `case.json` is gold and registration. It holds no reviewer output, no
// judgement and no score, which is why reading it does not break
// .github/audits/ai-review-judged-gate-transition-decision-2026-09-10.md §3.6.
// ---------------------------------------------------------------------------

const casesPath = argValue("cases");
const judgedGoldItems = new Map();
if (casesPath) {
    const root = resolve(process.cwd(), casesPath);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
        die(`the judged cases directory does not exist: ${casesPath}`);
    }
    for (const name of readdirSync(root).sort()) {
        const directory = join(root, name);
        if (!statSync(directory).isDirectory()) continue;
        const path = join(directory, "case.json");
        if (!existsSync(path)) continue;
        const judged = readJson(path, `the judged case ${name}`);
        const items = AI_REVIEW_EVAL_FINDING_KINDS.reduce(
            (total, kind) => total + (judged?.gold?.[kind]?.length ?? 0),
            0
        );
        if (typeof judged?.caseId === "string") judgedGoldItems.set(judged.caseId, items);
    }
}

// ---------------------------------------------------------------------------
// Denominators
// ---------------------------------------------------------------------------

const cases = dataset.cases.map((item) => ({
    id: item.id,
    language: item.language,
    taskType: item.taskType,
    negative: AI_REVIEW_EVAL_NEGATIVE_PHENOMENA.includes(item.phenomenon),
    datasetGoldItems: AI_REVIEW_EVAL_FINDING_KINDS.reduce(
        (total, kind) => total + (item.gold?.[kind]?.length ?? 0),
        0
    ),
}));

/** Whether this case can enter the missed-everything denominator. */
const plants = (item) => {
    const judged = judgedGoldItems.get(item.id);
    return judged === undefined ? item.datasetGoldItems > 0 : judged > 0;
};

const denominatorsOver = (subset) => ({
    missedEveryPlantedIssue: subset.filter((item) => !item.negative && plants(item)).length,
    inventedFinding: subset.length,
    inventedFindingNegativeSubset: subset.filter((item) => item.negative).length,
});

const exact = casesPath !== undefined && cases.every((item) => judgedGoldItems.has(item.id));

const width = (text) =>
    [...String(text)].reduce(
        (total, character) =>
            total + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(character) ? 2 : 1),
        0
    );
const cell = (text, size) => `${text}${" ".repeat(Math.max(1, size - width(text)))}`;
const row = (values, sizes) =>
    console.log("  " + values.map((value, index) => cell(String(value), sizes[index])).join(""));
const heading = (text) => console.log(`\n=== ${text} ===`);
const rule = (sizes) => console.log("  " + "-".repeat(sizes.reduce((a, b) => a + b, 0)));

console.log(
    `AI Review judged-v3 — 완전한 실행이 가질 분모 (점수 없음)\n` +
        `\n  dataset            ${datasetPath}` +
        `\n  version            ${dataset.version}  (frozen ${dataset.frozenAt} by ${dataset.frozenBy})` +
        `\n  cases              ${cases.length}` +
        `\n  판정 case gold     ${
            casesPath === undefined
                ? "주지 않음 — 미보고율 분모는 **상한**이다(아래 주의)"
                : exact
                  ? `${judgedGoldItems.size}건 전부 읽음 — 분모가 정확하다`
                  : `${judgedGoldItems.size}/${cases.length}건만 읽음 — 미보고율 분모는 **상한**이다`
        }`
);

const SIZES = [26, 12, 12, 14];
heading("1. 분모");
row(["범위", "미보고율", "지어냄", "음성 부분집합"], SIZES);
rule(SIZES);
const whole = denominatorsOver(cases);
row(
    [
        `전체 (${cases.length}건)`,
        whole.missedEveryPlantedIssue,
        whole.inventedFinding,
        whole.inventedFindingNegativeSubset,
    ],
    SIZES
);
for (const [label, vocabulary, key] of [
    ["언어", AI_REVIEW_EVAL_LANGUAGES, "language"],
    ["과제", AI_REVIEW_EVAL_TASK_TYPES, "taskType"],
]) {
    for (const arm of vocabulary) {
        const subset = cases.filter((item) => item[key] === arm);
        if (subset.length === 0) continue;
        const counts = denominatorsOver(subset);
        row(
            [
                `  ${label} ${arm} (${subset.length})`,
                counts.missedEveryPlantedIssue,
                counts.inventedFinding,
                counts.inventedFindingNegativeSubset,
            ],
            SIZES
        );
    }
}

if (!exact) {
    console.log(
        "\n  **주의 — 미보고율 분모는 상한이다.** 그 분모는 **판정 case의 gold**가 심은\n" +
            "  항목이 있는 비음성 case를 세는데, 판정 gold는 dataset의 키워드 gold와 별도로\n" +
            "  작성되며 개수가 다를 수 있다. `--cases`로 판정 case를 주면 정확해진다.\n" +
            "  (`case.json`은 gold와 등록뿐이고 검토자 출력·판정·점수를 담지 않는다.)"
    );
}

// ---------------------------------------------------------------------------

heading("2. 이 분모에서 각 후보 상한이 허용하는 실패 수");
console.log(
    "  **관측값은 하나도 쓰이지 않았다.** 각 칸은 `wilsonUpper(k, 분모) <= 상한`을\n" +
        "  만족하는 가장 큰 k이고, `—`는 0 실패로도 통과가 불가능하다는 뜻이다.\n"
);
const maxFailures = (denominator, ceiling) => {
    if (denominator === 0) return null;
    if (wilsonInterval(0, denominator).upper > ceiling) return null;
    let best = 0;
    for (let k = 1; k <= denominator; k += 1) {
        if (wilsonInterval(k, denominator).upper > ceiling) break;
        best = k;
    }
    return best;
};
const SIZES2 = [26, 10, ...CEILINGS.map(() => 8)];
row(["지표 / 범위", "분모", ...CEILINGS.map((c) => c.toFixed(2))], SIZES2);
rule(SIZES2);
const metricRow = (label, denominator) =>
    row(
        [
            label,
            denominator,
            ...CEILINGS.map((ceiling) => {
                const k = maxFailures(denominator, ceiling);
                return k === null ? "—" : k;
            }),
        ],
        SIZES2
    );
metricRow("미보고율 전체", whole.missedEveryPlantedIssue);
metricRow("지어냄 전체", whole.inventedFinding);
metricRow("음성 부분집합 전체", whole.inventedFindingNegativeSubset);
for (const arm of AI_REVIEW_EVAL_LANGUAGES) {
    const subset = cases.filter((item) => item.language === arm);
    if (subset.length === 0) continue;
    const counts = denominatorsOver(subset);
    metricRow(`  미보고율 ${arm}`, counts.missedEveryPlantedIssue);
    metricRow(`  지어냄 ${arm}`, counts.inventedFinding);
}

console.log(
    "\n  **분모 0은 0%가 아니다.** 그 범위에서 그 지표는 `insufficient_evidence`이며,\n" +
        "  어떤 상한도 만족시키지 못한다 — 품질이 아니라 구성의 문제다.\n" +
        "\n  그리고 이 표는 **통과 가능성**이고 판정 예산이 아니다. 판정해야 하는 case\n" +
        "  수는 표본 하한과 '계획 전체' 조건이 정하며, 상한 선택과 무관하다.\n" +
        "  근거: 결정안 §3.3."
);

console.log(
    "\nNo reviewer output, judgement record or score was read, and nothing was\n" +
        "written. Choosing the ceilings is a person's decision: " +
        ".github/audits/ai-review-judged-gate-transition-decision-2026-09-10.md §3.6."
);
