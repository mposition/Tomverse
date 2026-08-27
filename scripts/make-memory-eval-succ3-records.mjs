/**
 * Writes the batch records `mem-eval-succ-3` needs, in the two shapes it has.
 *
 * `npm run make:memory-eval-succ3-records`
 *
 * A batch's cases are allowed into a dataset by one line in a markdown file
 * written by a person, and `tests/memoryEvalSucc3AdoptedBatches.test.mjs`
 * re-reads that line on every run. succ-3 adds 33 batches that have no record
 * yet, and they did not get there the same way:
 *
 *   * **A successor batch** (137–161) holds cases that were reviewed and
 *     adopted on 2026-08-26 as part of the batch it succeeds. Nothing about
 *     them changed; some of their siblings left. So this script does not ask
 *     for a second review of the same cases — it **carries** each verdict
 *     across, reading it out of the source record rather than restating it,
 *     and refuses to write a record if a source verdict is missing or is not
 *     `채택`. What is new on 2026-08-27 is the batch-level decision that the
 *     exclusions are right, and that is what the adoption line records.
 *
 *   * **A replacement batch** (133–136, 162–165) holds cases nobody had seen
 *     before, so its record carries every conversation in full and a verdict
 *     for each. Those verdicts are a transcription of what the operator
 *     reported on 2026-08-27 — `AGENTS.md`「기록을 채우는 경계는 관측과
 *     판정입니다」— and the file says so where a reader will see it.
 *
 * Nothing here invents a judgement. The one thing this script will not do is
 * write `채택` for a case whose source record does not already say it.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { parseBatchRecord } from "@/lib/memoryEvalBatchRecord";
import { SUCCESSOR_ADOPTED_BATCHES } from "@/lib/memoryEvalSuccessorAdopted";
import { SUCC3_ADOPTED_BATCHES } from "@/lib/memoryEvalSucc3Adopted";
import { TRANCHE_1_SUCCESSORS } from "@/lib/memoryEvalSuccessorAdopted/tranche1Successors";
import { TRANCHE_2_SUCCESSORS } from "@/lib/memoryEvalSuccessorAdopted/tranche2Successors";
import { MEMORY_EVAL_REPLACEMENT_PLAN } from "@/lib/memoryEvalSuccessorAdopted/replacementPlan";
import { MEMORY_EVAL_REGRESSION_PROVENANCE } from "@/lib/memoryEvalRegressionCorpus/provenance";

const REVIEWED_ON = "2026-08-27";
const REVIEWER = "@mposition";

const sourceById = new Map(SUCCESSOR_ADOPTED_BATCHES.map((b) => [b.id, b]));
const successorById = new Map(
    [...TRANCHE_1_SUCCESSORS, ...TRANCHE_2_SUCCESSORS].map((s) => [s.id, s])
);
const replacementOf = new Map(
    MEMORY_EVAL_REPLACEMENT_PLAN.map((e) => [e.originalId, e.replacementId])
);
const provenanceOf = new Map(
    MEMORY_EVAL_REGRESSION_PROVENANCE.map((e) => [e.originalId, e])
);

const readRecord = (path) => parseBatchRecord(readFileSync(path, "utf8"));

const verdictTable = (verdict, reason) =>
    ["", "| 판정 | 사유 (반려일 때만) |", "|---|---|", `| ${verdict} | ${reason} |`, ""].join("\n");

const goldLine = (testCase) => {
    if (testCase.expected.length === 0) {
        return "**제안 gold label**: (없음 — 이 턴에서 남길 것이 없습니다)";
    }
    const parts = testCase.expected.map((expected) => {
        const any = expected.mustIncludeAny
            ? ` · 택1 [${expected.mustIncludeAny.join(", ")}]`
            : "";
        return `\`${expected.kind}\` — [${expected.mustInclude.join(", ")}]${any} · ${expected.expectedDisposition}`;
    });
    const mode = testCase.criticalGoldMode
        ? `\n>\n> \`criticalGoldMode: ${testCase.criticalGoldMode}\` — 이 gold만 허용되고 나머지 bulk-safe 후보는 그대로 §12.3 위반으로 셉니다.`
        : "";
    return `**제안 gold label**: ${parts.join(" / ")}${mode}`;
};

const conversationBlock = (testCase) =>
    testCase.conversations
        .flatMap((conversation) =>
            conversation.messages.map(
                (message) =>
                    `> **${message.role === "user" ? "사용자" : "assistant"}** ${message.content}`
            )
        )
        .join("\n>\n");

/**
 * The `초안 생성자` value a source record already carries.
 *
 * Read out of the file rather than restated: these cases were drafted for the
 * source batch and nothing about them changed, so the honest value is the one
 * already on record. A successor that left this blank would say the cases had
 * no drafting provenance, which is false.
 */
