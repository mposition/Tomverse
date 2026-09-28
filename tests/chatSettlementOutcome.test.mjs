import assert from "node:assert/strict";
import test from "node:test";

import {
    routingFailureLayerForSettlement,
    routingOutcomeForSettlement,
} from "../lib/chatSettlementOutcome.ts";
import { DISPATCH_OUTCOMES_COUNTED } from "../lib/routerSignalCore.ts";

/**
 * The name an empty answer is filed under.
 *
 * `failed_post_token` means the person was already reading an answer when it
 * broke -- that is how `lib/routingStreamFailure.ts` chooses between the two
 * names, and it is what `lib/routingFallbackPolicy.ts` reads to refuse a
 * silent model switch. A stream that ended cleanly having produced nothing is
 * the opposite case, and was being filed under the same name.
 */

test("an empty answer is a failure before the first token, not after it", () => {
    assert.equal(routingOutcomeForSettlement("empty"), "failed_pre_token");
});

test("the other terminal outcomes keep the names they had", () => {
    assert.equal(routingOutcomeForSettlement("completed"), "succeeded");
    assert.equal(routingOutcomeForSettlement("cancelled"), "cancelled");
    assert.equal(routingOutcomeForSettlement("failed"), "failed_post_token");
});

/**
 * The rename must not move the Router's success rate.
 *
 * An empty answer is still an answer the person did not get, so it stays in
 * the denominator and out of the numerator. Both failure names are counted
 * outcomes and neither is `succeeded`, so the rate is the same number before
 * and after -- which is the whole claim that makes this a naming fix rather
 * than a scoring change.
 */
test("an empty answer still counts as a failure, exactly as before", () => {
    const before = "failed_post_token";
    const after = routingOutcomeForSettlement("empty");

    assert.notEqual(after, before);
    for (const outcome of [before, after]) {
        assert.ok(
            DISPATCH_OUTCOMES_COUNTED.includes(outcome),
            `${outcome} must stay in the success-rate denominator`
        );
        assert.notEqual(outcome, "succeeded");
    }
});

test("every settlement outcome maps to a recordable attempt outcome", () => {
    // The values `RoutingAttempt_outcome_check` allows. Written out rather
    // than imported, because importing the writer's own union would let a
    // change to it satisfy this test by moving the target.
    const allowed = [
        "pending",
        "not_dispatched",
        "failed_pre_token",
        "failed_post_token",
        "cancelled",
        "succeeded",
        "unknown_after_dispatch",
    ];
    for (const settlement of ["completed", "cancelled", "failed", "empty"]) {
        assert.ok(
            allowed.includes(routingOutcomeForSettlement(settlement)),
            settlement
        );
    }
});

/**
 * The layer an empty answer is attributed to.
 *
 * `stream` is this process or this connection. An empty answer is neither: the
 * call reached the provider and succeeded.
 */

test("an empty answer is attributed to the model's output, not to the stream", () => {
    assert.equal(routingFailureLayerForSettlement("empty"), "model_output");
    assert.equal(routingFailureLayerForSettlement("failed"), "stream");
});

test("a turn that did not fail carries no layer, as the database requires", () => {
    // `RoutingAttempt_outcome_failure_layer_check` forces 'none' for the
    // outcomes that are not failures, so these two are not a style choice.
    for (const settlement of ["completed", "cancelled"]) {
        assert.equal(routingFailureLayerForSettlement(settlement), "none");
        assert.ok(
            ["succeeded", "cancelled", "pending"].includes(
                routingOutcomeForSettlement(settlement)
            )
        );
    }
    for (const settlement of ["empty", "failed"]) {
        assert.notEqual(routingFailureLayerForSettlement(settlement), "none");
        assert.ok(
            !["succeeded", "cancelled", "pending"].includes(
                routingOutcomeForSettlement(settlement)
            )
        );
    }
});

test("every layer this maps to is one the constraint allows", () => {
    // Written out rather than imported, so that widening the union cannot
    // satisfy this test by moving the target. Matches
    // prisma/migrations/20260922120000_routing_attempt_model_output_layer.
    const allowed = [
        "none",
        "planner",
        "adapter",
        "manifest",
        "billing",
        "provider",
        "stream",
        "process",
        "storage",
        "application",
        "model_output",
    ];
    for (const settlement of ["completed", "cancelled", "failed", "empty"]) {
        assert.ok(
            allowed.includes(routingFailureLayerForSettlement(settlement)),
            settlement
        );
    }
});
