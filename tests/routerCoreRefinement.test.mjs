import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    partitionByKey,
    partitionByMetric,
    partitions,
    refineToRanking,
} from "@tomverse/router-core";

/**
 * The ranking construction, on its own and away from the product.
 *
 * `tests/routerSelection.test.mjs` covers what Tomverse Chat does with it --
 * which criteria exist, what they read, what the epsilons are. These cover the
 * property that made it worth extracting: a ranking built from criteria that
 * abstain is still total and transitive, which a pairwise comparator over the
 * same rules is not.
 */

const item = (id, cost) => ({ id, cost });
const keyFor = (entry) => entry.id;

test("a criterion that cannot speak for every member leaves the group whole", () => {
    // Group-scoped rather than pair-scoped abstention. One unmeasured member
    // silences the criterion for everybody it is still tied with, which is
    // what stops the cycle.
    const group = [item("a", 1), item("b"), item("c", 3)];
    assert.deepEqual(
        partitionByMetric(
            group,
            (entry) => entry.cost,
            { epsilon: 0, lowerWins: true, relative: false },
            keyFor
        ),
        [group]
    );
});

test("a reading that is not a finite number is not a reading", () => {
    // NaN compares false against everything, so a member carrying one would
    // land in no bucket and leave with a shorter rank key than everybody else.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const group = [item("a", 1), item("b", bad)];
        assert.deepEqual(
            partitionByMetric(
                group,
                (entry) => entry.cost,
                { epsilon: 0, lowerWins: true, relative: false },
                keyFor
            ),
            [group],
            String(bad)
        );
    }
});

test("the epsilon is anchored to each bucket, not to each pair", () => {
    // At a 5% ratio 100 ties 104 and 104 ties 108, while 100 beats 108
    // outright. Pairwise that is a cycle; anchored it splits the same way
    // every time whatever order the items arrived in.
    const readings = [item("x", 100), item("y", 104), item("z", 108)];
    const split = (order) =>
        partitionByMetric(
            order,
            (entry) => entry.cost,
            { epsilon: 0.05, lowerWins: true, relative: true },
            keyFor
        ).map((bucket) => bucket.map(keyFor));

    assert.deepEqual(split(readings), [["x", "y"], ["z"]]);
    assert.deepEqual(split([...readings].reverse()), [["x", "y"], ["z"]]);
    assert.deepEqual(split([readings[1], readings[2], readings[0]]), [
        ["x", "y"],
        ["z"],
    ]);
});

test("a relative epsilon is a ratio and an absolute one is an amount", () => {
    // A cent between two cheap options is not a cent between two expensive
    // ones.
    const pair = [item("a", 1000), item("b", 1040)];
    const relative = partitionByMetric(
        pair,
        (entry) => entry.cost,
        { epsilon: 0.05, lowerWins: true, relative: true },
        keyFor
    );
    assert.equal(relative.length, 1);
    const absolute = partitionByMetric(
        pair,
        (entry) => entry.cost,
        { epsilon: 5, lowerWins: true, relative: false },
        keyFor
    );
    assert.equal(absolute.length, 2);
});

test("equal readings are ordered by the tie key", () => {
    const group = [item("c", 1), item("a", 1), item("b", 1)];
    assert.deepEqual(
        partitionByMetric(
            group,
            (entry) => entry.cost,
            { epsilon: 0, lowerWins: true, relative: false },
            keyFor
        ).map((bucket) => bucket.map(keyFor)),
        [["a", "b", "c"]]
    );
});

test("the key partition is total on its own", () => {
    assert.deepEqual(
        partitionByKey([item("c"), item("a"), item("b")], keyFor).map((bucket) =>
            bucket.map(keyFor)
        ),
        [["a"], ["b"], ["c"]]
    );
});

test("a partition is every member once and nothing else", () => {
    const a = item("a");
    const b = item("b");
    assert.equal(partitions([[a], [b]], [a, b]), true);
    // Dropped one and repeated another: the right total and the wrong keys.
    assert.equal(partitions([[a], [a]], [a, b]), false);
    assert.equal(partitions([[a]], [a, b]), false);
    assert.equal(partitions([[a], [b], []], [a, b]), false);
    // The group itself holds the same object twice, which this cannot reason
    // about. Abstain rather than guess.
    assert.equal(partitions([[a]], [a, a]), false);
});

