/**
 * The corpus that authored the rules stays out of the set that measures them.
 *
 * "The set that measures them" is `mem-eval-succ-3` from 2026-08-27.
 * `mem-eval-succ-2` still holds all 99 and is meant to: it was not edited, it
 * is what run1 was scored against, and its manifest still recomputes. The
 * separation is about the set the *next* verdict comes from.
 *
 * Five invariants, and none of them is a style preference. Each is a way the
 * separation has failed or could fail silently: a case in both sets, a digest
 * that quietly covers the corpus, a loader that imports it, a move with no
 * record of why, and a move that drops a cell below its §12.2 floor.
 *
 * `.github/audits/memory-eval-kind-boundary-amendment-2026-08-27.md` and its
 * correction record which 99 cases move and why.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    MEMORY_EVAL_REGRESSION_CASES,
    MEMORY_EVAL_REGRESSION_PROVENANCE,
} from "../lib/memoryEvalRegressionCorpus/index.ts";
import { MEMORY_EVAL_SUCC3_CASES } from "../lib/memoryEvalSucc3Fixtures.ts";
import {
    assessSampleAdequacy,
    datasetFingerprintInput,
} from "../lib/memoryExtractionEvalCore.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS_DIR = "memoryEvalRegressionCorpus";
const DECISION_LOADER = "lib/memoryEvalSucc3Fixtures.ts";

const decisionIds = new Set(MEMORY_EVAL_SUCC3_CASES.map((c) => c.id));
const regressionIds = new Set(MEMORY_EVAL_REGRESSION_CASES.map((c) => c.id));

test("1. no case is in both sets", () => {
    const both = [...regressionIds].filter((id) => decisionIds.has(id));
    assert.deepEqual(
        both,
        [],
        "a case in both sets measures the rule it wrote"
    );
});

test("2. the decision digest is computed without the corpus", () => {
    // Not "the digest happens to be unchanged" — that is true of any array
    // nobody passed in. This asserts the fingerprint input names only
    // decision cases, so a corpus entry cannot reach it even by accident.
    const digest = (cases) =>
        createHash("sha256")
            .update(datasetFingerprintInput(cases), "utf8")
            .digest("hex");
    const before = digest(MEMORY_EVAL_SUCC3_CASES);
    const withCorpus = digest([
        ...MEMORY_EVAL_SUCC3_CASES,
        ...MEMORY_EVAL_REGRESSION_CASES,
    ]);
    // The stand-in this used to need is gone: the corpus holds 99 cases now,
    // so adding it is a real change to the input rather than an empty spread.
    assert.equal(MEMORY_EVAL_REGRESSION_CASES.length, 99);
    assert.notEqual(
        before,
        withCorpus,
        "the fingerprint must react to what is in the array it is given"
    );
    assert.equal(
        digest(MEMORY_EVAL_SUCC3_CASES),
        before,
        "and the decision digest is computed from the decision cases alone"
    );
});

/** Follows relative and `@/lib` imports from one file, breadth first. */
const importGraph = (entry) => {
    const seen = new Set();
    const queue = [resolve(REPO_ROOT, entry)];
    while (queue.length > 0) {
        const file = queue.shift();
        if (seen.has(file)) continue;
        seen.add(file);
        if (!existsSync(file)) continue;
        const source = readFileSync(file, "utf8");
        for (const [, spec] of source.matchAll(
            /(?:from|import)\s+"([^"]+)"/g
        )) {
            let target = null;
            if (spec.startsWith("@/")) target = resolve(REPO_ROOT, spec.slice(2));
            else if (spec.startsWith(".")) target = resolve(dirname(file), spec);
            if (target === null) continue;
            for (const candidate of [
                `${target}.ts`,
                `${target}/index.ts`,
                target,
            ]) {
                if (!existsSync(candidate)) continue;
                if (!statSync(candidate).isFile()) continue;
                queue.push(candidate);
                break;
            }
        }
    }
    return seen;
};

test("3. the decision loader's import graph excludes the corpus", () => {
    const graph = importGraph(DECISION_LOADER);
    // The scan has to be able to see something, or an empty graph would pass.
    assert.ok(graph.size > 1, "the import scan reached nothing");
    const reached = [...graph].filter((file) => file.includes(CORPUS_DIR));
    assert.deepEqual(
        reached,
        [],
        `${DECISION_LOADER} reaches the regression corpus, so the corpus is back in the decision set`
    );
});

test("4. every planned move carries complete provenance", () => {
    const RULES = new Set([
        "rule-1",
        "rule-2",
        "rule-3",
        "rule-4",
        "rule-5",
        "v4-kind-guide",
    ]);
    assert.equal(
        MEMORY_EVAL_REGRESSION_PROVENANCE.length,
        99,
        "the amendment's correction fixes the move set at 99"
    );
    const seen = new Set();
    for (const entry of MEMORY_EVAL_REGRESSION_PROVENANCE) {
        const at = `provenance for ${entry.originalId}`;
        assert.ok(!seen.has(entry.originalId), `${at} is duplicated`);
        seen.add(entry.originalId);
        assert.ok(entry.ruleIds.length > 0, `${at} names no rule`);
        for (const rule of entry.ruleIds)
            assert.ok(RULES.has(rule), `${at} names unknown rule ${rule}`);
        assert.ok(entry.auditRefs.length > 0, `${at} names no audit section`);
        assert.ok(entry.reason.length > 0, `${at} has no reason`);

        // The invariant that makes a half-migration impossible: an original
        // is in exactly one set, and it has a replacement exactly when it has
        // left the decision set.
        const inDecision = decisionIds.has(entry.originalId);
        const inCorpus = regressionIds.has(entry.originalId);
        assert.ok(
            inDecision !== inCorpus,
            `${at}: the case is in ${inDecision ? "both" : "neither"} set`
        );
        assert.equal(
            entry.replacementId !== null,
            inCorpus,
            `${at}: a moved case needs a replacement, and a case still in the decision set must not claim one`
        );
        if (entry.replacementId !== null) {
            assert.ok(
                decisionIds.has(entry.replacementId),
                `${at}: replacement ${entry.replacementId} is not in the decision set`
            );
        }
    }
});

test("5. every cell still meets its floor", () => {
    // Through `assessSampleAdequacy`, the function the harness judges with,
    // rather than a second copy of the floors here. The floors differ by
    // category — durable_facts 200, the three critical categories 125 — and a
    // restatement would be one edit away from this test and the harness
    // disagreeing about what §12.2 requires.
    const adequacy = assessSampleAdequacy(
        MEMORY_EVAL_SUCC3_CASES.map((testCase) => ({
            caseId: testCase.id,
            category: testCase.category,
            language: testCase.language,
        }))
    );
    assert.deepEqual(
        adequacy.underpowered,
        [],
        "moving a case out without writing its replacement drops the cell below its floor"
    );
    assert.ok(adequacy.decisionGrade);
});
