/**
 * The succ-7 adoption review sheet.
 *
 * Generated from the modules rather than written by hand, so the sheet cannot
 * describe a dataset the tree does not hold, and regenerating it after an edit
 * shows the edit. All 54 replacements are listed — this is the adoption
 * review, not a sample of it.
 *
 * The sheet does not adopt anything. Verdicts and a signature are a person's,
 * and `frozen` stays false until that happens in its own record.
 *
 * Each case carries the original conversation in full, not just its gold. A
 * reviewer asked whether the replacement tests the same boundary cannot answer
 * that from two label lines: the boundary lives in what was said, and half the
 * defects found in the first review round were clauses the gold never mentioned.
 *
 * The near-duplicate list and the per-cell diversity box are the same argument
 * at bundle scale. A set of cases can be individually correct and still be one
 * case counted fifty-four times, and section 6.5 leaves that judgement to a
 * person — so the sheet has to put the evidence for it on the page.
 */
import { writeFileSync } from "node:fs";

import { MEMORY_EVAL_SUCC7_REPLACEMENTS } from "../lib/memoryEvalSucc7Replacements/index.ts";
import { SUCC7_ASSISTANT_ONLY_SUBTYPES } from "../lib/memoryEvalSucc7Replacements/subtypes.ts";
import { SUCC7_REGRESSION_CORPUS } from "../lib/memoryEvalSucc7Regression.ts";
import { buildSucc7DraftManifest } from "../lib/memoryEvalSucc7.ts";
import { SUCC7_TRANSITION } from "../lib/memoryEvalSucc7Transition.ts";
import { MEMORY_EVAL_SUCC7_CASES } from "../lib/memoryEvalSucc7.ts";
import { nearDuplicatePairs } from "../lib/memoryEvalNearDuplicates.ts";

const out =
    process.argv.find((a) => a.startsWith("--out="))?.slice("--out=".length) ??
    "artifacts/succ7-review.md";

const manifest = buildSucc7DraftManifest();
const byId = new Map(MEMORY_EVAL_SUCC7_REPLACEMENTS.map((c) => [c.id, c]));
const regById = new Map(
    SUCC7_REGRESSION_CORPUS.map((e) => [e.replacementId, e])
);

const shapeOf = (testCase) => {
    const messages = (testCase.conversations ?? []).flatMap(
        (conversation) => conversation.messages ?? []
    );
    const roles = messages.map((message) => message.role[0]).join("");
    return `${(testCase.conversations ?? []).length}\u00d7 ${messages.length}턴 \`${roles}\``;
};
const goldShapeOf = (testCase) =>
    (testCase.expected ?? [])
        .map((gold) => `${gold.kind}/${gold.polarity}`)
        .join(" + ") || "*(없음)*";
const dispositionOf = (testCase) =>
    [
        ...new Set((testCase.expected ?? []).map((g) => g.expectedDisposition)),
    ].join(", ") || "—";

/**
 * The axes a same-boundary judgement actually turns on. Rendered side by side
 * so a difference is visible without the reviewer holding both cases in mind:
 * a replacement that quietly gained a turn, a gold, or a disposition is exactly
 * the kind of drift a prose diff hides.
 *
 * A difference on the turn-shape axis is not by itself drift. The durable cases
 * were rewritten for diversity after the first review, and twelve of them moved
 * from two messages to three; the added turn is a bare acknowledgement in every
 * one. What the axis is for is making that visible rather than silent.
 */
const boundaryAxes = (original, replacement) => [
    ["대화 형태", shapeOf(original), shapeOf(replacement)],
    ["gold kind · polarity", goldShapeOf(original), goldShapeOf(replacement)],
    ["disposition", dispositionOf(original), dispositionOf(replacement)],
    [
        "goldCompleteness",
        original.goldCompleteness ?? "—",
        replacement.goldCompleteness ?? "—",
    ],
    [
        "criticalGoldMode",
        original.criticalGoldMode ?? "—",
        replacement.criticalGoldMode ?? "—",
    ],
];

