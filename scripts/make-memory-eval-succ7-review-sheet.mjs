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
 */
import { writeFileSync } from "node:fs";

import { MEMORY_EVAL_SUCC7_REPLACEMENTS } from "../lib/memoryEvalSucc7Replacements/index.ts";
import { SUCC7_ASSISTANT_ONLY_SUBTYPES } from "../lib/memoryEvalSucc7Replacements/subtypes.ts";
import { SUCC7_REGRESSION_CORPUS } from "../lib/memoryEvalSucc7Regression.ts";
import { buildSucc7DraftManifest } from "../lib/memoryEvalSucc7.ts";
import { SUCC7_TRANSITION } from "../lib/memoryEvalSucc7Transition.ts";

const out =
    process.argv.find((a) => a.startsWith("--out="))?.slice("--out=".length) ??
    "artifacts/succ7-review.md";

const manifest = buildSucc7DraftManifest();
const byId = new Map(MEMORY_EVAL_SUCC7_REPLACEMENTS.map((c) => [c.id, c]));
const regById = new Map(
    SUCC7_REGRESSION_CORPUS.map((e) => [e.replacementId, e])
);

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

p("## 채택 판정");
p("");
p("| 항목 | 값 |");
p("|---|---|");
p("| 검수자 | |");
p("| 검수일 | |");
p("| same_boundary 통과 건수 (53 중) | |");
p("| coverage_repair 판정 (해당 없음 / gold 적합) | |");
p("| 문제 있는 건수 | |");
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
