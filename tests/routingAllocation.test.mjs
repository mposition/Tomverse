import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    ROUTING_ALLOCATION_MODES,
    allocateWithinTie,
    ROUTING_ALLOCATION_SEED_GRAINS,
    mayBreakCacheAffinity,
    routingAllocationProblems,
} from "../lib/routingAllocation.ts";

/**
 * How a candidate was picked, as an axis of its own.
 *
 * What these hold is that the axis stays separate from `RoutingRun.mode`, that
 * an unrecorded allocation stays unrecorded rather than becoming
 * `deterministic`, and that an exploration cannot be written without saying
 * what it was seeded on.
 */

const migration = () =>
    readFileSync(
        new URL(
            "../prisma/migrations/20260923240000_routing_allocation_axis_dark/migration.sql",
            import.meta.url
        ),
        "utf8"
    );

test("a run from before the allocator records neither", () => {
    // Null rather than `deterministic`: reading a missing record as "we took
    // the top candidate" invents a decision nobody made.
    assert.deepEqual(routingAllocationProblems({}), []);
    assert.deepEqual(
        routingAllocationProblems({ allocationMode: null, allocationSeedGrain: null }),
        []
    );
    assert.deepEqual(
        routingAllocationProblems({ allocationSeedGrain: "session" }),
        ["a seed grain belongs to an allocation that was recorded"]
    );
});

test("a deterministic allocation rolled nothing, so it names no seed", () => {
    assert.deepEqual(routingAllocationProblems({ allocationMode: "deterministic" }), []);
    assert.deepEqual(
        routingAllocationProblems({
            allocationMode: "deterministic",
            allocationSeedGrain: "request",
        }),
        ["a deterministic allocation has no seed"]
    );
});

test("an exploration says what it was seeded on", () => {
    // Without it the pick cannot be replayed, and nothing can say afterwards
    // whether it was moving conversations off the placements holding their
    // prefixes.
    assert.deepEqual(routingAllocationProblems({ allocationMode: "explore_bounded" }), [
        "an exploration names what it was seeded on",
    ]);
    for (const grain of ROUTING_ALLOCATION_SEED_GRAINS) {
        assert.deepEqual(
            routingAllocationProblems({
                allocationMode: "explore_bounded",
                allocationSeedGrain: grain,
            }),
            [],
            grain
        );
    }
});

test("an unknown value is refused before the shape is judged", () => {
    assert.deepEqual(routingAllocationProblems({ allocationMode: "shadow_explore" }), [
        'unknown allocation mode "shadow_explore"',
    ]);
    assert.deepEqual(
        routingAllocationProblems({
            allocationMode: "explore_bounded",
            allocationSeedGrain: "conversation",
        }),
        ['unknown allocation seed grain "conversation"']
    );
});

test("the affinity answer abstains where nothing was recorded", () => {
    // Null, not false. A run that recorded no allocation did not record a
    // deterministic one.
    assert.equal(mayBreakCacheAffinity({}), null);
    assert.equal(mayBreakCacheAffinity({ allocationMode: "deterministic" }), false);
    assert.equal(
        mayBreakCacheAffinity({
            allocationMode: "explore_bounded",
            allocationSeedGrain: "session",
        }),
        false
    );
    assert.equal(
        mayBreakCacheAffinity({
            allocationMode: "explore_bounded",
            allocationSeedGrain: "request",
        }),
        true
    );
});

test("the axis is a second column and not more values in the first", () => {
    const sql = migration();
    // mode is untouched: it answers whether the decision was acted on.
    assert.ok(
        !/ALTER\s+TABLE\s+"RoutingRun"[\s\S]{0,200}?"mode"/.test(sql),
        "the mode column is not altered"
    );
    assert.match(sql, /ADD COLUMN "allocationMode" TEXT,/);
    assert.match(sql, /ADD COLUMN "allocationSeedGrain" TEXT/);
    // No default. Every existing row genuinely recorded neither, and a backfill
    // cannot say what an allocator would have done.
    assert.ok(
        !/ADD COLUMN "allocation[A-Za-z]+" TEXT[^,;]*DEFAULT/.test(sql),
        "neither column defaults"
    );
    assert.deepEqual([...ROUTING_ALLOCATION_MODES], ["deterministic", "explore_bounded"]);
});

