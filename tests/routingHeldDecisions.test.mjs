import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    BYOK_COST_POSTURE,
    DECISION_GRAIN_CUTOVER,
    LOAD_GUARD_STAYS_ARMED_WITHOUT_SOFTMAX,
    SOFTMAX_TEMPERATURE,
    admitCanaryExecution,
    applyPriceSnapshot,
    assessDeploymentEquivalence,
    assessFallbackConnection,
    bindRequestVersion,
    byokFailurePosture,
    deploymentEvidence,
    distributionCandidate,
    interpretObservationMode,
    interpretProviderProbe,
    recordDeploymentPrice,
    softmaxConfigured,
} from "../lib/routingHeldDecisions.ts";

const rehearsal = {
    productionTraffic: false,
    userTraffic: false,
    environmentName: "staging",
    experimentScope: "one deployment, synthetic",
    stopCondition: "first provider error",
    callsProvider: false,
    costCeiling: null,
};

test("a provider probe does not prove another deployment", () => {
    const reading = interpretProviderProbe({
        succeeded: true,
        sameProvider: true,
        probeDeploymentId: "dep_probe",
        subjectDeploymentId: "dep_other",
    });
    assert.equal(reading.deploymentProven, false);
    assert.equal(reading.connectivityHint, true);
    assert.equal(interpretObservationMode("shadow").spent, false);
    assert.equal(interpretObservationMode("shadow").observedProviderReality, false);
    assert.equal(interpretObservationMode("replicated_call").spent, true);
    assert.equal(interpretObservationMode("replicated_call").sharedCacheMayDistort, true);
});

test("canary execution accepts a named non-production rehearsal and refuses traffic", () => {
    assert.equal(admitCanaryExecution(rehearsal).admitted, true);
    assert.equal(admitCanaryExecution(rehearsal).productionWeightChange, false);
    assert.equal(admitCanaryExecution({ ...rehearsal, productionTraffic: true }).reason, "production_traffic");
    assert.equal(admitCanaryExecution({ ...rehearsal, userTraffic: true }).reason, "user_traffic");
    assert.equal(admitCanaryExecution({ ...rehearsal, environmentName: "production" }).reason, "production_environment");
    assert.equal(admitCanaryExecution({ ...rehearsal, environmentName: "PRODUCTION" }).reason, "production_environment");
    assert.equal(admitCanaryExecution({ ...rehearsal, environmentName: "  " }).reason, "unnamed_environment");
    assert.equal(admitCanaryExecution({ ...rehearsal, experimentScope: "  " }).reason, "unnamed_scope");
    assert.equal(admitCanaryExecution({ ...rehearsal, stopCondition: "" }).reason, "unnamed_stop");
    for (const costCeiling of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(
            admitCanaryExecution({ ...rehearsal, callsProvider: true, costCeiling }).reason,
            "missing_cost_ceiling"
        );
    }
    assert.equal(
        admitCanaryExecution({ ...rehearsal, callsProvider: true, costCeiling: 1 }).admitted,
        true
    );
});

test("BYOK stays inactive and does not move the bill", () => {
    assert.equal(BYOK_COST_POSTURE, "inactive");
    assert.deepEqual(byokFailurePosture(), {
        posture: "inactive",
        switchBillingOwner: false,
        chargeManagedKeyAsUserCredit: false,
    });
});

test("softmax stays unset and zero is not a configured temperature", () => {
    assert.equal(SOFTMAX_TEMPERATURE, null);
    assert.equal(LOAD_GUARD_STAYS_ARMED_WITHOUT_SOFTMAX, true);
    assert.equal(softmaxConfigured(null), false);
    assert.equal(softmaxConfigured(0), false);
    assert.equal(distributionCandidate({ passedHardGates: false }).eligible, false);
    assert.equal(distributionCandidate({ passedHardGates: true }).eligible, true);
    assert.equal(distributionCandidate({ passedHardGates: "yes" }).eligible, false);
});

test("an unknown price is not stored as zero and a snapshot is not applied", () => {
    assert.equal(
        recordDeploymentPrice({
            knowledge: "unknown",
            amount: 0,
            currency: null,
            source: null,
            effectiveAt: null,
        }).reason,
        "unknown_has_amount"
    );
    const recorded = recordDeploymentPrice({
        knowledge: "unknown",
        amount: null,
        currency: null,
        source: null,
        effectiveAt: null,
    });
    assert.equal(recorded.recorded, true);
    assert.equal(recorded.appliedToRouting, false);
    assert.equal(recorded.appliedToBilling, false);
    const statedZero = recordDeploymentPrice({
        knowledge: "estimate",
        amount: 0,
        currency: "USD",
        source: "provider-card",
        effectiveAt: "2026-09-24T00:00:00.000Z",
    });
    assert.equal(statedZero.recorded, true);
    assert.equal(statedZero.appliedToBilling, false);
    assert.equal(
        recordDeploymentPrice({
            knowledge: "verified",
            amount: 12,
            currency: " ",
            source: "invoice",
            effectiveAt: "2026-09-24T00:00:00.000Z",
        }).reason,
        "incomplete_known_price"
    );
    assert.equal(
        recordDeploymentPrice({
            knowledge: "list_price",
            amount: 12,
            currency: "USD",
            source: "public-page",
            effectiveAt: "2026-09-24T00:00:00.000Z",
        }).reason,
        "unrecognized_knowledge"
    );
    assert.deepEqual(applyPriceSnapshot(), { applied: false, reason: "behavior_change_unapproved" });
});

