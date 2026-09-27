import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ROUTER_SCORE_POLICY_VERSION } from "../lib/routerScorePolicy.ts";
import {
    ROUTING_FAULTS,
    ROUTING_PROMOTION_STATES,
    applyRoutingFault,
    promoteRoutingConfig,
    replayLexicographicOrder,
} from "../lib/routingReplay.ts";

const neutral = {
    qualityBand: 2,
    qualityCi95Lower: null,
    evidenceRef: null,
};

const pair = [
    { modelId: "alpha", cell: neutral },
    { modelId: "beta", cell: neutral },
];

test("a replay follows the lexicographic order and refuses another policy", () => {
    const cheaperAlpha = replayLexicographicOrder({
        candidates: pair,
        signals: { expectedTotalCostUsdByModelId: { alpha: 1, beta: 2 } },
    });
    assert.deepEqual(cheaperAlpha.rankedModelIds, ["alpha", "beta"]);
    assert.equal(cheaperAlpha.decidedBy, "expected_total_cost");
    assert.equal(cheaperAlpha.policyVersion, ROUTER_SCORE_POLICY_VERSION);

    const cheaperBeta = replayLexicographicOrder({
        candidates: pair,
        signals: { expectedTotalCostUsdByModelId: { alpha: 2, beta: 1 } },
        policyVersion: ROUTER_SCORE_POLICY_VERSION,
    });
    assert.deepEqual(cheaperBeta.rankedModelIds, ["beta", "alpha"]);
    assert.equal(
        replayLexicographicOrder({
            candidates: pair,
            policyVersion: "router-score-policy-v9",
        }),
        null
    );
});

test("a pricing fault drops the old cost instead of inventing a new one", () => {
    const priced = replayLexicographicOrder({
        candidates: pair,
        signals: { expectedTotalCostUsdByModelId: { alpha: 2, beta: 1 } },
    });
    const unpriced = replayLexicographicOrder({
        candidates: pair,
        signals: { expectedTotalCostUsdByModelId: { alpha: 2, beta: 1 } },
        costUsable: false,
    });
    assert.deepEqual(priced.rankedModelIds, ["beta", "alpha"]);
    assert.deepEqual(unpriced.rankedModelIds, ["alpha", "beta"]);
    assert.equal(unpriced.decidedBy, "model_id");
    assert.equal(
        replayLexicographicOrder({
            candidates: [{ modelId: "alpha", cell: { ...neutral, qualityBand: 0 } }],
        }),
        null
    );
    assert.equal(
        replayLexicographicOrder({
            candidates: pair,
            signals: { expectedTotalCostUsdByModelId: { alpha: Number.NaN, beta: 1 } },
        }),
        null
    );
});

