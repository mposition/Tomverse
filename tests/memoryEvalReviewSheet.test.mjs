import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CANDIDATE_BATCHES } from "../lib/memoryExtractionEvalCandidates/index.ts";
import { ADOPTED_BATCHES } from "../lib/memoryExtractionEvalAdopted/index.ts";
import { parseBatchRecord } from "../lib/memoryEvalBatchRecord.ts";

/**
 * Adopted batches stay in scope here. The record-matches-generator check is
 * what keeps a record from drifting away from the cases it judged, and a
 * batch needs that most once it is dataset and the verdicts are load-bearing.
 */
const ALL_BATCHES = [...CANDIDATE_BATCHES, ...ADOPTED_BATCHES];

/**
 * The review sheet exists so a one-person organisation reviews what
 * docs/ops/memory-extraction-eval-dataset.md §6.3 actually requires, with
 * everything else already done for them.
 *
 * The first record was hand-written and failed at exactly that: it asked for
 * a verdict on all 25 cases when docs/ops/memory-extraction-eval-dataset.md §6.3 samples category ① at 20%, and it
 * carried a 42-character excerpt so judging a case meant opening the
 * TypeScript file. Both are pinned here, because both are the kind of
 * regression that looks like diligence.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const sheet = (batchId) =>
    execFileSync(
        "node",
        [
            "--import",
            "tsx",
            "scripts/make-memory-eval-review-sheet.mjs",
            `--batch=${batchId}`,
        ],
        { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
    );

test("a category ① batch asks for 20% of its cases, not all of them", () => {
    const batch = ALL_BATCHES.find((entry) =>
        entry.cases.every((testCase) => testCase.category === "durable_facts")
    );
    assert.ok(batch, "expected a durable_facts batch to exist");
    const expected = Math.ceil(batch.cases.length * 0.2);
    const rendered = sheet(batch.id);
    assert.match(
        rendered,
        new RegExp(`케이스 ${expected}건 판정`),
        `the sheet must ask for ${expected} verdicts, not ${batch.cases.length}`
    );
    // The verdict tables are the work. One per sampled case, plus none
    // anywhere else.
    const verdictTables = rendered.match(/\| 판정 \| 사유/g) ?? [];
    assert.equal(verdictTables.length, expected);
});

test("every sampled case is reproduced in full, so no other file is needed", () => {
    const batch = ALL_BATCHES[0];
    const rendered = sheet(batch.id);
    // Each case whose verdict is asked for must have all of its turns in the
    // sheet -- an excerpt sends the reviewer to the source file.
    const sampled = batch.cases.filter((testCase) =>
        rendered.includes(`### ${testCase.id}\n`)
    );
    assert.ok(sampled.length > 0, "no sampled case found in the sheet");
    for (const testCase of sampled) {
        for (const conversation of testCase.conversations) {
            for (const message of conversation.messages) {
                assert.ok(
                    rendered.includes(message.content),
                    `${testCase.id}: a turn is missing from the sheet`
                );
            }
        }
        assert.ok(
            rendered.includes(testCase.expected[0].kind),
            `${testCase.id}: the proposed gold label is missing`
        );
    }
});

test("the sample spreads across kinds rather than repeating one", () => {
    // A sample of five that lands on three `preference` cases measures
    // `preference` and reports it as the batch.
    const batch = ALL_BATCHES[0];
    const rendered = sheet(batch.id);
    const sampled = batch.cases.filter((testCase) =>
        rendered.includes(`### ${testCase.id}\n`)
    );
    const kinds = new Set(sampled.map((testCase) => testCase.expected[0]?.kind));
    assert.equal(
        kinds.size,
        sampled.length,
        `sample repeated a kind: ${[...kinds].join(", ")}`
    );
});

test("the sheet states the automated checks rather than a command to run", () => {
    const rendered = sheet(ALL_BATCHES[0].id);
    // docs/ops/memory-extraction-eval-dataset.md §6.5's near-duplicate figures belong in the sheet. Telling the reviewer
    // to run a script is handing them the work the rule assigns to the agent.
    assert.match(rendered, /exact duplicate/);
    assert.match(rendered, /kind 분포/);
    assert.match(rendered, /near-duplicate 상위 쌍/);
    assert.match(rendered, /\| \d\.\d{2} \| \d\.\d{2} \|/, "expected scored pairs");
});

test("the committed record matches what the generator produces", () => {
    // Otherwise the sheet drifts from its source and the next regeneration
    // silently discards someone's edit.
    for (const batch of ALL_BATCHES) {
        const onDisk = readFileSync(
            fileURLToPath(new URL(`../${batch.record}`, import.meta.url)),
            "utf8"
        );
        // Verdict cells are the reviewer's; compare everything up to the
        // first case heading, which is the last line the generator owns
        // outright. Slicing on a section title would break the day a title
        // changes for one category.
        const upTo = (value) => value.slice(0, value.indexOf("\n### "));
        assert.equal(
            upTo(onDisk),
            upTo(sheet(batch.id)),
            `${batch.record} is stale -- regenerate it`
        );
    }
});

test("--write refuses to overwrite a sheet that already carries a verdict", () => {
    // The sheet tells the reviewer their verdicts are the one thing they may
    // hand-edit, and regeneration would delete exactly those cells. Losing a
    // verdict means asking the reviewer to judge again, which is the single
    // cost the generated sheet exists to remove.
    const reviewed = ALL_BATCHES.filter((batch) => {
        const record = parseBatchRecord(
            readFileSync(
                fileURLToPath(new URL(`../${batch.record}`, import.meta.url)),
                "utf8"
            )
        );
        return record.cases.some((entry) => entry.verdict !== null);
    });
    assert.ok(reviewed.length > 0, "expected at least one reviewed record");
    for (const batch of reviewed) {
        assert.throws(
            () =>
                execFileSync(
                    "node",
                    [
                        "--import",
                        "tsx",
                        "scripts/make-memory-eval-review-sheet.mjs",
                        `--batch=${batch.id}`,
                        "--write",
                    ],
                    { cwd: root, encoding: "utf8", stdio: "pipe" }
                ),
            `${batch.id}: --write overwrote a reviewed record`
        );
    }
});