const REPLACEMENT_IDS = new Set(SUCC7_TRANSITION.map((row) => row.replacement));
const isNew = (id) => REPLACEMENT_IDS.has(id);
const ALL_PAIRS = nearDuplicatePairs([...MEMORY_EVAL_SUCC7_CASES]);
const NEAR_DUPLICATE_TABLES = [
    [
        `조립된 dataset 전체 상위 15쌍 (${ALL_PAIRS.length}쌍 중)`,
        ALL_PAIRS.slice(0, 15),
    ],
    [
        "양쪽 모두 succ-7 대체본인 상위 15쌍",
        ALL_PAIRS.filter((pair) => isNew(pair.a) && isNew(pair.b)).slice(0, 15),
    ],
    [
        "한쪽만 대체본인 상위 10쌍 (대체본이 기존 케이스를 복제했는지)",
        ALL_PAIRS.filter((pair) => isNew(pair.a) !== isNew(pair.b)).slice(0, 10),
    ],
];

const tally = (values) => {
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([value, count]) => `${value} ${count}`)
        .join(", ");
};
const DIVERSITY_ROWS = [
    ...new Set(
        MEMORY_EVAL_SUCC7_REPLACEMENTS.map(
            (testCase) => `${testCase.category}:${testCase.language}`
        )
    ),
]
    .sort()
    .map((cell) => {
        const members = MEMORY_EVAL_SUCC7_REPLACEMENTS.filter(
            (testCase) => `${testCase.category}:${testCase.language}` === cell
        );
        return {
            cell,
            count: members.length,
            shapes: tally(members.map((testCase) => shapeOf(testCase))),
            kinds: tally(
                members.flatMap((testCase) =>
                    (testCase.expected ?? []).map(
                        (gold) => `${gold.kind}/${gold.polarity}`
                    )
                )
            ),
        };
    });

const L = [];
const p = (s = "") => L.push(s);

p("# succ-7 채택 검수 시트");
p("");
p("> **자동 생성 파일입니다.** `npm run make:memory-eval-succ7-review-sheet`로");
p("> 다시 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요.");
p("");
p("## 이 시트가 묻는 것");
p("");
p("succ-7은 **조립됐고 채택되지 않았습니다.** 이 시트의 판정과 서명이 채택의");
p("전제이며, 서명 전까지 `frozen`은 `false`이고 harness는 succ-6을 가리킵니다.");
p("");
p("`frozen`은 manifest identity에 들어 있지 않으므로, 아래 `manifestDigest`는");
p("동결 뒤에도 같은 값입니다 — 검수자가 본 digest가 곧 동결되는 digest입니다.");
p("");
p("각 항목에서 답할 것은 둘입니다.");
p("");
p("1. **대체본이 원본과 같은 경계를 시험하는가** — 소재는 달라야 하고 경계는");
p("   같아야 합니다.");
p("2. **gold가 그 경계에 대해 옳은가** — kind·polarity·토큰·근거 span.");
p("");
p("| 항목 | 값 |");
p("|---|---|");
p(`| datasetVersion | \`${manifest.datasetVersion}\` |`);
p(`| supersedes | \`${manifest.supersedes}\` |`);
p(`| schemaVersion | ${manifest.schemaVersion} |`);
p(`| caseCount | ${manifest.caseCount} |`);
p(`| datasetDigest | \`${manifest.datasetDigest}\` |`);
p(`| manifestDigest | \`${manifest.manifestDigest}\` |`);
p(`| sourceDatasetDigest | \`${manifest.composition.sourceDatasetDigest}\` |`);
p(`| scoringContract | \`${manifest.scoringContractVersion}\` |`);
p(`| fingerprint | v${manifest.fingerprintVersion} (대화 title 포함) |`);
p("| assembled | true |");
p("| reviewed | **false** |");
p(`| frozen | **${manifest.frozen}** |`);
p("| harness target | `mem-eval-succ-6` (변경 없음) |");
p("");
p(
    `표본은 ${MEMORY_EVAL_SUCC7_REPLACEMENTS.length}건 전부입니다. ` +
        `유형별로는 same_boundary ${manifest.transitionTypes.same_boundary}건, ` +
        `coverage_repair ${manifest.transitionTypes.coverage_repair}건이며, ` +
        `coverage repair는 같은 경계 통과 수에 포함하지 않습니다.`
);
p("");
p("---");
p("");

