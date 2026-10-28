import assert from "node:assert/strict";
import test from "node:test";
import { observePromptRefinerVnextOneShotDeployment } from
    "../lib/promptRefinerQualityEvaluationVnextOneShotDeploymentReadback.ts";

const deploymentId = "12345678-1234-1234-1234-123456789abc";
const projectId = "22345678-1234-1234-1234-123456789abc";
const serviceId = "32345678-1234-1234-1234-123456789abc";
const environmentId = "42345678-1234-1234-1234-123456789abc";
const commitSha = "a".repeat(40);
const environment = {
    RAILWAY_ENVIRONMENT_NAME: "staging",
    RAILWAY_DEPLOYMENT_ID: deploymentId,
    RAILWAY_GIT_COMMIT_SHA: commitSha,
    RAILWAY_PROJECT_ID: projectId,
    RAILWAY_SERVICE_ID: serviceId,
    RAILWAY_ENVIRONMENT_ID: environmentId,
    RAILWAY_API_TOKEN: "test-token-not-a-secret",
};
const response = (deployment, errors, active = { id: deploymentId, status: "SUCCESS" }) => ({
    ok: true,
    json: async () => ({
        data: { deployment, deployments: { edges: active ? [{ node: active }] : [] } },
        ...(errors ? { errors } : {}),
    }),
});

test("reads the exact deployment from Railway without granting admission", async () => {
    const result = await observePromptRefinerVnextOneShotDeployment({
        environment,
        fetchImpl: async (url, init) => {
            assert.equal(url, "https://backboard.railway.com/graphql/v2");
            assert.equal(init.method, "POST");
            assert.equal(init.cache, "no-store");
            assert.equal(init.redirect, "error");
            assert.ok(init.signal instanceof AbortSignal);
            assert.deepEqual(JSON.parse(init.body).variables, {
                id: deploymentId,
                input: {
                    projectId, serviceId, environmentId,
                    status: { in: ["SUCCESS"] },
                },
            });
            return response({ id: deploymentId, status: "SUCCESS", meta: { commitHash: commitSha } });
        },
    });
    assert.deepEqual(result, {
        deploymentId, commitSha, runtimeAndRailwayAgree: true,
        activeDeploymentConfirmed: true, stageApprovalMatched: false,
        dispatchAuthorized: false, problems: [],
    });
    assert.equal(JSON.stringify(result).includes(environment.RAILWAY_API_TOKEN), false);
});

test("Railway lookup arms a five-second timeout signal", async () => {
    const originalTimeout = AbortSignal.timeout;
    let timeoutCalls = 0;
    AbortSignal.timeout = (milliseconds) => {
        assert.equal(milliseconds, 5_000);
        timeoutCalls += 1;
        return originalTimeout.call(AbortSignal, 1);
    };
    try {
        const result = await observePromptRefinerVnextOneShotDeployment({
            environment,
            fetchImpl: async (_url, init) => {
                await new Promise((resolve, reject) => {
                    const guard = setTimeout(() => reject(new Error("abort not observed")), 500);
                    init.signal.addEventListener("abort", () => {
                        clearTimeout(guard);
                        resolve();
                    }, { once: true });
                });
                assert.equal(init.signal.reason?.name, "TimeoutError");
                return response({ id: deploymentId, status: "SUCCESS", meta: { commitHash: commitSha } });
            },
        });
        assert.equal(timeoutCalls, 1);
        assert.equal(result.runtimeAndRailwayAgree, true);
    } finally {
        AbortSignal.timeout = originalTimeout;
    }
});

test("missing runtime identity or credentials stops before a network request", async () => {
    for (const [changed, expectedProblem] of [
        [{ RAILWAY_DEPLOYMENT_ID: "" }, "runtime_identity_unavailable"],
        [{ RAILWAY_GIT_COMMIT_SHA: "short" }, "runtime_identity_unavailable"],
        [{ RAILWAY_PROJECT_ID: "" }, "runtime_identity_unavailable"],
        [{ RAILWAY_SERVICE_ID: "" }, "runtime_identity_unavailable"],
        [{ RAILWAY_ENVIRONMENT_ID: "" }, "runtime_identity_unavailable"],
        [{ RAILWAY_ENVIRONMENT_NAME: "production" }, "runtime_environment_not_staging"],
        [{ RAILWAY_ENVIRONMENT_NAME: "staging", APP_ENV: "production" }, "runtime_environment_not_staging"],
        [{ RAILWAY_API_TOKEN: "" }, "railway_read_credentials_unavailable"],
    ]) {
        let fetchCalls = 0;
        const result = await observePromptRefinerVnextOneShotDeployment({
            environment: { ...environment, ...changed },
            fetchImpl: async () => {
                fetchCalls += 1;
                throw new Error("must not fetch");
            },
        });
        assert.equal(fetchCalls, 0);
        assert.equal(result.runtimeAndRailwayAgree, false);
        assert.equal(result.dispatchAuthorized, false);
        assert.deepEqual(result.problems, [expectedProblem]);
    }
});