test("each named fault has the effect the ADR already stated", () => {
    assert.deepEqual(applyRoutingFault("primary_5xx_spike"), {
        fault: "primary_5xx_spike",
        availability: "server_error",
    });
    assert.deepEqual(applyRoutingFault("latency_2x", { ttftP95Ms: 10 }), {
        fault: "latency_2x",
        ttftP95Ms: 20,
    });
    assert.deepEqual(applyRoutingFault("latency_5x", { ttftP95Ms: 10 }), {
        fault: "latency_5x",
        ttftP95Ms: 50,
    });
    assert.equal(applyRoutingFault("latency_2x", { ttftP95Ms: -1 }), null);
    assert.equal(applyRoutingFault("latency_5x"), null);
    assert.deepEqual(applyRoutingFault("credential_429_saturation"), {
        fault: "credential_429_saturation",
        capacitySaturated: true,
    });
    assert.deepEqual(applyRoutingFault("byok_credential_expired"), {
        fault: "byok_credential_expired",
        credentialActive: false,
    });
    assert.deepEqual(applyRoutingFault("region_retention_policy_change"), {
        fault: "region_retention_policy_change",
        residencyDisclosable: false,
    });
    assert.deepEqual(applyRoutingFault("pricing_change"), {
        fault: "pricing_change",
        costUsable: false,
    });
    assert.deepEqual(applyRoutingFault("cache_hit_rate_change"), {
        fault: "cache_hit_rate_change",
        cacheSavingsUsable: false,
    });
    assert.deepEqual(applyRoutingFault("quality_gate_stale"), {
        fault: "quality_gate_stale",
        qualityGateStatus: "stale",
    });
    assert.deepEqual(applyRoutingFault("quality_gate_fail"), {
        fault: "quality_gate_fail",
        qualityGateStatus: "failed",
    });
    assert.deepEqual(applyRoutingFault("malformed_output_spike"), {
        fault: "malformed_output_spike",
        drift: { signal: "malformed_output_rate", exceeded: true },
    });
    assert.deepEqual(applyRoutingFault("model_version_drift"), {
        fault: "model_version_drift",
        versionDrifted: true,
    });
    assert.deepEqual(applyRoutingFault("pre_commit_stream_failure"), {
        fault: "pre_commit_stream_failure",
        stream: "pre_commit",
    });
    assert.deepEqual(applyRoutingFault("post_commit_stream_failure"), {
        fault: "post_commit_stream_failure",
        stream: "post_commit",
    });
    assert.deepEqual(applyRoutingFault("all_candidates_saturated"), {
        fault: "all_candidates_saturated",
        allCandidatesSaturated: true,
    });
    assert.equal(applyRoutingFault("softmax"), null);
    assert.deepEqual([...ROUTING_FAULTS], [
        "primary_5xx_spike",
        "latency_2x",
        "latency_5x",
        "credential_429_saturation",
        "byok_credential_expired",
        "region_retention_policy_change",
        "pricing_change",
        "cache_hit_rate_change",
        "quality_gate_stale",
        "quality_gate_fail",
        "malformed_output_spike",
        "model_version_drift",
        "pre_commit_stream_failure",
        "post_commit_stream_failure",
        "all_candidates_saturated",
    ]);
});

test("promotion moves one step and does not pick a percentage", () => {
    assert.deepEqual(promoteRoutingConfig("draft", "offline_replay"), {
        ok: true,
        from: "draft",
        to: "offline_replay",
    });
    assert.deepEqual(promoteRoutingConfig("wider_canary", "active"), {
        ok: true,
        from: "wider_canary",
        to: "active",
    });
    assert.deepEqual(promoteRoutingConfig("draft", "shadow"), {
        ok: false,
        reason: "not_next",
    });
    assert.deepEqual(promoteRoutingConfig("active", "draft"), {
        ok: false,
        reason: "not_next",
    });
    assert.deepEqual(promoteRoutingConfig("draft", "draft"), {
        ok: false,
        reason: "not_next",
    });
    assert.deepEqual(promoteRoutingConfig("canary", "active"), {
        ok: false,
        reason: "unknown_state",
    });
    assert.deepEqual([...ROUTING_PROMOTION_STATES], [
        "draft",
        "offline_replay",
        "fault_simulation",
        "shadow",
        "small_canary",
        "wider_canary",
        "active",
    ]);
    const source = readFileSync("lib/routingReplay.ts", "utf8");
    assert.equal(source.includes("softmax"), false);
    assert.equal(source.includes("routing_penalty"), false);
    assert.equal(source.includes("w_cost"), false);
});

test("the request path does not import the replay", () => {
    const hits = [];
    const walk = (directory) => {
        for (const name of readdirSync(directory)) {
            const path = join(directory, name);
            if (statSync(path).isDirectory()) {
                walk(path);
                continue;
            }
            if (!/\.(?:ts|tsx|mjs|js)$/.test(name)) continue;
            if (path === join("lib", "routingReplay.ts")) continue;
            const source = readFileSync(path, "utf8");
            if (source.includes("routingReplay") || source.includes("replayLexicographicOrder")) {
                hits.push(path);
            }
        }
    };
    for (const root of ["app", "lib"]) walk(root);
    assert.deepEqual(hits, []);
});