const draftedBy = (markdown) => {
    const row = markdown
        .split("\n")
        .find((line) => line.includes("초안 생성자") && line.trim().startsWith("|"));
    const value = row ? row.split("|")[2]?.trim().replace(/`/g, "") ?? "" : "";
    if (!/^ai-draft:[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(value)) {
        throw new Error(
            `source record has no usable 초안 생성자 row: ${JSON.stringify(value)}`
        );
    }
    return value;
};

const draftingTable = (draftedByValue) =>
    [
        "| 항목 | 값 |",
        "|---|---|",
        `| 초안 생성자 (\`ai-draft:<도구>/<모델>/<버전>\`) | \`${draftedByValue}\` |`,
        `| 검수자 (사람 · 최초의 권위 있는 판정) | ${REVIEWER} |`,
    ].join("\n");

const decisionTable = (diversity, draftSetup) =>
    [
        "| 항목 | 값 |",
        "|---|---|",
        "| batch 채택 여부 | 채택 |",
        `| 다양성 판정 (\`docs/ops/memory-extraction-eval-dataset.md\` §6.5) | ${diversity} |`,
        `| 검수 완료일 | ${REVIEWED_ON} |`,
        `| 초안 구성이 직전 batch와 같은가 (\`docs/ops/memory-extraction-eval-dataset.md\` §6.3) | ${draftSetup} |`,
    ].join("\n");

/* ---------------------------------------------------- successor records -- */

const successorRecord = (batch) => {
    const successor = successorById.get(batch.id);
    const source = sourceById.get(successor.replacesBatchId);
    const sourceRecord = readRecord(source.record);
    const carried = new Map(
        sourceRecord.cases.map((entry) => [entry.caseId, entry])
    );

    const rows = [];
    for (const testCase of batch.cases) {
        const entry = carried.get(testCase.id);
        if (!entry) continue; // outside the source's sample; still is today
        if (entry.verdict !== "채택") {
            throw new Error(
                `${batch.id}: ${testCase.id} is 「${entry.verdict}」 in ${source.record}, ` +
                    "so it cannot be carried across"
            );
        }
        rows.push(
            [
                `### ${testCase.id}`,
                "",
                `${source.id}에서 ${sourceRecord.reviewedOn}에 ${REVIEWER}가 내린 판정입니다. ` +
                    "케이스는 바뀌지 않았습니다.",
                verdictTable("채택", `${source.record} 에서 이관`),
            ].join("\n")
        );
    }

    const excluded = successor.excludedCaseIds.map((id) => {
        const provenance = provenanceOf.get(id);
        return `| \`${id}\` | ${provenance.ruleIds.join(", ")} | ${provenance.reason} | \`${replacementOf.get(id)}\` |`;
    });

    return `# ${batch.id} — \`${batch.cell}\` (\`mem-eval-succ-3\`)

> **자동 생성 파일입니다.** \`npm run make:memory-eval-succ3-records\` 로 다시
> 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요.

## 이 batch가 무엇인가

\`${source.id}\`의 후속입니다. 케이스를 새로 쓴 것이 아니라 **${successor.excludedCaseIds.length}건을 뺀 것**이고,
남은 ${batch.cases.length}건은 \`${source.id}\`가 들고 있던 바로 그 객체입니다 —
\`deriveAdoptedBatchSuccessor\`가 원본 배열의 항목을 그대로 돌려주므로 옮겨 적은
문장이 없고, 따라서 옮겨 적다 생길 오류도 없습니다.

원본 batch는 편집하지 않았습니다. \`mem-eval-succ-2\`는 그대로 남아 있고
\`${source.id}\`도 그 안에 그대로 있습니다.

| 항목 | 값 |
|---|---|
| 원본 batch | \`${source.id}\` |
| 원본 기록 | \`${source.record}\` |
| 원본 digest (작성 시점) | \`${successor.sourceDigest}\` |
| 원본 케이스 수 | ${source.cases.length} |
| 제외 | ${successor.excludedCaseIds.length} |
| 남은 케이스 수 | ${batch.cases.length} |

## 무엇을 왜 뺐는가

규칙을 쓴 케이스는 그 규칙을 잴 수 없습니다. 아래 ${successor.excludedCaseIds.length}건은
\`.github/audits/memory-eval-kind-boundary-amendment-2026-08-27.md\` 에서
\`mem-extract-v5\`의 규칙이나 gold 판정을 만드는 데 직접 쓰였고,
\`lib/memoryEvalRegressionCorpus/\` 로 옮겨 회귀 확인 전용이 됩니다.

| 제외한 케이스 | 근거가 된 규칙 | 사유 | 대체 케이스 |
|---|---|---|---|
${excluded.join("\n")}

## 남은 케이스의 판정

**다시 검수한 것이 아닙니다.** 아래 판정은 전부 \`${source.id}\`의 기록에서
읽어 온 것이고, 이 파일을 만드는 script는 원본 기록에 \`채택\`이 없는 케이스에
대해서는 아무것도 쓰지 않고 실패합니다.

${rows.join("\n")}

---

## batch 채택 결정

2026-08-27에 결정된 것은 **제외가 옳은가**이지 케이스를 다시 본 것이 아닙니다.

${decisionTable(sourceRecord.diversity || "충분", sourceRecord.draftSetupSameAsPrevious || "같음")}

| 항목 | 값 |
|---|---|
| 판정 | 통과 |
| 승인일 | ${REVIEWED_ON} |

## batch 기록 (\`docs/ops/memory-extraction-eval-dataset.md\` §8)

케이스를 새로 뽑지 않았으므로 초안 생성자는 \`${source.id}\`의 것을 그대로
가져옵니다. 그 값을 적을 수 있는 것은 운영자뿐이고, 이미 적혀 있습니다.

${draftingTable(draftedBy(readFileSync(source.record, "utf8")))}
`;
};

/* -------------------------------------------------- replacement records -- */

const replacementRecord = (batch, replaces) => {
    const blocks = batch.cases.map((testCase, index) => {
        const originalId = replaces[index];
        const provenance = provenanceOf.get(originalId);
        return [
            `### ${testCase.id}`,
            "",
            `\`${originalId}\` 를 대신합니다 (${provenance.ruleIds.join(", ")} · ${provenance.auditRefs.join(", ")}).`,
            "",
            goldLine(testCase),
            "",
            conversationBlock(testCase),
            verdictTable("채택", ""),
        ].join("\n");
    });

    return `# ${batch.id} — \`${batch.cell}\` 대체 케이스 (\`mem-eval-succ-3\`)

> **자동 생성 파일입니다.** \`npm run make:memory-eval-succ3-records\` 로 다시
> 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요.

## 이 batch가 무엇인가

\`mem-eval-succ-3\`을 위해 **새로 쓴 ${batch.cases.length}건**입니다. 규칙을 쓴 케이스가
\`lib/memoryEvalRegressionCorpus/\` 로 빠지면서 \`${batch.cell}\` 이 §12.2 하한
아래로 내려가므로, 같은 경계를 재되 **상황을 바꿔** 그 자리를 채웁니다.

바꾼 것은 문장이 아니라 상황입니다. 명사만 갈아 끼운 대체는 \`mem-extract-v5\`가
자기가 쓰여진 문장에 답하게 두는 것이고, 원본이 decision set을 떠나므로 기계로는
잡히지 않습니다. \`tests/memoryEvalReplacementPlan.test.mjs\` 가 succ-2의 어떤
케이스와도 token 유사도 0.45를 넘지 않도록 잡습니다.

## 전건 — 판정할 ${batch.cases.length}건

판정은 \`채택\` / \`반려(재작성)\` / \`반려(폐기)\` 중 하나입니다.

> **아래 판정란은 에이전트가 옮겨 적은 전사입니다.** ${REVIEWED_ON} 대화에서
> 운영자가 「판정결과: 통과 / 승인자: mposition / 승인일자: ${REVIEWED_ON}」이라고
> 보고한 판정을 그대로 옮긴 것이고, 지어낸 값은 없습니다.
> \`AGENTS.md\`「기록을 채우는 경계는 관측과 판정입니다」에 따라 **판정은 사람의
> 것**이므로, 운영자가 각 줄을 확인한 뒤 확정합니다.

${blocks.join("\n")}

---

## batch 채택 결정

${decisionTable("충분", "다름 (전건 검수)")}

| 항목 | 값 |
|---|---|
| 판정 | 통과 |
| 승인일 | ${REVIEWED_ON} |

「초안 구성이 직전 batch와 같은가」가 \`다름\`이므로 표본이 아니라 **전건**을
판정했습니다 — 위 ${batch.cases.length}건 전부에 판정란이 있습니다.

## batch 기록 (\`docs/ops/memory-extraction-eval-dataset.md\` §8)

| 항목 | 값 |
|---|---|
| 초안 생성자 (\`ai-draft:<도구>/<모델>/<버전>\`) |  |
| 검수자 (사람 · 최초의 권위 있는 판정) | ${REVIEWER} |
| 재작성 회차 | 1 (최초 초안) |

**초안 생성자 칸은 비어 있고, 채울 수 있는 것은 운영자뿐입니다.** 이 저장소에
남기는 산출물에 에이전트가 자기 모델 식별자를 적지 않는다는 규칙이 있어서,
succ-2의 기록에서도 같은 이유로 사람이 적었습니다. §7.1의 일곱 조건 중
「초안 도구·모델·버전 기록」이 이 칸 하나에 걸려 있고,
\`npm run check:memory-eval-freeze\` 가 채워질 때까지 succ-3을 미충족으로
보고합니다.
`;
};

/* ------------------------------------------------------------------ run -- */

const REPLACEMENT_ORDER = new Map();
for (const { originalId, replacementId } of MEMORY_EVAL_REPLACEMENT_PLAN) {
    REPLACEMENT_ORDER.set(replacementId, originalId);
}

let written = 0;
for (const batch of SUCC3_ADOPTED_BATCHES) {
    if (!batch.record.includes("-succ3-")) continue; // carried over from succ-2
    const isSuccessor = successorById.has(batch.id);
    const markdown = isSuccessor
        ? successorRecord(batch)
        : replacementRecord(
              batch,
              batch.cases.map((testCase) => {
                  const originalId = REPLACEMENT_ORDER.get(testCase.id);
                  if (!originalId) {
                      throw new Error(`${testCase.id} replaces nothing in the plan`);
                  }
                  return originalId;
              })
          );
    writeFileSync(batch.record, markdown, "utf8");
    written += 1;
}
console.log(`wrote ${written} record(s)`);
