import assert from "node:assert/strict";
import test from "node:test";

import {
    CANDIDATE_REJECTIONS,
    ROUTER_CANDIDATE_VERSION,
    filterRouterCandidates,
} from "../lib/routerCandidates.ts";
import { buildTaskProfile } from "../lib/taskProfileCore.ts";

/**
 * Router Pass 1's hard filters.
 *
 * The tests that matter most are the refusals. A filter that lets too little
 * through produces a worse answer; a filter that lets the wrong thing through
 * produces a request the system cannot bound, a capability the model does not
 * have, or a charge the account cannot pay — and under Auto the user did not
 * choose any of it.
 */

const model = (overrides = {}) => ({
    id: "m-1",
    name: "M1",
    apiModel: "m-1",
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

const base = (overrides = {}) => ({
    models: [model()],
    plan: "Free",
    profile: buildTaskProfile({ text: "hello" }),
    reservedInputTokens: 1_000,
    requestOutputCapTokens: 4_000,
    ...overrides,
});

const reasonFor = (result, modelId) =>
    result.rejected.find((entry) => entry.modelId === modelId)?.reason;

test("a usable model survives with the output room it would have", () => {
    const result = filterRouterCandidates(base());
    assert.equal(result.version, ROUTER_CANDIDATE_VERSION);
    assert.deepEqual(result.eligible, [{ modelId: "m-1", outputTokens: 4_000 }]);
    assert.deepEqual(result.rejected, []);
});

test("every rejection reason is one of the declared identifiers", () => {
    // RoutingRun records these. A reason invented at the call site would be a
    // routing decision nobody can group or count afterwards.
    const result = filterRouterCandidates(
        base({
            models: [
                model({ id: "off", enabled: false }),
                model({ id: "paid", minimumPlan: "Pro" }),
                model({ id: "nowindow", contextWindowTokens: undefined }),
            ],
        })
    );
    for (const entry of result.rejected) {
        assert.ok(
            CANDIDATE_REJECTIONS.includes(entry.reason),
            `undeclared reason: ${entry.reason}`
        );
    }
});

test("Auto refuses a model with no declared context window", () => {
    // The manual path still allows it -- the guard simply does not run. Auto
    // would be choosing an unbounded request on the user's behalf, which is
    // what ESTIMATE-03 forbids at zero tolerance.
    const result = filterRouterCandidates(
        base({ models: [model({ contextWindowTokens: undefined })] })
    );
    assert.deepEqual(result.eligible, []);
    assert.equal(reasonFor(result, "m-1"), "context_window_undeclared");
});

test("a turn with no room left to answer in is refused", () => {
    const result = filterRouterCandidates(
        base({ reservedInputTokens: 100_000 })
    );
    assert.equal(reasonFor(result, "m-1"), "context_exceeded");
});

test("output room is trimmed to what the window leaves", () => {
    // Not a refusal: the model can still answer, just more briefly. Refusing
    // here would reject a turn the provider would have accepted.
    const result = filterRouterCandidates(
        base({ reservedInputTokens: 98_000, requestOutputCapTokens: 4_000 })
    );
    assert.deepEqual(result.eligible, [{ modelId: "m-1", outputTokens: 2_000 }]);
});

test("a request that exactly fills the window is refused, one token less is not", () => {
    // The boundary is a contract, and it is the easy thing to get wrong by one.
    assert.equal(
        reasonFor(filterRouterCandidates(base({ reservedInputTokens: 100_000 })), "m-1"),
        "context_exceeded"
    );
    assert.equal(
        filterRouterCandidates(base({ reservedInputTokens: 99_999 })).eligible[0]
            .outputTokens,
        1
    );
});

test("plan and enablement are checked before anything about the turn", () => {
    const result = filterRouterCandidates(
        base({
            plan: "Guest",
            models: [
                model({ id: "off", enabled: false, minimumPlan: "Pro" }),
                model({ id: "paid", minimumPlan: "Pro" }),
            ],
        })
    );
    // A model reports the first blocking fact, not every way it is unsuitable:
    // "disabled and also too expensive" explains nothing extra.
    assert.equal(reasonFor(result, "off"), "disabled");
    assert.equal(reasonFor(result, "paid"), "plan");
});

test("a model not publicly listed is not an Auto candidate", () => {
    const result = filterRouterCandidates(
        base({ models: [model({ publiclyListed: false })] })
    );
    assert.equal(reasonFor(result, "m-1"), "disabled");
});

test("an image turn refuses a model that cannot read one", () => {
    const profile = buildTaskProfile({
        text: "what is this?",
        attachments: [{ name: "a.png", mediaType: "image/png" }],
    });
    const blind = filterRouterCandidates(base({ profile }));
    assert.equal(reasonFor(blind, "m-1"), "image_input_unsupported");

    const seeing = filterRouterCandidates(
        base({ profile, models: [model({ inputCapabilities: { image: true } })] })
    );
    assert.equal(seeing.eligible.length, 1);
});

test("a turn needing current information refuses a model that cannot search", () => {
    const profile = buildTaskProfile({
        text: "anything",
        webSearchRequested: true,
    });
    // An id the capability register does not carry falls back to unsupported,
    // which is that register's decision and not this filter's to reinterpret.
    const result = filterRouterCandidates(base({ profile }));
    assert.equal(reasonFor(result, "m-1"), "web_search_unsupported");

    const searching = filterRouterCandidates(
        base({ profile, models: [model({ id: "perplexity/sonar" })] })
    );
    assert.equal(searching.eligible.length, 1);
});

test("unverified search support is a refusal, not a maybe", () => {
    // The register marks a model unverified because nobody confirmed it. Auto
    // choosing it would turn an unchecked assumption into a failed answer the
    // account paid for -- so it is refused separately from "confirmed not to
    // support search", which is a different fact worth counting differently.
    const profile = buildTaskProfile({ text: "x", webSearchRequested: true });
    const result = filterRouterCandidates(
        base({ profile, models: [model({ id: "gpt-5-4-mini" })] })
    );
    assert.equal(reasonFor(result, "gpt-5-4-mini"), "web_search_unverified");
});

test("an unbounded search cost is a refusal, and its own one", () => {
    // Gemini's grounding is native and charged per query, and neither the tool
    // nor the request takes a cap -- so the dispatch will attach no tool and
    // the model will answer from training data. Auto picking it for a turn
    // that needs the web is the same failure the two refusals above prevent,
    // reached by cost rather than by capability, which is why it is counted
    // separately: the day Google ships a cap this rejection disappears and the
    // other two do not.
    const profile = buildTaskProfile({ text: "x", webSearchRequested: true });
    const result = filterRouterCandidates(
        base({ profile, models: [model({ id: "gemini-3-6-flash" })] })
    );
    assert.equal(reasonFor(result, "gemini-3-6-flash"), "web_search_cost_unbounded");

    // OpenAI's `max_tool_calls` does bound it, so Luna stays eligible.
    const luna = filterRouterCandidates(
        base({ profile, models: [model({ id: "gpt-5-6-luna" })] })
    );
    assert.equal(luna.eligible.length, 1);
});

test("a turn that needs nothing current does not consult search support", () => {
    const result = filterRouterCandidates(
        base({ profile: buildTaskProfile({ text: "정렬 알고리즘 설명해 줘" }) })
    );
    assert.equal(result.eligible.length, 1);
});

test("health and region are refusals the caller supplies", () => {
    const unhealthy = filterRouterCandidates(
        base({ unhealthyModelIds: ["m-1"] })
    );
    assert.equal(reasonFor(unhealthy, "m-1"), "unhealthy");

    const blocked = filterRouterCandidates(
        base({ regionBlockedModelIds: ["m-1"] })
    );
    assert.equal(reasonFor(blocked, "m-1"), "region_unavailable");
});

test("the credit filter needs both a budget and prices, or it does not run", () => {
    // A budget with no prices would pass every model, which reads as
    // "affordable" when it means "not checked".
    const halfConfigured = filterRouterCandidates(
        base({ availableCredits: 0 })
    );
    assert.equal(halfConfigured.eligible.length, 1);

    const configured = filterRouterCandidates(
        base({ availableCredits: 1, creditsByModelId: { "m-1": 2 } })
    );
    assert.equal(reasonFor(configured, "m-1"), "insufficient_credits");
});

test("an unpriced model is not affordable", () => {
    // Absent is unknown, not free.
    const result = filterRouterCandidates(
        base({ availableCredits: 100, creditsByModelId: {} })
    );
    assert.equal(reasonFor(result, "m-1"), "insufficient_credits");
});

test("a model priced exactly at the remaining balance is affordable", () => {
    const result = filterRouterCandidates(
        base({ availableCredits: 2, creditsByModelId: { "m-1": 2 } })
    );
    assert.equal(result.eligible.length, 1);
});

test("the result carries no request content", () => {
    // Same rule as the task profile: RoutingRun records this, and §2 forbids
    // copying raw prompts into routing telemetry.
    const secret = "myuniquesecrettoken";
    const result = filterRouterCandidates(
        base({
            profile: buildTaskProfile({
                text: `please help with ${secret}`,
                attachments: [{ name: `${secret}.png`, mediaType: "image/png" }],
            }),
        })
    );
    assert.ok(!JSON.stringify(result).includes(secret));
});

test("an empty catalogue produces an empty result rather than throwing", () => {
    const result = filterRouterCandidates(base({ models: [] }));
    assert.deepEqual(result.eligible, []);
    assert.deepEqual(result.rejected, []);
});

test("filtering the same input twice gives the same answer", () => {
    // Shadow-mode comparison rests on this: two passes over the same traffic
    // have to be comparable.
    const input = base({
        models: [model({ id: "a" }), model({ id: "b", minimumPlan: "Pro" })],
    });
    assert.deepEqual(
        filterRouterCandidates(input),
        filterRouterCandidates(input)
    );
});
