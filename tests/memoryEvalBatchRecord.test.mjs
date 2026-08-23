import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    draftDisagreementRate,
    parseBatchRecord,
    promotionBlockers,
} from "../lib/memoryEvalBatchRecord.ts";
import { CANDIDATE_BATCHES } from "../lib/memoryExtractionEvalCandidates/index.ts";

/**
 * docs/ops/memory-extraction-eval-dataset.md §6.3 turned "the reviewer saw the sample" into a thing that must
 * be written down, and §7.1 made that writing a freeze condition. This file
 * is what makes reading it back a fact rather than an impression.
 *
 * Every test here is a way the parser could report a batch as reviewed when
 * it was not.
 */

const sheet = (body) => `# batch-999 — \`durable_facts:ko\` 검수 시트

## 표본 — 판정할 2건

### case-a

| 판정 | 사유 (반려일 때만) |
|---|---|
| ${body.a} | ${body.aReason ?? ""} |

### case-b

| 판정 | 사유 (반려일 때만) |
|---|---|
| ${body.b} | ${body.bReason ?? ""} |

## batch 채택 결정

| 항목 | 값 |
|---|---|
| batch 채택 여부 | ${body.decision} |
| 다양성 판정 (\`docs/ops/memory-extraction-eval-dataset.md\` §6.5) | ${body.diversity ?? ""} |
| 검수 완료일 | ${body.reviewedOn ?? ""} |
`;

test("an unreviewed sheet reports no verdicts, not the table headers", () => {
    // The header row is a table row by shape. Reading `| 판정 | 사유 |` as a
    // verdict would make a blank sheet describe itself as reviewed, which is
    // the one outcome docs/ops/memory-extraction-eval-dataset.md §6.3 exists to prevent.
    const record = parseBatchRecord(
        sheet({ a: "", b: "", decision: "" })
    );
    assert.equal(record.cases.length, 2);
    assert.deepEqual(
        record.cases.map((entry) => entry.verdict),
        [null, null]
    );
    assert.equal(record.decision, null);
    assert.equal(draftDisagreementRate(record), null);
    // The rows above are literally `|  |  |`, which is also what a markdown
    // separator looks like once you allow one made only of spaces and pipes.
    // Reading them as separators made an entire unreviewed batch parse as
    // having no cases -- an empty record and a record of blanks are not the
    // same fact, and only one of them means "the sheet was never filled in".
    assert.equal(record.cases[0].caseId, "case-a");
});

test("a transcription marker qualifies a verdict, it does not become one", () => {
    // The approval tables in docs/ops/memory-extraction-eval-dataset.md mark an agent-transcribed value
    // `*(전사 — 확인 필요)*`, and batch records use the same convention.
    const record = parseBatchRecord(
        sheet({
            a: "채택 *(전사 — 확인 필요)*",
            b: "`채택`",
            decision: "채택 *(전사 — 확인 필요)*",
            diversity: "충분",
            reviewedOn: "2026-08-23",
        })
    );
    assert.deepEqual(
        record.cases.map((entry) => entry.verdict),
        ["채택", "채택"]
    );
    assert.equal(record.decision, "채택");
    assert.deepEqual(promotionBlockers(record), []);
});

test("a word outside the verdict list is not a verdict", () => {
    // docs/ops/memory-extraction-eval-dataset.md §8 lists three verdicts and drops `수정 후 채택` on purpose. A parser
    // that accepted a fourth would decide what the reviewer meant.
    const record = parseBatchRecord(
        sheet({ a: "수정 후 채택", b: "OK", decision: "아마도" })
    );
    assert.deepEqual(
        record.cases.map((entry) => entry.verdict),
        [null, null]
    );
    assert.equal(record.decision, null);
    const blockers = promotionBlockers(record);
    assert.ok(blockers.some((line) => line.includes("carry no verdict")));
    assert.ok(blockers.some((line) => line.includes("adoption line")));
});

test("a rejection blocks the batch and counts as draft disagreement", () => {
    // docs/ops/memory-extraction-eval-dataset.md §6.3: one rejection in a five-case sample is 20%, over the 5%
    // threshold, so the batch is re-reviewed in full rather than promoted.
    const record = parseBatchRecord(
        sheet({
            a: "채택",
            b: "반려(재작성)",
            bReason: "assistant 발언이 근거",
            decision: "채택",
            diversity: "충분",
            reviewedOn: "2026-08-23",
        })
    );
    assert.equal(draftDisagreementRate(record), 0.5);
    assert.equal(record.cases[1].reason, "assistant 발언이 근거");
    assert.ok(
        promotionBlockers(record).some((line) => line.includes("were rejected"))
    );
});

test("a reviewer who declined to decide has not adopted", () => {
    const record = parseBatchRecord(
        sheet({
            a: "채택",
            b: "채택",
            decision: "보류",
            diversity: "다시 볼 것",
            reviewedOn: "2026-08-23",
        })
    );
    assert.equal(record.decision, "보류");
    assert.ok(
        promotionBlockers(record).some((line) => line.includes("보류"))
    );
});

test("the diversity judgement and the review date are required, not decorative", () => {
    // docs/ops/memory-extraction-eval-dataset.md §6.5 leaves diversity to a person and §7.1 requires it on the
    // record; the near-duplicate report is a pointer, not a gate.
    const record = parseBatchRecord(
        sheet({ a: "채택", b: "채택", decision: "채택" })
    );
    const blockers = promotionBlockers(record);
    assert.ok(blockers.some((line) => line.includes("diversity judgement")));
    assert.ok(blockers.some((line) => line.includes("review date")));
});

test("the committed batch records parse", () => {
    // A record whose tables moved would read as unreviewed, which fails
    // closed -- but silently, and that is worth catching here instead.
    for (const batch of CANDIDATE_BATCHES) {
        const record = parseBatchRecord(
            readFileSync(
                fileURLToPath(new URL(`../${batch.record}`, import.meta.url)),
                "utf8"
            )
        );
        assert.ok(
            record.cases.length > 0,
            `${batch.id}: no verdict table was found in its record`
        );
    }
});