const cellOf = (c) => `${c.category}:${c.language}`;
let n = 0;
for (const row of SUCC7_TRANSITION) {
    const rep = byId.get(row.replacement);
    const reg = regById.get(row.replacement);
    n += 1;
    p(`## ${n}. \`${rep.id}\``);
    p("");
    p(
        `**${cellOf(rep)}** · 원본 \`${row.retired}\` · 근거 \`${row.basis}\`` +
            ` · 유형 \`${row.transitionType}\`` +
            (SUCC7_ASSISTANT_ONLY_SUBTYPES[rep.id]
                ? ` · subtype ${SUCC7_ASSISTANT_ONLY_SUBTYPES[rep.id].subtype}`
                : "")
    );
    p("");
    p("원본 대화 전문 (regression 보존형):");
    p("");
    for (const cv of reg.regressionCase.conversations ?? []) {
        p(`- *(제목)* ${cv.title}`);
        for (const m of cv.messages ?? []) {
            p(`- **${m.role}** — ${m.content}`);
        }
    }
    p("");
    p("원본이 시험하던 것 (regression 보존형):");
    p("");
    for (const g of reg.regressionCase.expected ?? []) {
        p(
            `- \`${g.kind}\` · ${g.polarity} · ${g.expectedDisposition} · ` +
                `\`[${(g.factValueAll ?? []).join(", ")}]\``
        );
    }
    if ((reg.regressionCase.expected ?? []).length === 0) p("- *(gold 없음)*");
    if (reg.correctionRecord.length > 0) {
        p("");
        p("> 이 원본은 승인된 **수정 gold**로 보존됩니다. succ-6 행의 gold가 아닙니다.");
    }
    p("");
    p("새 대화:");
    p("");
    for (const cv of rep.conversations ?? []) {
        // The title is model input: `renderConversation()` writes it into the
        // prompt as `## <label>: <title>`, and fingerprint v4 exists because v3
        // left it out of the digest. A sheet that omits it asks for a signature
        // on something the signer was not shown.
        p(`- *(제목)* ${cv.title}`);
        for (const m of cv.messages ?? []) {
            p(`- **${m.role}** — ${m.content}`);
        }
    }
    p("");
    if (row.unresolvedPolicy) {
        p("> **미해결 정책 질문 (regression에 보존)**");
        p(">");
        p(`> ${row.unresolvedPolicy}`);
        p(">");
        p("> 이 전환은 이 질문에 답하지 않으며, whole-turn fail-closed 규칙을");
        p("> 바꾸지 않습니다. 그래서 같은 경계 대체가 아니라 coverage repair입니다.");
        p("");
    }
    p("새 gold:");
    p("");
    for (const g of rep.expected ?? []) {
        p(
            `- \`${g.kind}\` · ${g.polarity} · ${g.expectedDisposition} · ` +
                `\`[${(g.factValueAll ?? []).join(", ")}]\``
        );
        p(`    - 근거: \`${g.evidence.evidenceMessageId}\` — "${g.evidence.evidenceQuote}"`);
    }
    p("");
    p("경계 대조:");
    p("");
    p("| 축 | 원본 | 대체본 | |");
    p("|---|---|---|---|");
    for (const [axis, a, b] of boundaryAxes(reg.regressionCase, rep)) {
        p(`| ${axis} | ${a} | ${b} | ${a === b ? "=" : "**≠**"} |`);
    }
    p("");
    p("| 항목 | 값 |");
    p("|---|---|");
    if (row.transitionType === "coverage_repair") {
        p("| 같은 경계를 시험하는가 | **해당 없음** (coverage repair) |");
    } else {
        p("| 같은 경계를 시험하는가 (예 / 아니오) | |");
    }
    p("| gold가 옳은가 (예 / 아니오) | |");
    p("| 아니라면 무엇이 문제인가 | |");
    p("");
    p("---");
    p("");
}

