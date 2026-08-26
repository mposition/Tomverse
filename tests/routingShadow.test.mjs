import assert from "node:assert/strict";
import test from "node:test";

import {
    buildRoutingShadowDecision,
    scheduleRoutingShadowRun,
} from "../lib/routingShadow.ts";
import { buildTaskProfile } from "../lib/taskProfileCore.ts";
import { TASK_PROFILE_VERSION } from "../lib/taskProfileCore.ts";
import { ROUTER_CANDIDATE_VERSION } from "../lib/routerCandidates.ts";
import { ROUTER_SELECTION_VERSION } from "../lib/routerSelection.ts";
import { ACTIVE_ESTIMATOR_VERSION } from "../lib/chatTokenEstimate.ts";

/**
 * The shadow decision, without a database.
 *
 * A shadow run exists to be compared against what really happened, so the two
 * things it must get right are that the comparison is possible (every version
 * recorded, the user's model recorded beside the Router's) and that the row is
 * safe to keep (no request content anywhere in it).
 */

const model = (overrides = {}) => ({
    id: "gpt-5-6-luna",
    name: "Luna",
    apiModel: "gpt-5.6-luna",
    provider: "openai",
    icon: "",
    bestFor: "",
    minimumPlan: "Guest",
    usageClass: "standard",
    enabled: true,
    status: "available",
    contextWindowTokens: 100_000,
    ...overrides,
});

const input = (overrides = {}) => ({
    traceId: "trace-1",
    subjectKey: "subject-1",
    plan: "Free",
    profile: buildTaskProfile({ text: "이 정규식 디버그해 줘" }),
    userSelectedModelId: "gpt-5-6-luna",
    estimatedInputTokens: 900,
    reservedInputTokens: 1_300,
    requestOutputCapTokens: 4_000,
    models: [model(), model({ id: "deepseek-v4-flash" })],
    ...overrides,
});

test("the decision records every version it depended on", () => {
    // Without all four, a change in routing behaviour cannot be attributed to
    // the rule that changed -- which is the reason each module carries one.
    const decision = buildRoutingShadowDecision(input());
    assert.equal(decision.taskProfileVersion, TASK_PROFILE_VERSION);
    assert.equal(decision.candidateFilterVersion, ROUTER_CANDIDATE_VERSION);
    assert.equal(decision.selectionVersion, ROUTER_SELECTION_VERSION);
    assert.equal(decision.estimatorVersion, ACTIVE_ESTIMATOR_VERSION);
});

test("the Router's choice and the user's are both recorded", () => {
    // The comparison is the whole point. Recording only the Router's answer
    // would leave a table that cannot say whether it agreed with anyone.
    const decision = buildRoutingShadowDecision(input());
    assert.equal(decision.userSelectedModelId, "gpt-5-6-luna");
    assert.equal(decision.selectedModelId, "deepseek-v4-flash");
    assert.equal(decision.mode, "shadow");
});

test("rejections are counted by reason, not listed per model", () => {
    const decision = buildRoutingShadowDecision(
        input({
            models: [
                model({ id: "a", enabled: false }),
                model({ id: "b", enabled: false }),
                model({ id: "c", minimumPlan: "Pro" }),
            ],
        })
    );
    assert.deepEqual(decision.rejectedByReason, { disabled: 2, plan: 1 });
    assert.equal(decision.eligibleCount, 0);
});

test("nothing eligible is a recorded result, not a missing value", () => {
    const decision = buildRoutingShadowDecision(input({ models: [] }));
    assert.equal(decision.selectedModelId, null);
    assert.equal(decision.selectionReason, "no_candidate");
    // A row that simply vanished would make "the Router had no answer" look
    // identical to "shadow routing was off".
    assert.equal(decision.eligibleCount, 0);
});

test("the row carries no request content", () => {
    const secret = "myuniquesecrettoken";
    const decision = buildRoutingShadowDecision(
        input({
            profile: buildTaskProfile({
                text: `debug ${secret}`,
                attachments: [{ name: `${secret}.png`, mediaType: "image/png" }],
            }),
        })
    );
    assert.ok(!JSON.stringify(decision).includes(secret));
});