test("the lists are written in the form the enum gate reads", () => {
    // A list folded into a multi-branch OR is one the gate cannot see, and an
    // unseen list is one the application can drift away from.
    const sql = migration();
    assert.match(
        sql,
        /"RoutingRun_allocationMode_check"\s*CHECK \(\s*"allocationMode" IS NULL\s*OR "allocationMode" IN \('deterministic', 'explore_bounded'\)/
    );
    assert.match(
        sql,
        /"RoutingRun_allocationSeedGrain_check"\s*CHECK \(\s*"allocationSeedGrain" IS NULL\s*OR "allocationSeedGrain" IN \('request', 'session'\)/
    );
});

test("the database refuses the same three shapes", () => {
    const sql = migration();
    assert.match(sql, /"RoutingRun_allocation_axis_check"/);
    // A grain alone is a seed for a choice nobody recorded.
    assert.match(
        sql,
        /\("allocationMode" IS NULL AND "allocationSeedGrain" IS NULL\)/
    );
    assert.match(
        sql,
        /\("allocationMode" = 'deterministic' AND "allocationSeedGrain" IS NULL\)/
    );
    assert.match(
        sql,
        /\("allocationMode" = 'explore_bounded' AND "allocationSeedGrain" IS NOT NULL\)/
    );
});

test("nothing reads the two columns", () => {
    // RoutingRun is live, so the table check cannot cover this: the columns
    // are dark on a table that is not. check-dark-tables scans for the two
    // identifiers, exempting only the module that defines the vocabulary.
    const checker = readFileSync(
        new URL("../scripts/check-dark-tables.mjs", import.meta.url),
        "utf8"
    );
    assert.match(checker, /const DARK_COLUMNS = \["allocationMode", "allocationSeedGrain"\]/);
    assert.match(checker, /const DARK_COLUMN_VOCABULARY = \["lib\/routingAllocation\.ts"\]/);
});

// ---------------------------------------------------------------------------
// Allocation inside a tie
// ---------------------------------------------------------------------------

const candidate = (id) => ({ id });
const keyFor = (entry) => entry.id;
const tiedWith = (...ids) => (entry) => ids.includes(entry.id);

const exploring = (seed, seedGrain = "session") => ({
    enabled: true,
    seedGrain,
    seed,
});

test("no exploration policy means the top of the ranking", () => {
    // Fail-closed. An allocator that spread traffic because a configuration
    // key was missing would be changing which model answers a turn on the
    // strength of an omission.
    const ranked = [candidate("a"), candidate("b"), candidate("c")];
    for (const policy of [
        null,
        { enabled: false, seedGrain: "session", seed: "s" },
    ]) {
        const result = allocateWithinTie(ranked, tiedWith("a", "b"), keyFor, policy);
        assert.equal(result.chosen.id, "a");
        assert.equal(result.allocationMode, "deterministic");
        assert.equal(result.allocationSeedGrain, null);
    }
});

test("a tie of one is deterministic whatever the policy says", () => {
    // There is nothing to spread across.
    const ranked = [candidate("a"), candidate("b")];
    const result = allocateWithinTie(ranked, tiedWith("a"), keyFor, exploring("s"));
    assert.equal(result.chosen.id, "a");
    assert.equal(result.allocationMode, "deterministic");
});

test("a seed nobody supplied is not a seed", () => {
    // Refusing rather than reaching for a clock or a random source is what
    // keeps a replay honest.
    const ranked = [candidate("a"), candidate("b")];
    for (const seed of ["", "   "]) {
        const result = allocateWithinTie(
            ranked,
            tiedWith("a", "b"),
            keyFor,
            exploring(seed)
        );
        assert.equal(result.allocationMode, "deterministic", JSON.stringify(seed));
    }
});

test("exploration stays inside the tie and records its grain", () => {
    const ranked = [candidate("a"), candidate("b"), candidate("c")];
    const chosen = new Set();
    for (let index = 0; index < 200; index += 1) {
        const result = allocateWithinTie(
            ranked,
            tiedWith("a", "b"),
            keyFor,
            exploring(`seed-${index}`)
        );
        assert.equal(result.allocationMode, "explore_bounded");
        assert.equal(result.allocationSeedGrain, "session");
        chosen.add(result.chosen.id);
    }
    // Never the candidate the ranking actually separated. Exploring outside
    // the tie would need a trade between quality and cost that nobody has
    // made.
    assert.deepEqual([...chosen].sort(), ["a", "b"]);
});

test("the same seed picks the same candidate", () => {
    // A replay of the same run answers the same way, months later.
    const ranked = [candidate("a"), candidate("b"), candidate("c")];
    const pick = () =>
        allocateWithinTie(ranked, tiedWith("a", "b", "c"), keyFor, exploring("fixed"))
            .chosen.id;
    const first = pick();
    for (let index = 0; index < 10; index += 1) assert.equal(pick(), first);
});

test("the pick does not move when an unrelated candidate is added", () => {
    // The tie is ordered by key before the modulo. Without that, a rerank that
    // added one candidate would shift every index after it and a conversation
    // would leave the placement holding its prefix for no reason.
    const withoutExtra = allocateWithinTie(
        [candidate("a"), candidate("b")],
        tiedWith("a", "b"),
        keyFor,
        exploring("fixed")
    );
    const withExtra = allocateWithinTie(
        [candidate("a"), candidate("b"), candidate("z")],
        tiedWith("a", "b"),
        keyFor,
        exploring("fixed")
    );
    assert.equal(withExtra.chosen.id, withoutExtra.chosen.id);
});

test("the top is in its own tie even if the predicate forgets it", () => {
    // A predicate that excludes the top has been given the wrong comparison,
    // and taking its word would drop the winner.
    const ranked = [candidate("a"), candidate("b")];
    const result = allocateWithinTie(ranked, () => false, keyFor, null);
    assert.equal(result.chosen.id, "a");
    assert.deepEqual(result.tied.map(keyFor), ["a"]);
});

test("an empty ranking allocates nothing", () => {
    assert.equal(allocateWithinTie([], () => true, keyFor, exploring("s")), null);
});

test("what the allocator produces is what the columns accept", () => {
    // The two halves of this axis were written separately, so they are checked
    // against each other rather than assumed to agree.
    const ranked = [candidate("a"), candidate("b")];
    for (const policy of [null, exploring("s", "session"), exploring("s", "request")]) {
        const result = allocateWithinTie(ranked, tiedWith("a", "b"), keyFor, policy);
        assert.deepEqual(
            routingAllocationProblems({
                allocationMode: result.allocationMode,
                allocationSeedGrain: result.allocationSeedGrain,
            }),
            [],
            JSON.stringify(policy)
        );
    }
});

test("the allocator does not fold the criteria into a number", () => {
    // The ADR allocates with a softmax over a routing_penalty: one scalar the
    // criteria are folded into, with a temperature deciding how far from the
    // best the traffic spreads. That fold is a change to the objective
    // function and states how much quality a dollar is worth, which nobody has
    // decided.
    const source = readFileSync(
        new URL("../lib/routingAllocation.ts", import.meta.url),
        "utf8"
    );
    const statements = source
        .split("\n")
        .filter((line) => {
            const trimmed = line.trimStart();
            return !trimmed.startsWith("*") && !trimmed.startsWith("/*") && !trimmed.startsWith("//");
        })
        .join("\n");
    for (const forbidden of ["softmax", "temperature", "penalty", "weight", "Math.exp"]) {
        assert.ok(!statements.includes(forbidden), `${forbidden} is absent`);
    }
    // And no randomness: the pick comes from the caller's seed, so a replay
    // answers the same way.
    assert.ok(!statements.includes("Math.random"), "Math.random is absent");
    assert.ok(!statements.includes("Date.now"), "Date.now is absent");
});
