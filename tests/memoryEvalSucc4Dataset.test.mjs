// The canonical succ-4 set, its floors, and the boundary that keeps the
// superseded cases out of it.
//
// The isolation test is the one that matters most here. Everything else could
// be got wrong and produce a wrong number; a path from the decision set to the
// regression corpus produces a *right-looking* number computed over cases the
// contract has already replaced.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import {
    MEMORY_EVAL_SUCC4_CASES,
    MEMORY_EVAL_SUCC4_RELABELLED_CASES,
    MEMORY_EVAL_SUCC4_REPLACEMENT_CASES,
    MEMORY_EVAL_SUCC4_DATASET_VERSION,
    MEMORY_EVAL_SUCC4_SUPERSEDES,
    succ4CellCounts,
} from "../lib/memoryEvalSucc4Dataset.ts";
import {
    SUCC4_TRANSITIONS,
    SUCC4_SUPERSEDED_CASE_IDS,
    SUCC4_REPLACEMENT_CASE_IDS,
} from "../lib/memoryEvalSucc4Transition.ts";
import {
    SUCC4_REGRESSION_CORPUS,
    SUCC4_PRIOR_SUPERSESSIONS,
    succ4RegressionEntryFor,
} from "../lib/memoryEvalSucc4Regression.ts";
import {
    MEMORY_EVAL_SUCC3_CASES,
    MEMORY_EVAL_SUCC3_DATASET_VERSION,
} from "../lib/memoryEvalSucc3Fixtures.ts";
import { SUCC4_READINGS } from "../lib/memoryEvalSucc4Review/readings.ts";

const ids = new Set(MEMORY_EVAL_SUCC4_CASES.map((c) => c.id));

test("the set is the relabellings plus the replacements and nothing else", () => {
    assert.equal(MEMORY_EVAL_SUCC4_RELABELLED_CASES.length, 1047);
    assert.equal(MEMORY_EVAL_SUCC4_REPLACEMENT_CASES.length, 103);
    assert.equal(MEMORY_EVAL_SUCC4_CASES.length, 1150);
    assert.equal(ids.size, 1150);
    assert.equal(MEMORY_EVAL_SUCC4_DATASET_VERSION, "mem-eval-succ-4");
    assert.equal(MEMORY_EVAL_SUCC4_SUPERSEDES, MEMORY_EVAL_SUCC3_DATASET_VERSION);
});

test("no superseded original survives into the decision set", () => {
    for (const originalId of SUCC4_SUPERSEDED_CASE_IDS) {
        assert.ok(!ids.has(originalId), `${originalId} is still in succ-4`);
    }
});

test("every replacement is in the decision set", () => {
    for (const replacementId of SUCC4_REPLACEMENT_CASE_IDS) {
        assert.ok(ids.has(replacementId), `${replacementId} is missing from succ-4`);
    }
});

test("every exclusion answers to exactly one transition", () => {
    const succ3Ids = new Set(MEMORY_EVAL_SUCC3_CASES.map((c) => c.id));
    const excluded = [...succ3Ids].filter((id) => !ids.has(id));
    assert.equal(excluded.length, 103);
    const byOriginal = new Map();
    for (const transition of SUCC4_TRANSITIONS) {
        assert.ok(
            !byOriginal.has(transition.originalId),
            `${transition.originalId} has two transitions`
        );
        byOriginal.set(transition.originalId, transition);
    }
    for (const id of excluded) {
        assert.ok(byOriginal.has(id), `${id} was dropped with no transition`);
    }
});

test("no case carries a superseded marker; absence is the only record", () => {
    for (const testCase of MEMORY_EVAL_SUCC4_CASES) {
        for (const key of Object.keys(testCase)) {
            assert.ok(
                !/supersed|retired|deprecated|regression/i.test(key),
                `${testCase.id} carries a ${key} field; exclusion is structural, not a flag`
            );
        }
    }
});

test("the eight cell floors hold", () => {
    // .github/audits/memory-eval-gold-contract-2026-08-27.md §12.10, the
    // "목표" column. A 1:1 replacement cannot move these, which is the point
    // of checking them: if one moves, the replacement was not 1:1.
    assert.deepEqual(succ4CellCounts(), {
        "assistant_only:en": 125,
        "assistant_only:ko": 125,
        "durable_facts:en": 200,
        "durable_facts:ko": 200,
        "injection_directives:en": 125,
        "injection_directives:ko": 125,
        "sensitive_secrets:en": 125,
        "sensitive_secrets:ko": 125,
    });
});

test("succ-3 is untouched by any of this", () => {
    assert.equal(MEMORY_EVAL_SUCC3_CASES.length, 1150);
    assert.equal(MEMORY_EVAL_SUCC3_DATASET_VERSION, "mem-eval-succ-3");
});

/* ------------------------------------------------------- regression corpus */

test("the regression corpus matches the transition manifest exactly", () => {
    assert.equal(SUCC4_REGRESSION_CORPUS.length, SUCC4_TRANSITIONS.length);
    assert.deepEqual(
        SUCC4_REGRESSION_CORPUS.map((e) => e.supersededCase.id).sort(),
        SUCC4_TRANSITIONS.map((t) => t.originalId).sort()
    );
    for (const transition of SUCC4_TRANSITIONS) {
        const entry = succ4RegressionEntryFor(transition.originalId);
        assert.ok(entry, `${transition.originalId} has no regression entry`);
        assert.equal(entry.provenance.supersededBy, transition.replacementId);
        assert.deepEqual(entry.provenance.grounds, transition.grounds);
        assert.equal(entry.provenance.foundAt, transition.from);
        assert.equal(entry.provenance.auditRef, transition.auditRef);
    }
});

