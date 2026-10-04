import assert from "node:assert/strict";
import test from "node:test";
import { promptRefinerVnextOneShotDevelopmentSourceFailureCode as sourceFailureCode,
    promptRefinerVnextOneShotDeploymentFailureCode as deploymentFailureCode,
    promptRefinerVnextOneShotPriceFailureCode as priceFailureCode,
    summarizePromptRefinerVnextOneShotDevelopmentReadback as summarize } from
    "../lib/promptRefinerQualityEvaluationVnextOneShotDevelopmentReadback.ts";

const source = { dispatchAuthorized: false };
const deployment = {
    runtimeAndRailwayAgree: true,
    activeDeploymentConfirmed: true,
    problems: [],
};
const price = { pricePinMatchesRegistry: true, problems: [] };

test("matching development reads never authorize a stage, run or dispatch", () => {
    assert.deepEqual(summarize({ source, deployment, price }), {
        developmentSourceVerified: true,
        deploymentVerified: true,
        pricePinMatchesRegistry: true,
        problems: [],
        finalSourceClosureVerified: false,
        reservationVerified: false,
        stageApproved: false,
        runApproved: false,
        dispatchAuthorized: false,
    });
});

test("missing or disagreeing direct reads fail closed without content", () => {
    assert.deepEqual(summarize({
        source: null,
        deployment: { ...deployment, runtimeAndRailwayAgree: false,
            activeDeploymentConfirmed: false, problems: ["railway_commit_mismatch"] },
        price: { ...price, pricePinMatchesRegistry: false,
            problems: ["price_pin_mismatch"] },
    }), {
        developmentSourceVerified: false,
        deploymentVerified: false,
        pricePinMatchesRegistry: false,
        problems: ["development_source_unavailable", "railway_commit_mismatch",
            "price_pin_mismatch"],
        finalSourceClosureVerified: false,
        reservationVerified: false,
        stageApproved: false,
        runApproved: false,
        dispatchAuthorized: false,
    });
    assert.deepEqual(summarize({ source: null, deployment: null, price: null }).problems,
        ["development_source_unavailable", "deployment_read_unavailable", "price_read_unavailable"]);
});

test("source read failure preserves only closed content-free reasons", () => {
    assert.equal(sourceFailureCode(new Error("vnext_one_shot_source_drift")),
        "vnext_one_shot_source_drift");
    assert.equal(sourceFailureCode(new Error("private path H:/holdout")),
        "development_source_unavailable");
    assert.deepEqual(summarize({ source: null,
        sourceProblem: sourceFailureCode(new Error("vnext_one_shot_source_changed")),
        deployment, price }).problems, ["vnext_one_shot_source_changed"]);
});

test("deployment and price read failures preserve only closed content-free reasons", () => {
    assert.equal(deploymentFailureCode(new Error("railway_deployment_unavailable")),
        "railway_deployment_unavailable");
    assert.equal(priceFailureCode(new Error("vnext_one_shot_price_read_failed")),
        "vnext_one_shot_price_read_failed");
    assert.equal(priceFailureCode(new Error("private database details")),
        "price_read_unavailable");
    assert.deepEqual(summarize({ source, deployment: null,
        deploymentProblem: "railway_deployment_unavailable", price: null,
        priceProblem: "vnext_one_shot_price_read_failed" }).problems,
    ["railway_deployment_unavailable", "vnext_one_shot_price_read_failed"]);
});
