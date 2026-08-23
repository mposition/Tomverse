/**
 * Generates a self-contained review sheet for a candidate batch
 * (docs/ops/memory-extraction-eval-dataset.md §6.3, §6.5, §8).
 *
 * The first batch record was written by hand and got two things wrong, both
 * in the same direction -- work handed to the reviewer that did not have to
 * be theirs:
 *
 *   1. It asked for a verdict on all 25 cases. docs/ops/memory-extraction-eval-dataset.md §6.3 lets category ① be
 *      sample-reviewed at 20%, so five was the requirement and twenty-five
 *      was what the sheet demanded.
 *   2. It carried a 42-character excerpt per case, so judging one meant
 *      opening the TypeScript file and finding it. A review sheet that sends
 *      the reviewer somewhere else is a sheet that has not been prepared.
 *
 * So the sheet is generated, not written: every automated check is run here
 * and its result printed, the sampled cases are reproduced in full, and the
 * only thing left blank is the judgement. Batches 002 onward get the same
 * handoff without anyone rewriting it.
 *
 * Usage:
 *   npm run make:memory-eval-review-sheet -- --batch=batch-001 [--write]
 *
 * Without `--write` it prints to stdout, so the diff can be read before it
 * lands on the record file.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CANDIDATE_BATCHES } from "../lib/memoryExtractionEvalCandidates/index.ts";
import { ADOPTED_BATCHES } from "../lib/memoryExtractionEvalAdopted/index.ts";
import { findDuplicateCases } from "../lib/memoryExtractionEvalCore.ts";
import { nearDuplicatePairs } from "../lib/memoryEvalNearDuplicates.ts";
import { MEMORY_KINDS } from "../lib/memoryValidatorCore.ts";
import { MEMORY_EVAL_CASES } from "../lib/memoryExtractionEvalFixtures.ts";
import { parseBatchRecord } from "../lib/memoryEvalBatchRecord.ts";

const argValue = (name, fallback) => {
    const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit === undefined ? fallback : hit.slice(name.length + 3);
};

/**
 * Adopted batches are renderable too, and on purpose: the record-matches-
 * generator test is what keeps a record from drifting away from the cases it
 * judged, and a batch needs that check most after it has become dataset.
 * Writing to an adopted record is refused further down.
 */
const ALL_BATCHES = [...CANDIDATE_BATCHES, ...ADOPTED_BATCHES];

const batchId = argValue("batch", "");
const batch = ALL_BATCHES.find((entry) => entry.id === batchId);
if (!batch) {
    console.error(
        `--batch must name a batch. Known: ${ALL_BATCHES.map((entry) => entry.id).join(", ") || "(none)"}`
    );
    process.exit(1);
}
const isAdopted = ADOPTED_BATCHES.some((entry) => entry.id === batch.id);

const cases = batch.cases;
const isCriticalNegative = cases.every(
    (entry) => entry.category !== "durable_facts"
);

/**
 * How many cases the reviewer actually has to judge.
 *
 * docs/ops/memory-extraction-eval-dataset.md §6.3: categories ②③④ are reviewed in full because a mislabelled critical
 * negative is the failure the whole eval exists to catch. Category ① may be
 * sampled at 20%.
 */
const sampleSize = isCriticalNegative
    ? cases.length
    : Math.max(1, Math.ceil(cases.length * 0.2));

/**
 * Which cases, chosen so the sample spreads across the batch AND across
 * kinds. Stride sampling alone repeats a kind; taking the first N repeats a
 * position. This strides, and on a repeated kind advances to the next unseen
 * one -- deterministic, so the same batch always yields the same sample and a
 * reviewer can check the choice rather than trust it.
 */
const pickSample = () => {
    if (isCriticalNegative) return cases.map((_, index) => index);
    const stride = Math.max(1, Math.floor(cases.length / sampleSize));
    const chosen = [];
    const seenKinds = new Set();
    for (let start = 0; start < cases.length && chosen.length < sampleSize; start += stride) {
        let index = start;
        while (
            index < cases.length &&
            (chosen.includes(index) ||
                seenKinds.has(cases[index].expected[0]?.kind))
        ) {
            index += 1;
        }
        if (index >= cases.length) break;
        chosen.push(index);
        seenKinds.add(cases[index].expected[0]?.kind);
    }
    // Top up if kind exhaustion cut it short.
    for (let index = 0; index < cases.length && chosen.length < sampleSize; index += 1) {
        if (!chosen.includes(index)) chosen.push(index);
    }
    return chosen.sort((a, b) => a - b);
};
const sample = pickSample();