test("a corrected gold is preserved with its correction, not without it", () => {
    const correctedCases = new Set(SUCC4_READINGS.map((r) => r.caseId));
    for (const entry of SUCC4_REGRESSION_CORPUS) {
        const expected = SUCC4_READINGS.filter(
            (r) => r.caseId === entry.supersededCase.id
        );
        assert.deepEqual(entry.corrections, expected);
        if (correctedCases.has(entry.supersededCase.id)) {
            assert.ok(
                entry.corrections.length > 0,
                `${entry.supersededCase.id} was corrected and the record does not say so`
            );
            assert.ok(
                entry.provenance.grounds.includes("section-12.2-gold-change"),
                `${entry.supersededCase.id} was corrected and does not cite ` +
                    `the gold-change ground of .github/audits/memory-eval-gold-contract-2026-08-27.md §12.2`
            );
        }
    }
});

test("the case content is the succ-3 case, unaltered", () => {
    const succ3 = new Map(MEMORY_EVAL_SUCC3_CASES.map((c) => [c.id, c]));
    for (const entry of SUCC4_REGRESSION_CORPUS) {
        assert.equal(
            entry.supersededCase,
            succ3.get(entry.supersededCase.id),
            `${entry.supersededCase.id} is not the succ-3 case itself`
        );
    }
});

test("the one prior supersession composes into a three-step chain", () => {
    assert.equal(SUCC4_PRIOR_SUPERSESSIONS.length, 1);
    const [prior] = SUCC4_PRIOR_SUPERSESSIONS;
    assert.equal(prior.superseded, "succ-durable-en-57");
    assert.equal(prior.supersededBy, "succ-durable-en-316");

    const entry = succ4RegressionEntryFor("succ-durable-en-316");
    assert.deepEqual(entry.provenance.chain.slice(0, 2), [
        "succ-durable-en-57",
        "succ-durable-en-316",
    ]);
    assert.equal(entry.provenance.chain.length, 3);

    for (const other of SUCC4_REGRESSION_CORPUS) {
        if (other.supersededCase.id === "succ-durable-en-316") continue;
        assert.equal(
            other.provenance.chain.length,
            2,
            `${other.supersededCase.id} claims a prior supersession nothing records`
        );
    }
});

/* -------------------------------------------------------------- isolation */

const REPO = path.resolve(import.meta.dirname, "..");

/** The `@/lib/...` and relative imports one source file names. */
const importsOf = (file) => {
    const source = readFileSync(file, "utf8");
    const found = new Set();
    for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
        const specifier = match[1];
        let resolved = null;
        if (specifier.startsWith("@/")) {
            resolved = path.join(REPO, specifier.slice(2));
        } else if (specifier.startsWith(".")) {
            resolved = path.resolve(path.dirname(file), specifier);
        }
        if (!resolved) continue;
        for (const candidate of [
            resolved,
            `${resolved}.ts`,
            `${resolved}.tsx`,
            path.join(resolved, "index.ts"),
        ]) {
            if (existsSync(candidate) && candidate.endsWith(".ts")) {
                found.add(candidate);
                break;
            }
        }
    }
    return [...found];
};

const reachableFrom = (entry) => {
    const seen = new Set();
    const queue = [entry];
    while (queue.length > 0) {
        const file = queue.pop();
        if (seen.has(file)) continue;
        seen.add(file);
        for (const next of importsOf(file)) queue.push(next);
    }
    return seen;
};

const DATASET = path.join(REPO, "lib/memoryEvalSucc4Dataset.ts");
const REGRESSION = path.join(REPO, "lib/memoryEvalSucc4Regression.ts");

test("the decision set cannot reach the regression corpus", () => {
    const reachable = reachableFrom(DATASET);
    assert.ok(
        reachable.has(DATASET),
        "the import walk found nothing, so it proves nothing"
    );
    assert.ok(
        reachable.size > 5,
        `the import walk only reached ${reachable.size} files, so it proves nothing`
    );
    assert.ok(
        !reachable.has(REGRESSION),
        "succ-4's decision set imports the regression corpus"
    );
});

test("the regression corpus does not reach the decision set either", () => {
    const reachable = reachableFrom(REGRESSION);
    assert.ok(
        !reachable.has(DATASET),
        "the regression corpus imports the decision set"
    );
});

test("a superseded id in the decision set's graph is only ever a provenance label", () => {
    // The import boundary stops a module; this stops a copied literal. The
    // tranche files and the manifest do name superseded ids -- that is what a
    // replacement record is for -- but only as the `originalId` of the thing
    // that replaced them. An id in any other position is a case being put
    // back, or about to be.
    // The succ-3 corpus and the review records are the input this filters,
    // so of course they name the cases. Everything else in the graph is code
    // written for succ-4.
    const isRecord = (file) =>
        file.includes("/memoryEvalSucc3Adopted/") ||
        file.includes("/memoryEvalSuccessorAdopted/") ||
        file.endsWith("/memoryEvalSucc3Fixtures.ts") ||
        (file.includes("/memoryEvalSucc4Review/") &&
            !file.endsWith("/bPlusMoves.ts"));
    const count = (haystack, needle) => haystack.split(needle).length - 1;
    let checked = 0;
    for (const file of reachableFrom(DATASET)) {
        if (isRecord(file)) continue;
        const source = readFileSync(file, "utf8");
        for (const id of SUCC4_SUPERSEDED_CASE_IDS) {
            const mentions = count(source, `"${id}"`);
            if (mentions === 0) continue;
            checked += 1;
            assert.equal(
                count(source, `originalId: "${id}"`),
                mentions,
                `${path.relative(REPO, file)} names ${id} somewhere other than as an originalId`
            );
        }
    }
    assert.ok(checked > 100, `only ${checked} mentions were checked, so this proves little`);
});
