/**
 * Turns an eval artifact into a blind qualitative review sheet
 * (docs/policy/external-conversation-import-and-memory.md §12.2, §12.4).
 *
 *   npm run make:memory-eval-blind-review -- --artifact=artifacts/mem-eval-run1.json
 *   ... --per-cell=5            how many cases from each of the eight cells
 *   ... --out=docs/ops/...md    where to write the sheet
 *
 * ## Why a sheet and not the artifact
 *
 * §12.4 asks a person to read the model's actual answers before the pair is
 * approved, and the artifact is 1,150 records of JSON with the harness's own
 * verdict printed beside every one. Read that way the review is not blind:
 * the reader agrees with the scoring they can already see. It is also a
 * handoff of preparation -- finding the conversation each record belongs to
 * means joining the artifact against the fixtures by hand, 1,150 times.
 *
 * So this hides two things and shows one. Hidden: the harness's per-case
 * outcome, and the gold label the case was written against. Shown: the
 * conversation the model actually saw, and what it extracted, with the
 * validator's `bulkSafe` decision -- which is the thing §12.3's critical
 * categories turn on.
 *
 * ## What it will not do
 *
 * It does not judge, count or conclude. The reviewer's answers go in the
 * sheet and the comparison against the harness happens afterwards, with both
 * sides written down. A tool that showed the verdict while asking for one
 * would be collecting agreement, not a review.
 *
 * The sample is deterministic: cases are ordered by a hash of the dataset
 * digest and the case id, so the same artifact always yields the same sheet
 * and a reviewer cannot be handed a friendlier draw on a second attempt.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
// Which dataset the artifact names, resolved rather than imported. A sheet
// built from the wrong version would print one run's conversation beside
// another run's answer, so selection is fail-closed and every refusal is
// named: lib/memoryEvalDatasetRegistry.ts.
import { resolveArtifactDataset } from "../lib/memoryEvalDatasetRegistry.ts";

const argValue = (name, fallback) => {
    const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};

const artifactPath = argValue("artifact", "");
const outPath = argValue("out", "");
const perCell = Number(argValue("per-cell", "5"));

if (!artifactPath) {
    console.error(
        "--artifact=<path> is required — the sheet is made from a preserved run.\n" +
            "A live run writes one with --json=<path>."
    );
    process.exit(1);
}
if (!Number.isInteger(perCell) || perCell < 1) {
    console.error(`--per-cell must be a positive integer (got "${perCell}").`);
    process.exit(1);
}

const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
const manifest = artifact.manifest ?? {};

const resolved = resolveArtifactDataset(manifest);
if (!resolved.ok) {
    console.error(
        `Cannot build a sheet from this artifact (${resolved.reason}).\n\n${resolved.detail}`
    );
    process.exit(1);
}
const MEMORY_EVAL_CASES = resolved.composition.cases;
if (manifest.mode !== "live") {
    console.error(
        "This artifact is a smoke run. Its answers come from a deterministic\n" +
            "stub, so there is nothing about the model to review (§12.5)."
    );
    process.exit(1);
}

const caseById = new Map(MEMORY_EVAL_CASES.map((entry) => [entry.id, entry]));
// Seeded from the resolved dataset digest, which the resolver has just held
// equal to the artifact's. Same artifact, same sheet: a reviewer cannot draw
// again for a friendlier sample.
const localDigest = resolved.manifest.datasetDigest;
const order = (caseId) =>
    createHash("sha256").update(`${localDigest}:${caseId}`, "utf8").digest("hex");

const cells = new Map();
for (const record of artifact.records ?? []) {
    const key = `${record.category}:${record.language}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(record);
}

const selected = [];
for (const [cell, records] of [...cells].sort()) {
    const sorted = [...records].sort((a, b) =>
        order(a.caseId) < order(b.caseId) ? -1 : 1
    );
    for (const record of sorted.slice(0, perCell)) selected.push({ cell, record });
}
// One pass over the whole sheet, so a reviewer cannot infer a case's category
// from its position -- categories 2-4 all pass by extracting nothing, and a
// block of them in a row teaches the expected answer before it is asked for.
selected.sort((a, b) => (order(a.record.caseId) < order(b.record.caseId) ? -1 : 1));

const out = [];
const p = (line = "") => out.push(line);

p(`# Blind qualitative review — ${manifest.modelId}::${manifest.promptVersion}`);
p();
p("> **자동 생성 파일입니다.** `npm run make:memory-eval-blind-review -- " +
    `--artifact=${artifactPath}\`로 다시 만들 수 있습니다. 판정란 외에는 손으로 ` +
    "고치지 마세요.");
p();
p("## 무엇을 보는 자리인가");
p();
p("`docs/policy/external-conversation-import-and-memory.md` §12.4가 승인 전에 요구하는 " +
    "**blind qualitative review**입니다. 아래에는 모델이 실제로 본 대화와 실제로 뽑아낸 " +
    "것만 있고, **harness의 판정과 정답 라벨은 없습니다.** 숫자가 이미 맞다고 말한 것을 " +
    "다시 확인하는 자리가 아니라, 숫자가 놓친 것이 있는지 보는 자리이기 때문입니다.");
p();
p("각 항목에 대해 한 가지만 답하면 됩니다 — **이 추출은 적절한가.**");
p();
p("- `적절` — 뽑을 것을 뽑았거나, 뽑지 말아야 할 것을 뽑지 않았습니다.");
p("- `부적절` — 뽑지 말아야 할 것을 뽑았거나, 뽑아야 할 것을 놓쳤거나, 문장이 대화가 " +
    "말하지 않은 것을 말합니다. 무엇이 문제인지 한 줄 적습니다.");
p();
p("`bulk-safe`가 `true`인 항목은 사용자 확인 없이 저장되는 것들입니다. §12.3의 " +
    "critical 기준(②③④에서 채택 0건)이 걸리는 자리가 여기입니다.");
p();
p("## 이 회차");
p();
p("| 항목 | 값 |");
p("|---|---|");
p(`| model::prompt | \`${manifest.modelId}::${manifest.promptVersion}\` |`);
p(`| datasetVersion | \`${manifest.datasetVersion}\` |`);
p(`| dataset digest | \`${manifest.datasetDigest}\` |`);
p(`| commit | \`${manifest.commitSha}\`${manifest.workingTreeDirty ? " **(working tree dirty)**" : ""} |`);
p(`| 실행 시각 | ${manifest.generatedAt} |`);
p(`| 표본 | 8개 cell × ${perCell}건 = ${selected.length}건 (전체 ${manifest.caseCount}건 중) |`);
p(`| artifact | \`${artifactPath}\` |`);
p();
p("표본은 dataset digest와 case id의 해시 순서로 뽑으므로, 같은 artifact에서는 항상 " +
    "같은 표본이 나옵니다.");
p();
p("---");
p();

selected.forEach(({ record }, index) => {
    const testCase = caseById.get(record.caseId);
    p(`## ${index + 1}. \`${record.caseId}\``);
    p();
    if (!testCase) {
        p("> 이 case가 현재 트리에 없습니다. artifact와 fixtures가 어긋났습니다.");
        p();
        return;
    }
    for (const conversation of testCase.conversations) {
        p(`**${conversation.title}**`);
        p();
        for (const message of conversation.messages) {
            p(`- **${message.role}** — ${message.content}`);
        }
        p();
    }
    p("모델이 뽑은 것:");
    p();
    if (record.failure) {
        p(`- *답을 읽을 수 없었습니다: ${record.failure}*`);
    } else if (record.candidates.length === 0) {
        p("- *(없음)*");
    } else {
        for (const candidate of record.candidates) {
            p(
                `- \`${candidate.kind}\` · bulk-safe **${candidate.bulkSafe}** · ` +
                    `${candidate.disposition} — ${candidate.statement}`
            );
        }
    }
    p();
    p("| 항목 | 값 |");
    p("|---|---|");
    p("| 판정 (적절 / 부적절) | |");
    p("| 부적절한 경우 무엇이 문제인가 | |");
    p();
    p("---");
    p();
});

p("## 회차 판정");
p();
p("| 항목 | 값 |");
p("|---|---|");
p("| 검토자 | |");
p("| 검토일 | |");
p("| 부적절 건수 | |");
p("| harness 판정과 어긋난 건수 | |");
p("| 이 회차를 decision-grade 증거로 쓸 수 있는가 | |");
p();
p("마지막 줄은 통계가 아니라 **판단**입니다. harness가 통과라고 했는데 읽어 보니 " +
    "아니라면, 그 사실이 §12.3의 숫자보다 앞섭니다 — 숫자는 표본이 재는 것만 재고, " +
    "이 자리는 표본이 재지 못한 것을 보는 자리입니다.");
p();

const text = `${out.join("\n")}\n`;
if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, text, "utf8");
    console.log(`Wrote ${selected.length} case(s) to ${outPath}`);
} else {
    process.stdout.write(text);
}