p("## near-duplicate 상위 목록");
p("");
p("`nearDuplicatePairs()`(6.5절)를 조립된 succ-7 전체에 돌린 결과입니다.");
p("**advisory입니다** — 어디를 볼지 알려 줄 뿐 통과·불통과를 정하지 않습니다.");
p("점수가 낮다고 다양성이 확보된 것도 아닙니다: 이 척도는 어휘와 형태를 보며,");
p("서로 다른 소재로 같은 문장 틀을 반복한 묶음은 낮은 점수로도 통과합니다.");
p("그래서 아래 세 표를 나눠 싣습니다 — 대체본끼리의 순위는 전체 순위에 묻힙니다.");
p("");
for (const [caption, rows] of NEAR_DUPLICATE_TABLES) {
    p(`**${caption}**`);
    p("");
    p("| token | shape | cell | 쌍 |");
    p("|---|---|---|---|");
    if (rows.length === 0) p("| — | — | — | *(없음)* |");
    for (const pair of rows) {
        p(
            `| ${pair.token.toFixed(2)} | ${pair.shape.toFixed(2)} | ` +
                `\`${pair.cell}\` | \`${pair.a}\` ~ \`${pair.b}\` |`
        );
    }
    p("");
}

p("## cell별 다양성 판정");
p("");
p("각 cell의 대체본이 **서로 다른 케이스인지**를 봅니다. 개별 gold가 옳은 것과");
p("묶음이 다양한 것은 다른 질문이고, 뒤쪽은 위 54개 판정란 어디에도 없습니다.");
p("한 줄에 하나씩, 대화 형태와 kind 분포를 함께 싣습니다 — 같은 형태가 한 cell을");
p("가득 채우면 그 cell은 표본 하나를 여러 번 센 것입니다.");
p("");
p("| cell | 건수 | 대화 형태 | kind · polarity 분포 | 다양성 (충분 / 불충분) | 근거 |");
p("|---|---|---|---|---|---|");
for (const row of DIVERSITY_ROWS) {
    p(`| \`${row.cell}\` | ${row.count} | ${row.shapes} | ${row.kinds} | | |`);
}
p("");
p("> 한 cell이라도 **불충분**이면 succ-7은 채택되지 않습니다. 개별 54건이 모두");
p("> 옳아도 마찬가지입니다.");
p("");

p("## 채택 판정");
p("");
p("| 항목 | 값 |");
p("|---|---|");
p("| 검수자 | |");
p("| 검수일 | |");
p("| same_boundary 통과 건수 (53 중) | |");
p("| coverage_repair 판정 (해당 없음 / gold 적합) | |");
p("| 문제 있는 건수 | |");
p("| 다양성 판정 (모든 cell 충분 / 하나라도 불충분) | |");
p("| succ-7을 decision set으로 채택하는가 | |");
p("");
p("마지막 줄이 **채택**입니다. 이 시트도, 어떤 검사도 그것을 대신하지");
p("않습니다. 서명 뒤에야 `FROZEN=true` 전환과 manifest literal pin, harness");
p("target 이동이 각각 별도 변경으로 이어집니다.");
p("");

writeFileSync(out, L.join("\n"), "utf8");
console.log(
    `Wrote ${MEMORY_EVAL_SUCC7_REPLACEMENTS.length} case(s) to ${out}\n` +
        `assembled=true  reviewed=false  frozen=${manifest.frozen}  ` +
        `harness target=mem-eval-succ-6`
);
