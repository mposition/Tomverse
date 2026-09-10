// The denominators a complete judged run would have, with no score in sight.
//
// .github/audits/ai-review-judged-gate-transition-decision-2026-09-10.md §3.6.
//
//   npm run report:ai-review-judged-denominators -- \
//     --dataset=<frozen evaluation set .json> [--cases=<directory of judged case.json>]
//
// ## Why this exists as a separate command
//
// §3.6 fixes the order: the thresholds are chosen from sample composition and
// the error level that is acceptable, then the run happens. Sample composition
// is a fact about the frozen set; a reviewer's score is not. The trouble is
// that `report:ai-review-judged-run` prints both, so running it before the
// numbers are signed shows exactly what §3.6 forbids -- and no reordering of
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
import {
    AI_REVIEW_SCORING_CONTRACT_VERSION,
    judgedCaseShapeProblems,
    judgedSourceCaseDigest,
    validateJudgedCase,
} from "../lib/aiReviewEvalJudgement.ts";
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
// separately, and neither bounds the other. So a judged case read here makes
// one case's contribution KNOWN, and a case without one stays unknown.
//
// `case.json` is gold and registration. It holds no reviewer output, no
// judgement and no score, which is why reading it does not break §3.6.
//
// **But "it parsed" is not "it is about this case".** Reading only the id and
// the gold's length accepted a file written under an old contract, a file
// holding nothing but `{"caseId": "..."}`, and a second file for the same id
// that silently changed the count -- all three reported as exact. Calling a
// denominator exact is a claim, so every file has to earn it: shape,
// registration, contract version, the question and answers it was made from,
// the answer labels, and no id twice.
// ---------------------------------------------------------------------------

const casesPath = argValue("cases");
const judgedGoldItems = new Map();
const seenCaseIds = new Set();
const caseProblems = [];
if (casesPath) {
    const root = resolve(process.cwd(), casesPath);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
        die(`the judged cases directory does not exist: ${casesPath}`);
    }
    const datasetById = new Map(dataset.cases.map((item) => [item.id, item]));
    for (const name of readdirSync(root).sort()) {
        const directory = join(root, name);
        if (!statSync(directory).isDirectory()) continue;
        const path = join(directory, "case.json");
        if (!existsSync(path)) {
            caseProblems.push(`${name}: no case.json`);
            continue;
        }
        let judged;
        try {
            judged = JSON.parse(readFileSync(path, "utf8"));
        } catch (error) {
            caseProblems.push(`${name}: case.json is not valid JSON: ${error.message}`);
            continue;
        }

        // Shape before anything is read out of it.
        const shape = judgedCaseShapeProblems(judged);
        if (shape.length > 0) {
            for (const problem of shape) caseProblems.push(`${name}: ${problem}`);
            continue;
        }
        // Registration: a gold naming a requirement or an answer the case never
        // declared would make its own item count meaningless.
        for (const problem of validateJudgedCase(judged)) {
            caseProblems.push(`${name}: ${problem}`);
        }
        if (judged.contractVersion !== AI_REVIEW_SCORING_CONTRACT_VERSION) {
            caseProblems.push(
                `${name}: written for ${judged.contractVersion}, this contract is ` +
                    `${AI_REVIEW_SCORING_CONTRACT_VERSION}`
            );
        }
        // Tracked separately from the gold map, which only fills on full
        // success: keying the duplicate check off that map meant two copies
        // that were each invalid for another reason never got reported as
        // duplicates at all.
        if (seenCaseIds.has(judged.caseId)) {
            // Refused rather than last-wins. Two files for one case changed the
            // denominator and still read as exact.
            caseProblems.push(`${judged.caseId}: judged twice in this directory`);
            continue;
        }
        seenCaseIds.add(judged.caseId);
        const datasetCase = datasetById.get(judged.caseId);
        if (!datasetCase) {
            caseProblems.push(
                `${judged.caseId}: the frozen set holds no such case, so this gold is ` +
                    `about a case the sample does not contain`
            );
            continue;
        }
        // The question and the answers it was made from, and the labels its
        // gold may name. Same id and different text is a different case.
        if (judged.sourceCaseDigest !== judgedSourceCaseDigest(datasetCase)) {
            caseProblems.push(
                `${judged.caseId}: made from ${judged.sourceCaseDigest} and the frozen ` +
                    `set's case is ${judgedSourceCaseDigest(datasetCase)}`
            );
            continue;
        }
        const labels = (datasetCase.responses ?? []).map((response) => response.label);
        if (
            JSON.stringify([...labels].sort()) !==
            JSON.stringify([...judged.responseLabels].sort())
        ) {
            caseProblems.push(
                `${judged.caseId}: answers ${labels.join(", ")} in the frozen set and ` +
                    `${judged.responseLabels.join(", ")} here`
            );
            continue;
        }
        judgedGoldItems.set(
            judged.caseId,
            AI_REVIEW_EVAL_FINDING_KINDS.reduce(
                (total, kind) => total + (judged.gold?.[kind]?.length ?? 0),
                0
            )
        );
    }
}