/* ------------------------------------------------- automated checks ------ */

const kindCounts = new Map();
for (const entry of cases) {
    for (const expectation of entry.expected) {
        kindCounts.set(
            expectation.kind,
            (kindCounts.get(expectation.kind) ?? 0) + 1
        );
    }
}
const widestKind = [...kindCounts].sort((a, b) => b[1] - a[1])[0];

const problems = [];
for (const entry of cases) {
    const messages = entry.conversations.flatMap(
        (conversation) => conversation.messages
    );
    const userText = messages
        .filter((message) => message.role === "user")
        .map((message) => message.content)
        .join(" ")
        .toLowerCase();
    if (messages.length < 2) problems.push(`${entry.id}: fewer than two turns`);
    if (!messages.some((message) => message.role === "user"))
        problems.push(`${entry.id}: no user turn`);
    for (const expectation of entry.expected) {
        if (!MEMORY_KINDS.includes(expectation.kind))
            problems.push(`${entry.id}: ${expectation.kind} is not a docs/ops/memory-extraction-eval-dataset.md §8.2 kind`);
        if (expectation.mustInclude.length > 2)
            problems.push(`${entry.id}: more than two keywords`);
        for (const keyword of expectation.mustInclude) {
            if (!userText.includes(keyword.toLowerCase()))
                problems.push(`${entry.id}: "${keyword}" appears in no user turn`);
        }
    }
}
const duplicates = findDuplicateCases(cases);
/**
 * Deduplicated by id: once a batch is adopted its cases are in
 * `MEMORY_EVAL_CASES` as well as in `batch.cases`, and comparing a case with
 * itself would report a 1.00 pair and bury the real neighbours.
 */
const universe = [...new Map(
    [...MEMORY_EVAL_CASES, ...cases].map((entry) => [entry.id, entry])
).values()];
const cellPairs = nearDuplicatePairs(universe).filter(
    (pair) => pair.cell === batch.cell
);

/* ------------------------------------------------------------ render ----- */

const turnsOf = (entry) =>
    entry.conversations
        .flatMap((conversation) =>
            conversation.messages.map(
                (message) =>
                    `> **${message.role === "user" ? "사용자" : "assistant"}** ${message.content}`
            )
        )
        .join("\n>\n");