test("a conflicting app environment has its own refusal code", async () => {
    const result = await observePromptRefinerVnextOneShotDeployment({
        environment: { ...environment, APP_ENV: "production" },
        fetchImpl: async () => { throw new Error("must not fetch"); },
    });
    assert.deepEqual(result.problems, ["runtime_environment_not_staging"]);
});

test("canonical environment labels are accepted only when the app resolver agrees", async () => {
    const result = await observePromptRefinerVnextOneShotDeployment({
        environment: { ...environment, RAILWAY_ENVIRONMENT_NAME: " StAgInG ", APP_ENV: "staging" },
        fetchImpl: async () => response({
            id: deploymentId, status: "SUCCESS", meta: { commitHash: commitSha },
        }),
    });
    assert.equal(result.runtimeAndRailwayAgree, true);
    assert.equal(result.dispatchAuthorized, false);
});

test("pending, replaced, mismatched and malformed remote facts fail closed", async () => {
    for (const [remote, expectedProblems] of [
        [response({ id: deploymentId, status: "WAITING", meta: { commitHash: commitSha } }),
            ["railway_deployment_not_success"]],
        [response({ id: deploymentId, status: "SUCCESS", meta: { commitHash: "b".repeat(40) } }),
            ["railway_commit_mismatch"]],
        [response({ id: deploymentId, status: "WAITING", meta: { commitHash: "b".repeat(40) } }),
            ["railway_commit_mismatch", "railway_deployment_not_success"]],
        [response({ id: "other", status: "SUCCESS", meta: { commitHash: commitSha } }),
            ["railway_deployment_unavailable"]],
        [response({ id: deploymentId, status: "SUCCESS", meta: {} }),
            ["railway_deployment_unavailable"]],
        [response({ id: deploymentId, status: "SUCCESS", meta: { commitHash: commitSha } }, [{}]),
            ["railway_deployment_unavailable"]],
        [response({ id: deploymentId, status: "SUCCESS", meta: { commitHash: commitSha } },
            null, { id: "52345678-1234-1234-1234-123456789abc", status: "SUCCESS" }),
            ["railway_active_deployment_mismatch"]],
        [response({ id: deploymentId, status: "SUCCESS", meta: { commitHash: commitSha } },
            null, null), ["railway_active_deployment_unavailable"]],
        [response({ id: deploymentId, status: "SUCCESS", meta: { commitHash: commitSha } },
            null, { id: "not-a-uuid", status: "SUCCESS" }),
            ["railway_active_deployment_unavailable"]],
        [response({ id: deploymentId, status: "SUCCESS", meta: { commitHash: commitSha } },
            null, { id: deploymentId, status: "REMOVED" }),
            ["railway_active_deployment_unavailable"]],
        [{ ok: true, json: async () => ({ data: {
            deployment: { id: deploymentId, status: "SUCCESS", meta: { commitHash: commitSha } },
        } }) }, ["railway_active_deployment_unavailable"]],
    ]) {
        const result = await observePromptRefinerVnextOneShotDeployment({
            environment, fetchImpl: async () => remote,
        });
        assert.equal(result.runtimeAndRailwayAgree, false);
        assert.equal(result.dispatchAuthorized, false);
        assert.deepEqual(result.problems, expectedProblems);
    }
});

test("Railway HTTP and network failures do not expose upstream error text", async () => {
    for (const fetchImpl of [
        async () => ({ ok: false }),
        async () => { throw new Error("upstream sensitive failure text"); },
    ]) {
        const result = await observePromptRefinerVnextOneShotDeployment({ environment, fetchImpl });
        assert.deepEqual(result.problems, ["railway_deployment_unavailable"]);
        assert.equal(JSON.stringify(result).includes("sensitive"), false);
    }
});