if (caseProblems.length > 0) {
    console.log("the judged cases cannot be read as gold for this sample:");
    for (const problem of caseProblems) console.log(`  - ${problem}`);
    console.log(
        "\nNo denominator is printed. Exactness was asked for with these files, and\n" +
            "quietly falling back to a bound would hide that they are not usable."
    );
    process.exit(0);
}

// ---------------------------------------------------------------------------
// Denominators
// ---------------------------------------------------------------------------

const cases = dataset.cases.map((item) => ({
    id: item.id,
    language: item.language,
    taskType: item.taskType,
    negative: AI_REVIEW_EVAL_NEGATIVE_PHENOMENA.includes(item.phenomenon),
}));

/**
 * The missed-everything denominator, as a RANGE over unverified cases.
 *
 * The dataset's keyword gold used to stand in for the judged gold, described as
 * an upper bound. It is not one in either direction: the two golds are written
 * separately, so a case with no keyword gold can carry a judged gold item -- a
 * synthetic `prompt_injection` case did, and the "bound" of 0 sat below a real
 * denominator of 1.
 *
 * So a case is counted only when its judged gold was read and verified, and an
 * unverified non-negative case widens the range instead of being guessed at.
 * Negative cases never enter this denominator whatever their gold says, so they
 * do not widen it.
 */
const missedRange = (subset) => {
    const known = subset.filter(
        (item) => !item.negative && (judgedGoldItems.get(item.id) ?? 0) > 0
    ).length;
    const unknown = subset.filter(
        (item) => !item.negative && !judgedGoldItems.has(item.id)
    ).length;
    return { lower: known, upper: known + unknown, unknown };
};

/**
 * The other two are exact from the frozen set alone: one counts every case, the
 * other counts the negative phenomena, and `phenomenon` is a dataset field.
 */
const denominatorsOver = (subset) => ({
    missed: missedRange(subset),
    inventedFinding: subset.length,
    inventedFindingNegativeSubset: subset.filter((item) => item.negative).length,
});

const exact = cases.every((item) => judgedGoldItems.has(item.id));
const span = (range) => (range.lower === range.upper ? `${range.lower}` : `${range.lower}–${range.upper}`);

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
            exact
                ? `${judgedGoldItems.size}건 전부 검증됨 — 미보고율 분모가 정확하다`
                : `${judgedGoldItems.size}/${cases.length}건 검증됨 — 미보고율 분모는 **구간**이다`
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
        span(whole.missed),
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
                span(counts.missed),
                counts.inventedFinding,
                counts.inventedFindingNegativeSubset,
            ],
            SIZES
        );
    }
}

if (!exact) {
    const unknown = missedRange(cases).unknown;
    console.log(
        `\n  **주의 — 미보고율 분모는 구간이다** (검증되지 않은 비음성 case ${unknown}건).\n` +
            "  그 분모는 **판정 case의 gold**가 심은 항목이 있는 비음성 case를 센다. 판정\n" +
            "  gold는 dataset의 키워드 gold와 **별도로 작성되며 어느 쪽도 다른 쪽을 묶지\n" +
            "  않는다** — dataset gold가 비어 있어도 판정 gold가 항목을 가질 수 있다. 그래서\n" +
            "  dataset gold를 대신 쓰지 않고, 검증된 case만 세고 나머지는 구간을 넓힌다.\n" +
            "  `--cases`로 판정 case를 전부 주면 정확해진다. (`case.json`은 gold와 등록뿐이고\n" +
            "  검토자 출력·판정·점수를 담지 않는다.)"
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
const SIZES2 = [26, 11, ...CEILINGS.map(() => 10)];
row(["지표 / 범위", "분모", ...CEILINGS.map((c) => c.toFixed(2))], SIZES2);
rule(SIZES2);
/**
 * One row. A range denominator gives a range of allowed failures, because a
 * larger denominator tolerates more -- writing one number for a range would
 * pick an end, and either end is a claim the input does not support.
 */
const metricRow = (label, range) => {
    const show = (denominator, ceiling) => {
        const k = maxFailures(denominator, ceiling);
        return k === null ? "—" : String(k);
    };
    row(
        [
            label,
            span(range),
            ...CEILINGS.map((ceiling) => {
                const low = show(range.lower, ceiling);
                const high = show(range.upper, ceiling);
                return low === high ? low : `${low}–${high}`;
            }),
        ],
        SIZES2
    );
};
const fixed = (value) => ({ lower: value, upper: value, unknown: 0 });
metricRow("미보고율 전체", whole.missed);
metricRow("지어냄 전체", fixed(whole.inventedFinding));
metricRow("음성 부분집합 전체", fixed(whole.inventedFindingNegativeSubset));
for (const arm of AI_REVIEW_EVAL_LANGUAGES) {
    const subset = cases.filter((item) => item.language === arm);
    if (subset.length === 0) continue;
    const counts = denominatorsOver(subset);
    metricRow(`  미보고율 ${arm}`, counts.missed);
    metricRow(`  지어냄 ${arm}`, fixed(counts.inventedFinding));
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
        "written. Choosing the ceilings is a person's decision: 결정안 §3.6."
);
