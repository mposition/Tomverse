import assert from "node:assert/strict";
import test from "node:test";

import { listPinnedExperiments } from "../lib/pinnedDeploymentBudget.ts";
import {
    approvedLiveClaim,
    parsePinnedExecutionLimit,
    PINNED_EXECUTION_APPROVED_LIMIT_MICRO_USD,
    PINNED_EXECUTION_APPROVED_TARGET,
    pinnedExecutionProblems,
} from "../lib/pinnedDeploymentOperator.ts";
import { findLivePlacement } from "../lib/pinnedDeploymentPlacement.ts";

const ready = {
    apply: false,
    approved: false,
    limitMicroUsd: PINNED_EXECUTION_APPROVED_LIMIT_MICRO_USD,
    target: PINNED_EXECUTION_APPROVED_TARGET,
    accountId: "account_internal",
    ci: false,
    lifecycleEvent: null,
    railwayDeployment: false,
};

test("the approved ceiling is one dollar and any other amount is refused", () => {
    assert.equal(PINNED_EXECUTION_APPROVED_LIMIT_MICRO_USD, 1_000_000);
    assert.equal(parsePinnedExecutionLimit("1000000"), 1_000_000);
    assert.equal(parsePinnedExecutionLimit(null), null);
    assert.equal(parsePinnedExecutionLimit("5000000"), 5_000_000);
    assert.equal(parsePinnedExecutionLimit("1_000_000"), null);
    assert.deepEqual(pinnedExecutionProblems(ready), []);
    assert.equal(
        pinnedExecutionProblems({ ...ready, limitMicroUsd: null }).some((problem) => problem.code === "limit"),
        true
    );
    assert.equal(
        pinnedExecutionProblems({ ...ready, limitMicroUsd: 5_000_000 }).some((problem) => problem.code === "limit"),
        true
    );
    assert.equal(
        pinnedExecutionProblems({ ...ready, target: "staging" }).some((problem) => problem.code === "target"),
        true
    );
    assert.equal(
        pinnedExecutionProblems({ ...ready, accountId: " account_internal" }).some((problem) => problem.code === "account"),
        true
    );
});

test("a write needs the approval flag and refuses an automated context", () => {
    const applying = { ...ready, apply: true, approved: true };
    assert.deepEqual(pinnedExecutionProblems(applying), []);
    assert.equal(
        pinnedExecutionProblems({ ...applying, approved: false }).some((problem) => problem.code === "approval"),
        true
    );
    assert.equal(
        pinnedExecutionProblems({ ...applying, ci: true }).some((problem) => problem.code === "automated"),
        true
    );
    assert.equal(
        pinnedExecutionProblems({ ...applying, lifecycleEvent: "db:migrate" }).some((problem) => problem.code === "automated"),
        true
    );
    assert.equal(
        pinnedExecutionProblems({ ...applying, railwayDeployment: true }).some((problem) => problem.code === "automated"),
        true
    );
});

test("the live claim is Luna on the OpenAI client, and an existing row is reused", async () => {
    const claim = approvedLiveClaim();
    assert.equal(claim.logicalModelId, "gpt-5-6-luna");
    assert.equal(claim.gatewayProvider, "openai");
    assert.equal(claim.servingProvider, "openai");
    assert.equal(claim.endpointUrl, "https://api.openai.com/v1");
    assert.equal(claim.upstreamDeploymentName, "gpt-5.6-luna");
    const found = await findLivePlacement({
        providerEndpoint: {
            findMany: async () => [{ id: "endpoint_from_db" }],
        },
        modelDeployment: {
            findFirst: async (args) => {
                assert.equal(args.where.providerEndpointId, "endpoint_from_db");
                assert.equal(args.where.logicalModelId, "gpt-5-6-luna");
                assert.equal(args.where.upstreamDeploymentName, "gpt-5.6-luna");
                return { id: "deployment_from_db" };
            },
        },
    }, claim);
    assert.equal(found.ok, true);
    assert.equal(found.deploymentId, "deployment_from_db");

    const listed = await listPinnedExperiments({
        $queryRaw: async () => [{ id: "experiment_from_db", limitMicroUsd: 1_000_000n }],
    });
    assert.deepEqual(listed, [{ id: "experiment_from_db", limitMicroUsd: 1_000_000 }]);
});
