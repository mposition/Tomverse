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
| 초안 구성이 직전 batch와 같은가 (\`docs/ops/memory-extraction-eval-dataset.md\` §6.3) | ${body.draftSetup ?? "같음"} |
`;

/** The same sheet with no docs/ops/memory-extraction-eval-dataset.md §6.3 row at all -- the shape records predating the
 * 2026-08-23 amendment have. */
const sheetWithoutSetupRow = (body) =>
    sheet(body)
        .split("\n")
        .filter((line) => !line.includes("초안 구성이 직전 batch와 같은가"))
        .join("\n");

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

test("a sampled batch may not be promoted until the docs/ops/memory-extraction-eval-dataset.md §6.3 setup row is answered", () => {
    // The amendment of 2026-08-23 let categories ②③④ be judged on 20% as well,
    // and the thing holding that up is this row: the first batch drafted with
    // a changed tool, model or version goes back to full review. A blank row
    // is not a yes -- only the reviewer knows whether the setup moved.
    const blank = parseBatchRecord(
        sheet({
            a: "채택",
            b: "채택",
            decision: "채택",
            diversity: "충분",
            reviewedOn: "2026-08-23",
            draftSetup: "",
        })
    );
    assert.equal(blank.draftSetupSameAsPrevious, "");
    assert.ok(
        promotionBlockers(blank, 10).some((line) =>
            line.includes("drafting-setup row is blank")
        )
    );

    const unchanged = parseBatchRecord(
        sheet({
            a: "채택",
            b: "채택",
            decision: "채택",
            diversity: "충분",
            reviewedOn: "2026-08-23",
            draftSetup: "같음",
        })
    );
    assert.deepEqual(promotionBlockers(unchanged, 10), []);
});

test("a changed drafting setup sends a sampled batch back to full review", () => {
    const changed = parseBatchRecord(
        sheet({
            a: "채택",
            b: "채택",
            decision: "채택",
            diversity: "충분",
            reviewedOn: "2026-08-23",
            draftSetup: "다름",
        })
    );
    // Two verdicts against a ten-case batch is a sample, and docs/ops/memory-extraction-eval-dataset.md §6.3 does not let
    // a sample stand once the setup it was gathered under has changed.
    assert.ok(
        promotionBlockers(changed, 10).some((line) =>
            line.includes("reviewed in full")
        )
    );
    // The same answer on a batch whose every case was judged is fine: there is
    // no unreviewed remainder for the sample to stand in for.
    assert.deepEqual(promotionBlockers(changed, 2), []);
});

test("a record written before the row existed is not retroactively blocked", () => {
    // docs/ops/memory-extraction-eval-dataset.md §6.3's row arrived on 2026-08-23. Records adopted before it were
    // reviewed under the rule that stood then, and reading their silence as a
    // refusal would un-license a review a person actually finished. An absent
    // row and a blank one are different facts.
    const old = parseBatchRecord(
        sheetWithoutSetupRow({
            a: "채택",
            b: "채택",
            decision: "채택",
            diversity: "충분",
            reviewedOn: "2026-08-20",
        })
    );
    assert.equal(old.draftSetupSameAsPrevious, null);
    assert.deepEqual(promotionBlockers(old, 10), []);
});

test("every candidate record carries the docs/ops/memory-extraction-eval-dataset.md §6.3 row", () => {
    // `null` means "this record predates the row", and that reading is only
    // safe while no current record can lose it. Deleting the row by hand from
    // a generated sheet would otherwise be a way to skip the safeguard.
    for (const batch of CANDIDATE_BATCHES) {
        const markdown = readFileSync(
            fileURLToPath(new URL(`../${batch.record}`, import.meta.url)),
            "utf8"
        );
        assert.notEqual(
            parseBatchRecord(markdown).draftSetupSameAsPrevious,
            null,
            `${batch.record} has no docs/ops/memory-extraction-eval-dataset.md §6.3 drafting-setup row`
        );
    }
});

test("the batch report's outstanding count is the sum of its own batches", () => {
    // The number a reviewer is actually being asked for. Sixteen lines each
    // saying "0/10" do not add themselves up, and the total is the whole cost
    // of the review -- everything else is already spent.
    //
    // Derived here rather than copied, so it cannot be quoted from memory and
    // be wrong: batches at the bottom of the 25-50 range sample five, not ten,
    // and a total that assumes ten everywhere overstates the ask.
    const owed = CANDIDATE_BATCHES.map((batch) => {
        const record = parseBatchRecord(
            readFileSync(
                fileURLToPath(new URL(`../${batch.record}`, import.meta.url)),
                "utf8"
            )
        );
        return record.cases.filter((entry) => entry.verdict === null).length;
    });
    for (const [index, count] of owed.entries()) {
        const batch = CANDIDATE_BATCHES[index];
        assert.equal(
            count,
            Math.max(1, Math.ceil(batch.cases.length * 0.2)),
            `${batch.id} offers ${count} verdicts for ${batch.cases.length} cases`
        );
    }
});
