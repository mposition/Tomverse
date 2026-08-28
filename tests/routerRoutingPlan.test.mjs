/**
 * The pre-registered independent judge is also an Auto candidate, so the
 * Router can hand it the answers it will later grade.
 *
 * The routing decision is deterministic given the item and the frozen seed, so
 * this is settled for nothing before the first paid call -- and it aborts
 * rather than re-routing, because dropping the judge from the candidate set
 * would measure a Router the product does not have.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
    FALLBACK_EXECUTION_MODE,
    executableCallManifest,
    freezeRoutingPlan,
    maxPlannedAnswerRequestCostUsd,
    routingPlanProblems,
} from "../lib/routerRoutingPlan.ts";
import { PILOT_PER_REQUEST_MAX_COST_USD } from "../lib/routerFableEntry.ts";

const identities = {
    "deepseek-v4-flash": { provider: "deepseek", apiModel: "deepseek-v4-flash" },
    "gpt-5-6-luna": { provider: "openai", apiModel: "gpt-5.6-luna" },
    "claude-fable-5": { provider: "anthropic", apiModel: "claude-fable-5" },
    // A second catalogue row resolving to the same upstream model.
    "claude-fable-5-alias": { provider: "anthropic", apiModel: "claude-fable-5" },
};
const identityOf = (id) => identities[id] ?? null;

const limits = {
    "deepseek-v4-flash": { requestedMaxOutputTokens: 384_000, inputUsdPerMillionTokens: 0.14, outputUsdPerMillionTokens: 0.28 },
    "gpt-5-6-luna": { requestedMaxOutputTokens: 128_000, inputUsdPerMillionTokens: 0.2, outputUsdPerMillionTokens: 1.2 },
    "claude-fable-5": { requestedMaxOutputTokens: 128_000, inputUsdPerMillionTokens: 10, outputUsdPerMillionTokens: 50 },
    "claude-fable-5-alias": { requestedMaxOutputTokens: 128_000, inputUsdPerMillionTokens: 10, outputUsdPerMillionTokens: 50 },
};
const limitFor = (id) => limits[id] ?? null;

const fable = { provider: "anthropic", apiModel: "claude-fable-5", modelId: "claude-fable-5" };

const entries = (count, { selected = "deepseek-v4-flash", alternates = ["gpt-5-6-luna"] } = {}) =>
    Array.from({ length: count }, (_, i) => ({
        itemId: `item-${i}`,
        outcome: "selected",
        selectedModelId: selected,
        rankedAlternatesNonExecutable: alternates,
    }));

const base = {
    expectedItems: 210,
    independentJudge: fable,
    perRequestMaxCostUsd: PILOT_PER_REQUEST_MAX_COST_USD,
    limitFor,
    worstPromptTokens: 209,
};

test("a plan that never reaches the judge is allowed to run", () => {
    const plan = freezeRoutingPlan(entries(210), "gpt-5-6-luna", identityOf);
    assert.deepEqual(routingPlanProblems(plan, base), []);
    assert.equal(plan.plannedItems, 210);
});

test("the judge selected as an answer author stops the run", () => {
    const plan = freezeRoutingPlan(entries(210, { selected: "claude-fable-5" }), "gpt-5-6-luna", identityOf);
    const problems = routingPlanProblems(plan, base);
    const conflict = problems.find((p) => /pre-registered independent judge/.test(p));
    assert.ok(conflict, "the conflict is reported");
    assert.match(conflict, /answer author on 210 item\(s\)/);
    assert.match(conflict, /re-routing without it would measure a Router the product does not have/);
    // It also breaches the per-request ceiling at $6.40 a call, which is a
    // separate finding and stays separate.
    assert.ok(problems.some((p) => /per-request ceiling/.test(p)));
});

test("a model the run will never call is not an answer author", () => {
    // mposition's correction. This harness calls only the model it selected --
    // a failed answer is recorded and the pair excluded, never retried down
    // the ranking -- so the judge sitting in the ranking is not a conflict.
    // The first version of this refused the run on exactly that, and would
    // have blocked ROUTE-01 permanently: claude-fable-5 and claude-opus-4-8
    // are both ranked on all 210 items.
    const plan = freezeRoutingPlan(
        entries(210, { alternates: ["gpt-5-6-luna", "claude-fable-5"] }),
        "gpt-5-6-luna",
        identityOf
    );
    assert.deepEqual(routingPlanProblems(plan, base), []);
    // Recorded, though, and named for what it is.
    assert.ok(plan.entries[0].rankedAlternatesNonExecutable.includes("claude-fable-5"));
    assert.ok(!plan.executableAnswerAuthors.some((a) => a.modelId === "claude-fable-5"));
});

test("the scoping is one constant, so a future fallback path widens it", () => {
    assert.equal(FALLBACK_EXECUTION_MODE, "none");
    const plan = freezeRoutingPlan(entries(210), "gpt-5-6-luna", identityOf);
    assert.equal(plan.fallbackExecutionMode, "none");
    // A plan frozen under a different execution mode describes a run where a
    // different set of models could answer, so it is refused rather than read.
    const stale = { ...plan, fallbackExecutionMode: "ranked" };
    assert.match(routingPlanProblems(stale, base)[0], /which models can answer has changed/);
});

test("the catalogue snapshot is kept apart from the executable manifest", () => {
    // One answers "what could the Router have picked", the other "what will
    // this run call". Pricing the first is what wrongly raised a ceiling.
    const plan = freezeRoutingPlan(
        entries(210, { alternates: ["claude-fable-5"] }),
        "gpt-5-6-luna",
        identityOf,
        ["deepseek-v4-flash", "gpt-5-6-luna", "claude-fable-5"]
    );
    assert.equal(plan.catalogueCapabilitySnapshot.length, 3);
    assert.deepEqual(
        executableCallManifest(plan).map((row) => row.modelId).sort(),
        ["deepseek-v4-flash", "gpt-5-6-luna"]
    );
    // The expensive ranked model is in the snapshot and out of the cost bound.
    assert.ok(maxPlannedAnswerRequestCostUsd(plan, limitFor, 209) < 0.2);
});

test("the judge as baseline stops it as well", () => {
    const plan = freezeRoutingPlan(entries(210), "claude-fable-5", identityOf);
    assert.match(routingPlanProblems(plan, base)[0], /the baseline on 210/);
});

test("the conflict is on the upstream model, not the catalogue id", () => {
    // Two catalogue rows can resolve to one upstream model, and it is the
    // upstream model that would be grading its own answer.
    const plan = freezeRoutingPlan(
        entries(210, { selected: "claude-fable-5-alias" }),
        "gpt-5-6-luna",
        identityOf
    );
    const conflict = routingPlanProblems(plan, base).find((p) =>
        /pre-registered independent judge/.test(p)
    );
    assert.ok(conflict, "the alias is caught");
    assert.match(conflict, /claude-fable-5-alias resolves to anthropic\/claude-fable-5/);
});

test("a plan for a different number of items is not a plan for this run", () => {
    const plan = freezeRoutingPlan(entries(150), "gpt-5-6-luna", identityOf);
    assert.match(routingPlanProblems(plan, base)[0], /covers 150 item\(s\), not the 210/);
});

test("an empty plan is refused rather than read as clean", () => {
    const plan = freezeRoutingPlan([], "gpt-5-6-luna", identityOf);
    const problems = routingPlanProblems(plan, base);
    assert.ok(problems.some((p) => /the routing plan is empty/.test(p)));
});

test("the worst request the plan can produce is bounded before dispatch", () => {
    // deepseek at 384,000 output x $0.28/M = $0.1075; luna at 128,000 x $1.20/M
    // = $0.1536. Both well under the ceiling.
    const plan = freezeRoutingPlan(entries(210), "gpt-5-6-luna", identityOf);
    const worst = maxPlannedAnswerRequestCostUsd(plan, limitFor, 209);
    assert.ok(worst < PILOT_PER_REQUEST_MAX_COST_USD);
    assert.deepEqual(routingPlanProblems(plan, base), []);

    // A $6.40 fable answer breaches a tighter ceiling, and the ceiling cannot
    // be enforced between calls.
    const withFable = freezeRoutingPlan(
        entries(210, { selected: "claude-fable-5" }),
        "gpt-5-6-luna",
        identityOf
    );
    const problems = routingPlanProblems(withFable, { ...base, perRequestMaxCostUsd: 0.5 });
    assert.ok(problems.some((p) => /over the \$0\.50 per-request ceiling/.test(p)));
});

test("a planned model with no resolved limit is named, not skipped", () => {
    const plan = freezeRoutingPlan(
        entries(210, { selected: "a-model-nobody-priced" }),
        "gpt-5-6-luna",
        identityOf
    );
    const problems = routingPlanProblems(plan, base);
    // Once, not 210 times: it is one finding about one model.
    const unpriced = problems.filter((p) => /a-model-nobody-priced/.test(p));
    assert.equal(unpriced.length, 1);
    assert.match(unpriced[0], /has no resolved call limit, so what it could cost is unknown/);
});