test("both token figures are kept, because they answer different questions", () => {
    // The raw estimate is what the estimator is graded on; the reserved figure
    // is what the request really sends and what the filters bound against.
    const decision = buildRoutingShadowDecision(
        input({ estimatedInputTokens: 900, reservedInputTokens: 7_300 })
    );
    assert.equal(decision.estimatedInputTokens, 900);
    assert.equal(decision.reservedInputTokens, 7_300);
});

test("decision latency is measured and non-negative", () => {
    // ROUTE-02 bounds routing latency, and a bound needs a number.
    const decision = buildRoutingShadowDecision(input());
    assert.ok(Number.isInteger(decision.decisionMicros));
    assert.ok(decision.decisionMicros >= 0);
});

test("a guest run records its subject key and no account", () => {
    const decision = buildRoutingShadowDecision(
        input({ plan: "Guest", subjectKey: "guest-abc" })
    );
    assert.equal(decision.userId, null);
    assert.equal(decision.subjectKey, "guest-abc");
    assert.equal(decision.plan, "Guest");
});

test("stickiness is visible in the recorded reason", () => {
    const decision = buildRoutingShadowDecision(
        input({
            sticky: { modelId: "gpt-5-6-luna", turnsFavouringChallenger: 0 },
        })
    );
    // The Router would have moved to deepseek; continuity held it back, and a
    // reader has to be able to see that rather than infer it.
    assert.equal(decision.selectedModelId, "gpt-5-6-luna");
    assert.equal(decision.selectionReason, "sticky");
});

test("scheduling outside a request scope does not throw", () => {
    // `after()` throws when there is no request scope, and a chat handler
    // invoked outside one -- a direct call from an integration test, or any
    // future path that is not a Next request -- would then fail on a line
    // whose entire purpose is observation. Caught here rather than at the call
    // site, because a call-site `try` protects only until somebody adds a
    // second call site.
    assert.doesNotThrow(() =>
        scheduleRoutingShadowRun(() => input(), {
            TOMVERSE_ROUTER_SHADOW_ENABLED: "true",
        })
    );
});

test("with the flag off, scheduling does not even build the input", () => {
    // Nothing to record means nothing to schedule, and the path every request
    // takes today should not touch `after()` at all.
    let built = 0;
    scheduleRoutingShadowRun(() => {
        built += 1;
        return input();
    }, {});
    assert.equal(built, 0);
});

/**
 * A shadow row is a routing decision about a real turn, so it belongs to that
 * turn's conversation exactly as the dispatch row does.
 *
 * These two fields were dropped on the floor. `RoutingRun` gained
 * `conversationId` and `productKey` so a run could be attributed to a product,
 * and only `beginInstrumentedDispatch` was taught to write them -- because
 * `docs/policy/routing-run-product-attribution.md` §5 adopted writer coverage
 * on the stated ground that there is exactly one writer, and there were two.
 * A staging run found it: every `mode='shadow'` row carried nulls while the
 * `mode='manual'` row beside it, two seconds earlier and from the same turn,
 * carried the conversation.
 */
test("a shadow decision carries the conversation and product it ran for", () => {
    const decision = buildRoutingShadowDecision(
        input({ conversationId: "conv-1", productKey: "review" })
    );
    assert.equal(decision.conversationId, "conv-1");
    assert.equal(decision.productKey, "review");
});

/**
 * Null is the honest answer twice over, and neither is a gap.
 *
 * A guest turn has no conversation row to read a product from, and a
 * conversation written before `productKey` existed has none stored -- §6 of
 * the same policy refuses to infer one nobody recorded. What must not happen
 * is the field going missing from the row entirely, because a column that is
 * sometimes absent cannot be counted.
 */
test("a shadow decision with no conversation records null, not nothing", () => {
    const decision = buildRoutingShadowDecision(input());
    assert.equal(decision.conversationId, null);
    assert.equal(decision.productKey, null);
    assert.ok("conversationId" in decision);
    assert.ok("productKey" in decision);
});
