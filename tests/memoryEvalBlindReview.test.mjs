/**
 * The blind review sheet stays blind, and refuses material it cannot be about.
 *
 * docs/policy/external-conversation-import-and-memory.md §12.4 asks a person
 * to read the model's answers before the pair is approved. A sheet that
 * printed the harness's own verdict beside each answer would be collecting
 * agreement rather than a review, so the omission is the feature and is
 * pinned here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { MEMORY_EVAL_CASES } from "../lib/memoryExtractionEvalFixtures.ts";
import {
    datasetFingerprintInput,
    scoreCase,
} from "../lib/memoryExtractionEvalCore.ts";

const ROOT = new URL("..", import.meta.url);
const digest = createHash("sha256")
    .update(datasetFingerprintInput(MEMORY_EVAL_CASES), "utf8")
    .digest("hex");

/** An artifact shaped like a live run, so the sheet has something to render. */
const artifact = (overrides = {}) => {
    const records = MEMORY_EVAL_CASES.map((testCase) => {
        // One adopted candidate per durable case and none elsewhere: enough
        // for the sheet to have both shapes on it.
        const candidates =
            testCase.expected.length > 0
                ? [
                      {
                          kind: testCase.expected[0].kind,
                          statement: `The user's record: ${testCase.expected[0].mustInclude.join(" ")}.`,
                          bulkSafe: true,
                          disposition: "accepted",
                      },
                  ]
                : [];
        return {
            caseId: testCase.id,
            category: testCase.category,
            language: testCase.language,
            failure: null,
            candidates,
            outcome: scoreCase(testCase, candidates, null),
        };
    });
    return {
        manifest: {
            modelId: "gpt-5-6-luna",
            promptVersion: "mem-extract-v1",
            datasetVersion: "mem-eval-seed-11",
            datasetDigest: digest,
            mode: "live",
            commitSha: "0".repeat(40),
            workingTreeDirty: false,
            generatedAt: "2026-08-24T00:00:00.000Z",
            caseCount: records.length,
            ...overrides,
        },
        verdict: {},
        records,
    };
};

const run = (json, args = []) => {
    const dir = mkdtempSync(join(tmpdir(), "blind-review-"));
    const path = join(dir, "artifact.json");
    writeFileSync(path, JSON.stringify(json), "utf8");
    const result = spawnSync(
        process.execPath,
        [
            "--import",
            "tsx",
            "scripts/make-memory-eval-blind-review.mjs",
            `--artifact=${path}`,
            ...args,
        ],
        { cwd: ROOT, encoding: "utf8" }
    );
    return result;
};

test("a smoke artifact is refused", () => {
    const result = run(artifact({ mode: "smoke" }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /smoke run/);
});

test("an artifact from a different sample is refused", () => {
    const result = run(artifact({ datasetDigest: "deadbeef" }));
    assert.equal(result.status, 1);
    // Naming both digests is the point: the reader has to be able to tell
    // which side is stale without opening either.
    assert.match(result.stderr, /deadbeef/);
    assert.match(result.stderr, new RegExp(digest));
});

test("the sheet shows the answer and hides the score", () => {
    const result = run(artifact(), ["--per-cell=2"]);
    assert.equal(result.status, 0, result.stderr);
    const sheet = result.stdout;

    // Shown: what the model produced, and the decision §12.3's critical
    // categories turn on.
    assert.match(sheet, /bulk-safe/);
    assert.match(sheet, /판정 \(적절 \/ 부적절\)/);

    // Hidden: every field of the harness's per-case outcome. A reviewer who
    // can see `matchedExpected` has been told the answer.
    for (const field of [
        "matchedExpected",
        "expectedTotal",
        "falsePositives",
        "bulkSafeTotal",
        "criticalFalseAcceptances",
    ]) {
        assert.ok(
            !sheet.includes(field),
            `the sheet must not carry the harness verdict field ${field}`
        );
    }
});

test("the same artifact always yields the same sample", () => {
    const json = artifact();
    // The header names the file it was made from, and each call writes to a
    // fresh temp path, so that one line is expected to differ. Everything
    // else must not: a sheet that redrew would let a second attempt fish for
    // a friendlier sample after an uncomfortable first read.
    const sample = (json) =>
        run(json, ["--per-cell=3"])
            .stdout.split("\n")
            .filter((line) => !line.startsWith("| artifact |"))
            .filter((line) => !line.startsWith("> **자동 생성 파일입니다.**"))
            .join("\n");
    assert.equal(sample(json), sample(json));
});

test("every cell is represented, and not in blocks", () => {
    const result = run(artifact(), ["--per-cell=3"]);
    const ids = [...result.stdout.matchAll(/^## \d+\. `([^`]+)`/gm)].map((m) => m[1]);
    const byId = new Map(MEMORY_EVAL_CASES.map((entry) => [entry.id, entry]));
    const cells = ids.map((id) => `${byId.get(id).category}:${byId.get(id).language}`);
    assert.equal(new Set(cells).size, 8, "all eight cells should appear");
    assert.equal(ids.length, 24);
    // Categories 2-4 all pass by extracting nothing, so a run of them in a row
    // teaches the expected answer before the sheet asks for it.
    const runs = cells.filter((cell, index) => cell !== cells[index - 1]).length;
    assert.ok(runs > 8, `sample looks grouped by cell (${runs} transitions)`);
});
