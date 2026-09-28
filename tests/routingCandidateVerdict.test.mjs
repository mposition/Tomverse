import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CANDIDATE_REJECTIONS } from "../lib/routerCandidates.ts";
import {
    ROUTING_CANDIDATE_VERDICTS,
    routingCandidateVerdictProblems,
} from "../lib/routingCandidateVerdict.ts";

/**
 * Why each candidate was or was not chosen.
 *
 * The rule under test is that a row cannot be half a verdict: a rejection says
 * why and holds no rank, an eligible candidate holds a rank and no reason, and
 * neither can be both.
 */

const migration = () =>
    readFileSync(
        new URL(
            "../prisma/migrations/20260923160000_routing_candidate_verdict_dark/migration.sql",
            import.meta.url
        ),
        "utf8"
    );

test("a rejection names its reason and holds no rank", () => {
    assert.deepEqual(
        routingCandidateVerdictProblems({ verdict: "rejected", reason: "plan" }),
        []
    );
    assert.deepEqual(
        routingCandidateVerdictProblems({ verdict: "rejected", reason: null }),
        ["a rejection names its reason"]
    );
    assert.deepEqual(
        routingCandidateVerdictProblems({
            verdict: "rejected",
            reason: "plan",
            rank: 2,
            rankBucket: 1,
        }),
        [
            "a rejected candidate was never ranked",
            "a rejected candidate is in no rank bucket",
        ]
    );
});

test("an eligible candidate has no rejection reason", () => {
    assert.deepEqual(
        routingCandidateVerdictProblems({ verdict: "eligible", rank: 1, rankBucket: 0 }),
        []
    );
    assert.deepEqual(
        routingCandidateVerdictProblems({ verdict: "eligible", reason: "plan" }),
        ["an eligible candidate has no rejection reason"]
    );
});

test("the reason has to be one the filter can actually give", () => {
    for (const reason of CANDIDATE_REJECTIONS) {
        assert.deepEqual(
            routingCandidateVerdictProblems({ verdict: "rejected", reason }),
            [],
            reason
        );
    }
    assert.deepEqual(
        routingCandidateVerdictProblems({ verdict: "rejected", reason: "too_expensive" }),
        ['unknown rejection reason "too_expensive"']
    );
});

test("an unknown verdict is refused rather than guessed at", () => {
    assert.deepEqual(routingCandidateVerdictProblems({ verdict: "maybe" }), [
        'unknown verdict "maybe"',
    ]);
    assert.deepEqual([...ROUTING_CANDIDATE_VERDICTS], ["eligible", "rejected"]);
});

test("a rank counts from one and a bucket from zero", () => {
    assert.deepEqual(
        routingCandidateVerdictProblems({ verdict: "eligible", rank: 0 }),
        ["a rank starts at one"]
    );
    assert.deepEqual(
        routingCandidateVerdictProblems({ verdict: "eligible", rankBucket: -1 }),
        ["a rank bucket starts at zero"]
    );
    assert.deepEqual(
        routingCandidateVerdictProblems({ verdict: "eligible", rank: 1.5 }),
        ["a rank starts at one"]
    );
});

test("the database holds the same rules", () => {
    const sql = migration();
    assert.match(sql, /RoutingCandidateVerdict_reason_matches_verdict_check/);
    assert.match(sql, /RoutingCandidateVerdict_rank_matches_verdict_check/);
    assert.match(sql, /RoutingCandidateVerdict_rank_positive_check/);
    for (const reason of CANDIDATE_REJECTIONS) {
        assert.match(sql, new RegExp(`'${reason}'`), reason);
    }
});

test("uniqueness survives a null deployment", () => {
    // PostgreSQL treats NULLs as distinct in a unique index, so one index over
    // (run, model, deployment) would accept two rows for the same model with
    // no deployment -- which is the duplicate this is meant to stop, and the
    // common case while deployments do not exist yet.
    const sql = migration();
    assert.match(
        sql,
        /CREATE UNIQUE INDEX "RoutingCandidateVerdict_run_model_key"[\s\S]*?WHERE "modelDeploymentId" IS NULL/
    );
    assert.match(
        sql,
        /CREATE UNIQUE INDEX "RoutingCandidateVerdict_run_deployment_key"[\s\S]*?WHERE "modelDeploymentId" IS NOT NULL/
    );
});

test("the verdicts die with the run they describe", () => {
    // Cascade, matching RoutingAttempt: they describe one decision and have no
    // meaning without it.
    assert.match(
        migration(),
        /RoutingCandidateVerdict_routingRunId_fkey[\s\S]*?ON DELETE CASCADE/
    );
});

test("there is no per-run cap", () => {
    // Any cut drops the lowest-ranked and the newest deployments first, which
    // are exactly the candidates somebody is asking about. Size belongs at
    // config publish time, not in discarded evidence.
    const sql = migration();
    assert.ok(!/LIMIT\s+\d+/i.test(sql), "no row limit in the schema");
    assert.match(sql, /no per-run cap/);
});
