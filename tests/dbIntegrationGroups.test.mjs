import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
    DB_INTEGRATION_FALLBACK_GROUP,
    DB_INTEGRATION_GROUPS,
    dbIntegrationGroupOf,
} from "../scripts/db-integration-groups.mjs";

/**
 * That splitting the database suite into lanes did not quietly stop running
 * any of it.
 *
 * The runner's own comments record how this goes wrong: the import and memory
 * suites "were written alongside their slices but never listed here, i.e.
 * never actually run by CI -- a guard nobody runs is not a guard." One job
 * gave that one way to happen, a file missing from one list. Seven lanes give
 * it two, so this closes both -- and it did not exist before the split, which
 * is what makes the split safe rather than a second place to lose a suite.
 */

const ROOT = resolve(import.meta.dirname, "..");
const runner = readFileSync(
    resolve(ROOT, "scripts", "run-db-integration-tests.mjs"),
    "utf8"
);

const onDisk = readdirSync(resolve(ROOT, "tests", "integration"))
    .filter((name) => name.endsWith(".db.test.ts"))
    .map((name) => `tests/integration/${name}`)
    .sort();

const listed = [
    ...new Set(
        [...runner.matchAll(/"(tests\/integration\/[^"]+\.db\.test\.ts)"/g)].map(
            (match) => match[1]
        )
    ),
].sort();

test("every database suite on disk is one the runner actually runs", () => {
    // The original hole, and still the one that costs the most: a suite
    // written, committed, and never executed reads as coverage on every
    // subsequent review.
    assert.deepEqual(
        onDisk.filter((file) => !listed.includes(file)),
        [],
        "these exist but no run() names them, so CI has never executed them"
    );
});

test("the runner names no suite that no longer exists", () => {
    // The other direction fails loudly rather than silently, but it fails in
    // CI on somebody else's branch, which is the wrong place to find out.
    assert.deepEqual(
        listed.filter((file) => !onDisk.includes(file)),
        [],
        "these are named by the runner but are not on disk"
    );
});

test("every suite lands in exactly one lane", () => {
    // The failure the split introduces: a suite matching no rule, or a rule
    // ordering that sends one somewhere nobody looks. Total coverage is what
    // makes seven jobs equal to the one they replaced.
    const byLane = new Map(DB_INTEGRATION_GROUPS.map((id) => [id, []]));
    for (const file of onDisk) {
        const lane = dbIntegrationGroupOf(file);
        assert.ok(
            byLane.has(lane),
            `${file} resolved to "${lane}", which is not a lane CI runs`
        );
        byLane.get(lane).push(file);
    }
    assert.equal(
        [...byLane.values()].reduce((total, files) => total + files.length, 0),
        onDisk.length,
        "the lanes together must run the whole suite"
    );
});

test("an unclassified suite runs rather than disappearing", () => {
    // A new suite must not need an edit here to be executed at all. Falling to
    // a real lane means the cost of forgetting is an uneven job, not a guard
    // that silently stopped guarding.
    assert.equal(
        dbIntegrationGroupOf("tests/integration/something-nobody-classified.db.test.ts"),
        DB_INTEGRATION_FALLBACK_GROUP
    );
    assert.ok(DB_INTEGRATION_GROUPS.includes(DB_INTEGRATION_FALLBACK_GROUP));
});

test("the workflow runs every lane the module defines", () => {
    // A lane added here and not to the matrix is a lane nothing runs, which
    // looks exactly like a passing check.
    const workflow = readFileSync(
        resolve(ROOT, ".github", "workflows", "credit-finance-db-integration.yml"),
        "utf8"
    );
    for (const lane of DB_INTEGRATION_GROUPS) {
        assert.ok(
            new RegExp(`\\n\\s+-\\s+${lane}\\b`).test(workflow),
            `the matrix does not include the ${lane} lane`
        );
    }
});

test("no lane is large enough to put the timeout back where it was", () => {
    // The split exists because a 28-minute suite rode a 30-minute timeout. A
    // lane holding most of the suites would recreate that, and the next person
    // to notice would be whoever's unrelated branch drew the slow runner.
    const counts = new Map();
    for (const file of onDisk) {
        const lane = dbIntegrationGroupOf(file);
        counts.set(lane, (counts.get(lane) || 0) + 1);
    }
    const largest = Math.max(...counts.values());
    assert.ok(
        largest <= onDisk.length / 3,
        `the largest lane holds ${largest} of ${onDisk.length} suites; rebalance the rules`
    );
});
