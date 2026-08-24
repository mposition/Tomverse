/**
 * Where every candidate batch stands
 * (docs/ops/memory-extraction-eval-dataset.md §6.3, §6.4, §7.1).
 *
 * The dataset needs 1,150 cases across eight cells -- the floors of
 * docs/policy/external-conversation-import-and-memory.md §12.2 as amended on
 * 2026-08-23 -- which came to twenty-eight batches, and each one
 * waited on a different thing: some on drafting, some on a reviewer, some on
 * nothing but the move into the fixtures. Asking that question by opening
 * twenty-eight markdown files is how a batch that was adopted weeks ago sits
 * unpromoted, and how one nobody judged slides past the "명시적 채택 기록"
 * condition in docs/ops/memory-extraction-eval-dataset.md §7.1.
 *
 * Report only. It does not adopt, promote, or edit anything -- adoption is a
 * person's act recorded in the batch record, and a report that edited its own
 * subject would be reporting on itself.
 *
 * Usage:
 *   npm run report:memory-eval-batches
 */

import { readFileSync } from "node:fs";
import { CANDIDATE_BATCHES } from "../lib/memoryExtractionEvalCandidates/index.ts";
import { ADOPTED_BATCHES } from "../lib/memoryExtractionEvalAdopted/index.ts";
import {
    draftDisagreementRate,
    parseBatchRecord,
    promotionBlockers,
} from "../lib/memoryEvalBatchRecord.ts";

const rows = [...ADOPTED_BATCHES, ...CANDIDATE_BATCHES].map((batch) => {
    const record = parseBatchRecord(readFileSync(batch.record, "utf8"));
    const blockers = promotionBlockers(record, batch.cases.length);
    const judged = record.cases.filter((entry) => entry.verdict !== null);
    const adopted = ADOPTED_BATCHES.some((entry) => entry.id === batch.id);
    return { batch, record, blockers, judged, adopted };
});

const state = ({ record, blockers, judged, adopted }) => {
    if (adopted) return "in the dataset";
    if (blockers.length === 0) return "promotable";
    if (judged.length === 0) return "awaiting review";
    if (record.decision === "반려") return "rejected";
    return "awaiting decision";
};

console.log(
    `${rows.length} batch(es): ${ADOPTED_BATCHES.length} adopted, ` +
        `${CANDIDATE_BATCHES.length} awaiting\n`
);
for (const row of rows) {
    const { batch, record, blockers, judged } = row;
    const rate = draftDisagreementRate(record);
    console.log(`${batch.id}  ${batch.cell}  [${state(row)}]`);
    console.log(`  cases          ${batch.cases.length}`);
    console.log(
        `  sampled judged ${judged.length}/${record.cases.length}` +
            (rate === null
                ? ""
                : `  (draft disagreement ${Math.round(rate * 100)}%)`)
    );
    console.log(`  batch decision ${record.decision ?? "—"}`);
    console.log(`  record         ${batch.record}`);
    if (!row.adopted)
        for (const blocker of blockers) console.log(`  blocked on     ${blocker}`);
    console.log();
}

// docs/ops/memory-extraction-eval-dataset.md §6.5: a cell's first batch is reviewed before the rest is drafted, so
// this is the number that says whether drafting may continue.
const promotable = rows.filter(
    (row) => !row.adopted && row.blockers.length === 0
).length;
console.log(
    `${promotable} promotable, ` +
        `${rows.filter((row) => !row.adopted).length - promotable} waiting. ` +
        "Nothing here moves a case into the dataset -- that is a separate, " +
        "reviewed change."
);

// What the reviewer is actually being asked for, as one number.
//
// The per-batch lines above each say "0/10", and reading sixteen of them to
// learn the total is work the report should have done. The reason it matters
// is that this number is the whole cost of the review: everything else here --
// drafting, sampling, the automated checks -- is already spent.
const outstanding = rows
    .filter((row) => !row.adopted)
    .map((row) => ({
        row,
        owed: row.record.cases.filter((entry) => entry.verdict === null).length,
    }))
    .filter((entry) => entry.owed > 0);
const owedTotal = outstanding.reduce((sum, entry) => sum + entry.owed, 0);

if (owedTotal > 0) {
    const next = outstanding[0];
    console.log(
        `\n${owedTotal} verdict(s) outstanding across ${outstanding.length} batch(es). ` +
            `Start here:\n  ${next.row.batch.record}  (${next.owed} to judge)`
    );
} else if (rows.some((row) => !row.adopted)) {
    // Verdicts are in and something still blocks: an unfilled adoption line, a
    // blank diversity call, a rejection. The blockers above name which.
    console.log(
        "\nEvery sampled case carries a verdict. What is left is on the batch " +
            "lines above."
    );
}
