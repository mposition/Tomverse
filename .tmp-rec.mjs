import { readFileSync } from "node:fs";
import { parseBatchRecord, promotionBlockers, draftDisagreementRate } from "./lib/memoryEvalBatchRecord.ts";
import { CANDIDATE_BATCHES } from "./lib/memoryExtractionEvalCandidates/index.ts";
for (const batch of CANDIDATE_BATCHES) {
    const record = parseBatchRecord(readFileSync(batch.record, "utf8"));
    const blockers = promotionBlockers(record, batch.cases.length);
    console.log(`${batch.id}: decision=${record.decision} judged=${record.cases.filter(c=>c.verdict).length}/${record.cases.length} disagreement=${draftDisagreementRate(record)} blockers=${blockers.length ? blockers.join("; ") : "none"}`);
}
