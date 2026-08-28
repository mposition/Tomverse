/**
 * The readiness list, held against the tree it describes.
 *
 * A hand-written list is the right shape here — "does this file read a
 * schema-3 artifact correctly" is not a question an import scan can answer —
 * and a hand-written list is also the shape that goes stale silently. So each
 * row's evidence has to name a file that exists, and the gate's own state has
 * to match what the list claims about it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    MEMORY_EVAL_SCHEMA3_CONSUMERS,
    memoryEvalSchema3Blockers,
    memoryEvalSchema3Readiness,
} from "../lib/memoryEvalSchemaReadiness.ts";
import { MEMORY_EVAL_DATASET_SCHEMA_VERSION } from "../lib/memoryExtractionEvalCore.ts";
import { harnessTarget } from "../lib/memoryEvalHarnessTarget.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("every consumer named is a file in this tree", () => {
    for (const row of MEMORY_EVAL_SCHEMA3_CONSUMERS) {
        assert.ok(
            existsSync(new URL(row.consumer, `file://${REPO_ROOT}`)),
            `${row.consumer} does not exist`
        );
    }
});

test("every row cites evidence, and a converted row cites a test that exists", () => {
    for (const row of MEMORY_EVAL_SCHEMA3_CONSUMERS) {
        assert.ok(row.evidence.length > 20, `${row.consumer} cites nothing`);
        // A row claiming conversion has to point at something that would fail
        // if the conversion were undone. "Looks fine" is how this list goes
        // stale without anyone noticing.
        const cited = row.evidence.match(/tests\/[A-Za-z0-9_.-]+\.mjs/g) ?? [];
        if (row.state === "converted") {
            assert.ok(cited.length > 0, `${row.consumer} names no test`);
            for (const path of cited) {
                assert.ok(
                    existsSync(new URL(path, `file://${REPO_ROOT}`)),
                    `${row.consumer} cites ${path}, which does not exist`
                );
            }
        }
    }
});

test("no consumer is pending, and the gate has been moved to match", () => {
    // Two facts, and keeping them apart is the point of the module. The gate
    // moved on 2026-08-28 on this report's evidence; the instrument being
    // ready still is not permission to run it, because a paid run needs the
    // budget approval of
    // docs/policy/external-conversation-import-and-memory.md §12.5 as well.
    const summary = memoryEvalSchema3Readiness();
    assert.deepEqual([...memoryEvalSchema3Blockers()], []);
    assert.equal(summary.gateMayMove, true);

    assert.equal(MEMORY_EVAL_DATASET_SCHEMA_VERSION, 3);
    assert.equal(harnessTarget().datasetSchemaVersion, 3);
});

test("a pending row blocks, and gateMayMove says so", () => {
    const rows = [
        ...MEMORY_EVAL_SCHEMA3_CONSUMERS,
        {
            consumer: "scripts/imaginary.mjs",
            state: "pending",
            role: "r",
            evidence: "not written yet",
        },
    ];
    assert.equal(memoryEvalSchema3Blockers(rows).length, 1);
    assert.equal(memoryEvalSchema3Readiness(rows).gateMayMove, false);
});
