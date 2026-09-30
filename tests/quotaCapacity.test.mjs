import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    CAPACITY_REFUSALS,
    capacityRefusal,
    capacityStateProblems,
    isDeprioritized,
} from "../lib/quotaCapacity.ts";

/**
 * Capacity, which is not health.
 *
 * A 429 says this key is spending too fast; a 5xx says the provider could not
 * serve the request. They call for opposite responses, and today they
 * increment the same counter. These tests hold the separation and the two
 * properties that follow from it: a demotion expires by itself, and being busy
 * is not the same as being unavailable.
 */

const at = new Date("2026-09-23T12:00:00.000Z");
const later = new Date("2026-09-23T12:05:00.000Z");
const earlier = new Date("2026-09-23T11:55:00.000Z");

const migration = () =>
    readFileSync(
        new URL(
            "../prisma/migrations/20260923180000_quota_capacity_state_dark/migration.sql",
            import.meta.url
        ),
        "utf8"
    );

test("an empty state refuses nothing", () => {
    assert.equal(capacityRefusal({}, at), null);
});

test("a retry-after in the future refuses, and one in the past does not", () => {
    assert.equal(capacityRefusal({ retryAfterUntil: later }, at), "retry_after");
    assert.equal(capacityRefusal({ retryAfterUntil: earlier }, at), null);
    // Exactly now is over: the provider asked us to wait *until* then.
    assert.equal(capacityRefusal({ retryAfterUntil: at }, at), null);
});

test("concurrency refuses only when every slot is held", () => {
    assert.equal(
        capacityRefusal({ concurrencyLimit: 2, concurrencyInUse: 1 }, at),
        null
    );
    assert.equal(
        capacityRefusal({ concurrencyLimit: 2, concurrencyInUse: 2 }, at),
        "concurrency_exhausted"
    );
    // No limit is no limit, not a limit of zero.
    assert.equal(capacityRefusal({ concurrencyInUse: 99 }, at), null);
    // A limit of zero holds nothing at all, which is a refusal.
    assert.equal(
        capacityRefusal({ concurrencyLimit: 0, concurrencyInUse: 0 }, at),
        "concurrency_exhausted"
    );
});

test("an empty bucket refuses and an absent one does not", () => {
    assert.equal(
        capacityRefusal({ tokenBucketRemaining: 0 }, at),
        "token_bucket_empty"
    );
    assert.equal(capacityRefusal({ tokenBucketRemaining: 1 }, at), null);
    assert.equal(capacityRefusal({}, at), null);
});

test("being busy is not being unavailable", () => {
    // A demotion orders candidates; it does not remove them. Turning it into a
    // refusal is how a rate limit becomes an outage.
    const busy = { deprioritizeUntil: later };
    assert.equal(isDeprioritized(busy, at), true);
    assert.equal(capacityRefusal(busy, at), null);
});

test("a demotion ends by itself", () => {
    // No recovery probe, nobody noticing, no counter for a success to clear --
    // which is the difference from a failure count, where the success that
    // would clear it is the one the counter stopped.
    assert.equal(isDeprioritized({ deprioritizeUntil: earlier }, at), false);
    assert.equal(isDeprioritized({ deprioritizeUntil: at }, at), false);
    assert.equal(isDeprioritized({}, at), false);
});

test("every refusal is one of the declared identifiers", () => {
    const states = [
        { retryAfterUntil: later },
        { concurrencyLimit: 1, concurrencyInUse: 1 },
        { tokenBucketRemaining: 0 },
    ];
    for (const state of states) {
        const refusal = capacityRefusal(state, at);
        assert.ok(CAPACITY_REFUSALS.includes(refusal), JSON.stringify(state));
    }
});

test("a count belongs to a window", () => {
    assert.deepEqual(capacityStateProblems({ rateLimitedCount: 0 }), []);
    assert.deepEqual(capacityStateProblems({ rateLimitedCount: 3, windowStartedAt: at }), []);
    assert.deepEqual(capacityStateProblems({ rateLimitedCount: 3 }), [
        "a count belongs to a window",
    ]);
});

test("a bucket level carries the time it was filled", () => {
    assert.deepEqual(
        capacityStateProblems({ tokenBucketRemaining: 5, tokenBucketRefilledAt: at }),
        []
    );
    assert.deepEqual(capacityStateProblems({ tokenBucketRemaining: 5 }), [
        "a bucket level carries the time it was filled",
    ]);
    assert.deepEqual(capacityStateProblems({ tokenBucketRefilledAt: at }), [
        "a bucket level carries the time it was filled",
    ]);
});

test("nothing counts below zero", () => {
    // A negative in-use count reads as spare capacity, which is the direction
    // that lets too much through.
    assert.deepEqual(capacityStateProblems({ concurrencyInUse: -1 }), [
        "a count is not negative",
    ]);
    assert.deepEqual(capacityStateProblems({ tokenBucketRemaining: -1, tokenBucketRefilledAt: at }), [
        "a bucket is not negative",
    ]);
});

test("the database holds the same rules", () => {
    const sql = migration();
    assert.match(sql, /QuotaCapacityState_counts_non_negative_check/);
    assert.match(sql, /QuotaCapacityState_count_has_window_check/);
    assert.match(sql, /QuotaCapacityState_bucket_has_refill_check/);
    // One row per scope: a second would be a second answer to how much is left.
    assert.match(sql, /CREATE UNIQUE INDEX "QuotaCapacityState_quotaScopeId_key"/);
});

test("capacity touches no health table", () => {
    // The whole reason for the table. A column or constraint naming provider
    // health here would put a rate limit back into the counter this separates
    // it from.
    //
    // Comments are stripped first: the header explains at length *why*
    // capacity is not health, and naming the thing you are separating from is
    // how that explanation works.
    const statements = migration()
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
    for (const forbidden of ["ProviderHealthState", "consecutiveFailures", "ProviderProbeResult"]) {
        assert.ok(!statements.includes(forbidden), `${forbidden} has no place in capacity`);
    }
    const source = readFileSync(
        new URL("../lib/quotaCapacity.ts", import.meta.url),
        "utf8"
    );
    assert.ok(!source.includes("prisma"), "the capacity rules read no database");
});
