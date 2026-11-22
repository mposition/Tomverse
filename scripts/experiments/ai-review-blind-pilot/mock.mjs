// Turns the synthetic mock judging fixture into locked records and a locked
// adjudication, so the pipeline can be shown end to end with no person.
//
// Everything it writes carries `mock: true` and a name that says it is not a
// person. The report reads that flag and prints "품질 미측정"; nothing here can
// become a real judgement, a real signature or a product ranking.

import { SCHEMA, SCORED_KINDS, digestOf, lockRecord } from "./core.mjs";

export function buildMockJudging(prepared, mockDoc) {
    if (mockDoc?.schema !== "ai-review-blind-pilot-mock-judging/1" || mockDoc.mock !== true) {
        throw new Error("mock judging fixture must declare schema ai-review-blind-pilot-mock-judging/1 and mock: true");
    }
    const outputOf = new Map(prepared.key.outputs.map((output) => [output.outputId, output]));
    const records = prepared.packets.map((packet) => {
        const record = structuredClone(packet.record);
        record.mock = true;
        for (const output of record.outputs) {
            const meta = outputOf.get(output.outputId);
            const rows = mockDoc.outputs[`${meta.slot}/${meta.caseId}`];
            if (!rows) throw new Error(`mock judging has no rows for ${meta.slot}/${meta.caseId}`);
            // The judge's record never carries the adjudication fields.
            output.rows = rows.map((row) => ({
                segment: row.segment,
                excerpt: row.excerpt ?? null,
                kind: row.kind,
                targets: row.targets,
                statement: row.statement,
                support: row.support ?? null,
                note: "",
            }));
            output.reviewed = true;
        }
        return lockRecord(record, { judge: mockDoc.judge, at: mockDoc.lockedAt });
    });
    const outputs = {};
    for (const output of records[0]?.outputs ?? []) {
        const meta = outputOf.get(output.outputId);
        const rows = mockDoc.outputs[`${meta.slot}/${meta.caseId}`];
        const verdicts = rows.map((row, index) => ({
            row: index,
            kind: row.kind,
            ...(SCORED_KINDS.includes(row.kind) ? { verdict: row.verdict, goldId: row.goldId ?? null, sufficiency: row.sufficiency ?? "sufficient" } : {}),
        }));
        outputs[output.outputId] = {
            caseLabel: meta.caseLabel,
            judges: records.map(() => verdicts),
            ...(records.length > 1 ? { consensus: verdicts.map((v) => ({ judge: 0, ...v })) } : {}),
        };
    }
    const adjudication = {
        schema: SCHEMA.adjudication,
        goldDigest: prepared.key.freeze.goldDigest,
        recordDigests: records.map((record) => digestOf(record)),
        adjudicatedBy: mockDoc.adjudicatedBy,
        adjudicatedAt: mockDoc.adjudicatedAt,
        mock: true,
        status: "locked",
        outputs,
    };
    return { records, adjudication };
}