test("a missing deployment sample does not borrow probe health", () => {
    assert.equal(DECISION_GRAIN_CUTOVER, "held");
    assert.deepEqual(deploymentEvidence({ observationCount: 0, probeSucceeded: true }), {
        status: "insufficient",
        usedProbe: false,
    });
    assert.equal(deploymentEvidence({ observationCount: 3, probeSucceeded: false }).usedProbe, false);
    assert.deepEqual(deploymentEvidence({ observationCount: 3, probeSucceeded: "yes" }), {
        status: "observed",
        usedProbe: false,
    });
    assert.equal(
        bindRequestVersion({ inFlight: true, startedVersion: null, approvedVersion: "v2" }).reason,
        "missing_version"
    );
    assert.equal(
        bindRequestVersion({ inFlight: true, startedVersion: "v1", approvedVersion: "v2" }).version,
        "v1"
    );
    assert.equal(
        bindRequestVersion({ inFlight: false, startedVersion: "v1", approvedVersion: "v2" }).version,
        "v2"
    );
});

test("the fallback connection counts inner retries and stays unwired", () => {
    const plan = {
        tomverseDispatches: 2,
        attemptsInsideEachDispatch: 1,
        userVisibleCommit: false,
        externalSideEffect: false,
        sideEffectSafetyConfirmed: false,
        targetPassedGates: true,
        pinOrBillingOwnerChanged: false,
    };
    const allowed = assessFallbackConnection(plan);
    assert.equal(allowed.permitted, true);
    assert.equal(allowed.providerAttempts, 2);
    assert.equal(allowed.liveActivation, false);
    assert.equal(assessFallbackConnection({ ...plan, attemptsInsideEachDispatch: 2 }).reason, "provider_budget_exceeded");
    assert.equal(assessFallbackConnection({ ...plan, attemptsInsideEachDispatch: null }).reason, "unknown_sdk_retries");
    assert.equal(
        assessFallbackConnection({ ...plan, attemptsInsideEachDispatch: undefined }).reason,
        "unknown_sdk_retries"
    );
    for (const tomverseDispatches of [0, -1, 1.5]) {
        assert.equal(
            assessFallbackConnection({ ...plan, tomverseDispatches }).reason,
            "invalid_attempt_count"
        );
    }
    assert.equal(assessFallbackConnection({ ...plan, attemptsInsideEachDispatch: 0 }).reason, "invalid_attempt_count");
    assert.equal(assessFallbackConnection({ ...plan, userVisibleCommit: true }).reason, "after_visible_commit");
    assert.equal(
        assessFallbackConnection({ ...plan, externalSideEffect: true, sideEffectSafetyConfirmed: false }).reason,
        "side_effect_unconfirmed"
    );
    assert.equal(assessFallbackConnection({ ...plan, targetPassedGates: false }).reason, "target_unverified");
    assert.equal(assessFallbackConnection({ ...plan, pinOrBillingOwnerChanged: true }).reason, "silent_owner_change");
    const confirmed = assessFallbackConnection({
        ...plan,
        externalSideEffect: true,
        sideEffectSafetyConfirmed: true,
    });
    assert.equal(confirmed.permitted, true);
    assert.equal(confirmed.liveActivation, false);
});

test("a shared model name is not an equivalence class", () => {
    const pair = assessDeploymentEquivalence({
        logicalModelId: "deepseek-v4-pro",
        deploymentIds: ["dep_a", "dep_b"],
        providerAttestationId: null,
        tomverseEvaluationId: null,
    });
    assert.equal(pair.status, "unverified");
    assert.equal(pair.automaticRouting, false);
    const evidenced = assessDeploymentEquivalence({
        logicalModelId: "deepseek-v4-pro",
        deploymentIds: ["dep_a", "dep_b"],
        providerAttestationId: "attest_1",
        tomverseEvaluationId: "eval_1",
    });
    assert.equal(evidenced.status, "evidenced");
    assert.equal(evidenced.automaticRouting, false);
    assert.equal(
        assessDeploymentEquivalence({
            logicalModelId: "deepseek-v4-pro",
            deploymentIds: ["dep_a", "dep_b"],
            providerAttestationId: "attest_1",
            tomverseEvaluationId: null,
        }).reason,
        "missing_evidence"
    );
    assert.equal(
        assessDeploymentEquivalence({
            logicalModelId: "deepseek-v4-pro",
            deploymentIds: ["dep_a", "dep_b", ""],
            providerAttestationId: "attest_1",
            tomverseEvaluationId: "eval_1",
        }).reason,
        "scope"
    );
    assert.equal(
        assessDeploymentEquivalence({
            logicalModelId: "deepseek-v4-pro",
            deploymentIds: ["dep_a", "dep_a"],
            providerAttestationId: "attest_1",
            tomverseEvaluationId: "eval_1",
        }).reason,
        "scope"
    );
});

test("the request path does not import the held decisions", () => {
    const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
    const heldDecisions = join(repository, "lib", "routingHeldDecisions.ts");
    assert.equal(existsSync(heldDecisions), true);
    const hits = [];
    const walk = (directory) => {
        if (!existsSync(directory)) return;
        for (const name of readdirSync(directory)) {
            const path = join(directory, name);
            if (statSync(path).isDirectory()) {
                if (name === "node_modules" || name === ".next") continue;
                walk(path);
                continue;
            }
            if (!/\.(?:ts|tsx|mjs|js)$/.test(name)) continue;
            if (path === heldDecisions) continue;
            const text = readFileSync(path, "utf8");
            if (text.includes("routingHeldDecisions")) hits.push(path);
        }
    };
    for (const root of ["app", "lib", "components", "packages", "apps"]) walk(join(repository, root));
    assert.deepEqual(hits, []);
});