test("the ranking a pairwise comparator could not produce", () => {
    // A and B carry a quality reading, C carries none, and costs are
    // B < C < A. Pairwise: quality says A beats B, cost says B beats C and C
    // beats A, so A > B > C > A. Refinement gives one order.
    const A = { id: "A", quality: 3, cost: 30 };
    const B = { id: "B", quality: 1, cost: 10 };
    const C = { id: "C", quality: undefined, cost: 20 };

    const { ranked, decidedBy } = refineToRanking(
        [A, B, C],
        ["quality", "cost", "id"],
        (criterion) => (group) => {
            if (criterion === "quality") {
                return partitionByMetric(
                    group,
                    (entry) => entry.quality,
                    { epsilon: 0, lowerWins: false, relative: false },
                    (entry) => entry.id
                );
            }
            if (criterion === "cost") {
                return partitionByMetric(
                    group,
                    (entry) => entry.cost,
                    { epsilon: 0, lowerWins: true, relative: false },
                    (entry) => entry.id
                );
            }
            return partitionByKey(group, (entry) => entry.id);
        }
    );

    // Quality abstains over the whole group, because C has none. Cost decides
    // everything, and it is transitive.
    assert.deepEqual(
        ranked.map((entry) => entry.id),
        ["B", "C", "A"]
    );
    assert.equal(decidedBy(A, B), "cost");
    assert.equal(decidedBy(B, C), "cost");
    assert.equal(decidedBy(C, A), "cost");

    // Transitive by construction: the order is the same from any input order.
    for (const order of [
        [C, B, A],
        [B, A, C],
        [A, C, B],
    ]) {
        assert.deepEqual(
            refineToRanking(order, ["quality", "cost", "id"], (criterion) => (group) =>
                criterion === "cost"
                    ? partitionByMetric(
                          group,
                          (entry) => entry.cost,
                          { epsilon: 0, lowerWins: true, relative: false },
                          (entry) => entry.id
                      )
                    : [group]
            ).ranked.map((entry) => entry.id),
            ["B", "C", "A"]
        );
    }
});

test("a partitioner that loses a member is treated as an abstention", () => {
    // Losing the criterion is the safe direction: a caller that could still
    // answer should not fail over a ranking refinement.
    const a = item("a", 1);
    const b = item("b", 2);
    const { ranked } = refineToRanking([a, b], ["broken", "id"], (criterion) =>
        criterion === "broken"
            ? () => [[a]]
            : (group) => partitionByKey(group, keyFor)
    );
    assert.deepEqual(ranked.map(keyFor), ["a", "b"]);
});

test("nothing separated them means nothing is named", () => {
    // Null rather than the last criterion. Naming one would be reporting a
    // criterion that did not in fact decide; a caller whose last criterion is
    // total may say so itself, and lib/routerSelection.ts does.
    const a = { id: "same" };
    const b = { id: "same" };
    const { decidedBy } = refineToRanking([a, b], ["id"], () => (group) =>
        partitionByKey(group, keyFor)
    );
    assert.equal(decidedBy(a, b), null);
});

test("the package takes no product decisions", () => {
    // A criterion list imported here would make this a Tomverse Chat package
    // that happens to live under packages/, and the next client would inherit
    // decisions it never made. Checked two ways, because the import rule alone
    // would not catch a criterion written out by hand.
    // `epsilon` is deliberately not on this list. It is a parameter name --
    // the tolerance is supplied by the caller -- and a generic word for one.
    // What the list is for is a criterion or a reading this package should
    // never know about.
    const vocabulary =
        /\b(quality|ttft|latency|cost|credit|plan|provider|model|token|sticky|health|degraded)/i;
    for (const file of ["index.ts", "refinement.ts"]) {
        const source = readFileSync(
            new URL(`../packages/router-core/src/${file}`, import.meta.url),
            "utf8"
        );
        const imports =
            source.match(/^\s*(import|export)\s[^;]*from\s+["'][^"']+["']/gm) ?? [];
        for (const statement of imports) {
            assert.match(statement, /["']\.\/[\w.]+["']/, statement);
        }
        // Product words may appear in prose -- the module explains what it was
        // extracted from -- but not in code. A criterion named here is a
        // decision the package has taken.
        const code = source
            .split("\n")
            .filter((line) => {
                const trimmed = line.trimStart();
                return (
                    !trimmed.startsWith("*") &&
                    !trimmed.startsWith("/*") &&
                    !trimmed.startsWith("//")
                );
            })
            .join("\n");
        const found = vocabulary.exec(code);
        assert.equal(found, null, `${file} names ${found?.[0]}`);
    }
});
