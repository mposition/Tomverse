import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    ROUTING_ALLOCATION_MODES,
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