const label = (entry) =>
    entry.expected
        .map(
            (expectation) =>
                `\`${expectation.kind}\` — 키워드 ${expectation.mustInclude.map((k) => `\`${k}\``).join(" + ")}`
        )
        .join("; ") || "(없음 — 범주 ②③④는 빈 배열)";

const out = [];
const p = (line = "") => out.push(line);

p(`# ${batch.id} — \`${batch.cell}\` 검수 시트`);
p();
p(`> **자동 생성 파일입니다.** \`npm run make:memory-eval-review-sheet -- --batch=${batch.id}\``);
p("> 로 다시 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요 — 다시 생성하면 덮어씁니다.");
p();
p("## 당신이 해야 하는 일");
p();
p(`**케이스 ${sampleSize}건 판정 + batch 채택 결정 1건.** 그게 전부입니다.`);
p();
if (isCriticalNegative) {
    p(`이 batch는 critical negative(범주 ②③④)라 \`docs/ops/memory-extraction-eval-dataset.md\` §6.3이 **전건 검수**를 요구합니다.`);
} else {
    p(`이 batch는 범주 ①이라 \`docs/ops/memory-extraction-eval-dataset.md\` §6.3의 **20% 표본 검수**로 갈음됩니다 — ${cases.length}건 중 ${sampleSize}건.`);
    p();
    p(`표본에서 **반려가 한 건이라도 나오면 불일치율이 5%를 넘으므로 batch 전건 재검수**입니다`);
    p(`(${sampleSize}건 중 1건 = ${Math.round(100 / sampleSize)}%). 더 보고 싶으시면 아래 전체 목록에서 골라 보셔도 됩니다.`);
}
p();
p("아래 §표본에 케이스 전문이 그대로 들어 있습니다. **다른 파일을 열 필요가 없습니다.**");
p();
p("---");
p();
p("## 자동 검사 — 에이전트가 이미 돌렸습니다");
p();
p("형식 요건은 전부 기계로 확인했습니다. 검수자는 **케이스가 좋은 케이스인가**만 보면 됩니다.");
p();
p("| 검사 | 결과 |");
p("|---|---|");
p(`| exact duplicate (\`findDuplicateCases\`) | ${duplicates.length === 0 ? "0건" : `**${duplicates.length}건** — ${duplicates.join(", ")}`} |`);
if (isCriticalNegative) {
    // A kind spread would read `-` 0/25 here: categories ②③④ declare nothing
    // to extract. What matters instead is that they declare nothing at all.
    p(`| 기대 결과 없음 (\`docs/ops/memory-extraction-eval-dataset.md\` §4.2) | ${cases.length}건 전부 \`expected: []\` |`);
} else {
    p(`| kind 분포 (한 kind가 40% 초과 금지) | 최대 \`${widestKind?.[0] ?? "-"}\` ${widestKind?.[1] ?? 0}/${cases.length} = **${Math.round(((widestKind?.[1] ?? 0) / cases.length) * 100)}%** |`);
}
p(`| kind 유효성 · 키워드 수 · 키워드의 사용자 발화 실재 · 턴 수 | ${problems.length === 0 ? `${cases.length}건 전부 통과` : `**${problems.length}건 위반**`} |`);
if (problems.length > 0) for (const problem of problems) p(`| | ${problem} |`);
p();
p(`### near-duplicate 상위 쌍 (\`docs/ops/memory-extraction-eval-dataset.md\` §6.5)`);
p();
p("**권고입니다.** 통과·불통과를 정하지 않으며, 다양성 판정은 검수자가 합니다.");
p("같은 틀에 단어만 바꾼 쌍은 shape가 1.00에 가깝고, 같은 주제의 다른 문장은 0.1 안팎입니다.");
p();
p("| token | shape | 쌍 |");
p("|---|---|---|");
for (const pair of cellPairs.slice(0, 10)) {
    p(`| ${pair.token.toFixed(2)} | ${pair.shape.toFixed(2)} | ${pair.a} ~ ${pair.b} |`);
}
p();
p("---");
p();
p(
    isCriticalNegative
        ? `## 전건 — 판정할 ${sampleSize}건`
        : `## 표본 — 판정할 ${sampleSize}건`
);
p();
p("판정은 `채택` / `반려(재작성)` / `반려(폐기)` 중 하나입니다. **`수정 후 채택`은 없습니다** —");
p(`실질 수정은 반려 사유를 남기면 에이전트가 재작성하고 같은 분이 재검수합니다 (\`docs/ops/memory-extraction-eval-dataset.md\` §6.4).`);
p("오탈자처럼 내용을 바꾸지 않는 수정은 `채택`에 포함됩니다.");
p();
for (const index of sample) {
    const entry = cases[index];
    p(`### ${entry.id}`);
    p();
    p(`**제안 gold label**: ${label(entry)}`);
    p();
    p(turnsOf(entry));
    p();
    p("| 판정 | 사유 (반려일 때만) |");
    p("|---|---|");
    p("|  |  |");
    p();
}
p("---");
p();
p("## batch 채택 결정");
p();
p(`\`docs/ops/memory-extraction-eval-dataset.md\` §6.3: 표본만 보고 넘어가는 것은 채택이 아닙니다. 아래에 적어야 나머지가 dataset에 들어갑니다.`);
p();
p("| 항목 | 값 |");
p("|---|---|");
p("| batch 채택 여부 | |");
p(`| 다양성 판정 (\`docs/ops/memory-extraction-eval-dataset.md\` §6.5) | |`);
p("| 검수 완료일 | |");
p();
p("---");
p();
p("## batch 기록 (`docs/ops/memory-extraction-eval-dataset.md` §8)");
p();
p("`docs/ops/memory-extraction-eval-dataset.md` §7.1은 동결 조건으로 초안 도구·모델·버전, 검수자, 판정 근거, draft");
p("disagreement 비율을 요구합니다. 케이스마다 여섯 칸을 채우는 대신 batch에 한 번");
p("적습니다 — 초안 생성자와 검수자는 batch 전체가 같고, 케이스별 draft");
p("disagreement는 위 판정에서 그대로 계산되며, 채택된 케이스의 gold label 근거는");
p("제안 라벨 그 자체입니다.");
p();
p("| 항목 | 값 |");
p("|---|---|");
p("| 초안 생성자 (`ai-draft:<도구>/<모델>/<버전>`) | *(운영자 기입)* |");
p("| 검수자 (사람 · 최초의 권위 있는 판정) | |");
p("| 재작성 회차 | 1 (최초 초안) |");
p(`| draft disagreement 비율 (\`docs/ops/memory-extraction-eval-dataset.md\` §6.4) | 위 표본 ${sampleSize}건에서 계산 |`);
p();
p("초안 생성자 칸을 에이전트가 비워 두는 이유는 하나입니다 — 이 저장소에 남기는");
p("산출물에 에이전트의 모델 식별자를 적지 않는다는 규칙이 있어서, 자기 이름을 적을");
p("수 있는 것은 운영자뿐입니다.");
p();
p("---");
p();
p(`## 전체 ${cases.length}건 (참고용 — 판정 불필요)`);
p();
p("| # | 제안 kind | 키워드 | 첫 사용자 발화 |");
p("|---|---|---|---|");
for (const [index, entry] of cases.entries()) {
    const first = entry.conversations[0].messages.find(
        (message) => message.role === "user"
    );
    const excerpt = (first?.content ?? "").replace(/\|/g, "\\|");
    const mark = sample.includes(index) ? " **←표본**" : "";
    p(
        `| ${index + 1}${mark} | \`${entry.expected[0]?.kind ?? "-"}\` | ${(entry.expected[0]?.mustInclude ?? []).map((k) => `\`${k}\``).join(" + ") || "-"} | ${excerpt.length > 46 ? `${excerpt.slice(0, 44)}…` : excerpt} |`
    );
}
p();

const rendered = `${out.join("\n")}\n`;

/**
 * Regenerating over a reviewed sheet would delete the review.
 *
 * The sheet says "판정란 외에는 손으로 고치지 마세요 -- 다시 생성하면 덮어씁니다",
 * and the verdicts live in exactly the cells that sentence protects. So the
 * protection has to be here rather than in the sentence: once a verdict or the
 * adoption line is filled, `--write` refuses. Recovering a lost verdict means
 * asking the reviewer to judge again, which is the one cost this whole sheet
 * exists to avoid.
 */
if (process.argv.includes("--write")) {
    if (isAdopted) {
        console.error(
            `${batch.id} has been adopted; its record is settled and its cases are ` +
                "in the dataset. Regenerating it would rewrite the document a " +
                "reviewer signed. Print to stdout to compare."
        );
        process.exit(1);
    }
    if (existsSync(batch.record)) {
        const existing = parseBatchRecord(readFileSync(batch.record, "utf8"));
        const filled = [
            ...existing.cases
                .filter((entry) => entry.verdict !== null)
                .map((entry) => `${entry.caseId}=${entry.verdict}`),
            ...(existing.decision === null ? [] : [`batch=${existing.decision}`]),
        ];
        if (filled.length > 0 && !process.argv.includes("--force")) {
            console.error(
                `${batch.record} already carries a review (${filled.join(", ")}).\n` +
                    "Refusing to overwrite it. Print to stdout without --write to see " +
                    "what a regeneration would say, or pass --force if the verdicts " +
                    "are being deliberately discarded."
            );
            process.exit(1);
        }
    }
    writeFileSync(batch.record, rendered);
    console.error(`wrote ${batch.record}`);
} else {
    process.stdout.write(rendered);
}
