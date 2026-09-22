import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    DEPLOYMENT_QUALITY_GATE_STATUSES,
    ENDPOINT_RESIDENCY_CLASSES,
    deploymentMayBeEnabled,
    endpointMayServeConstrainedTraffic,
} from "../lib/deploymentIdentity.ts";

/**
 * The deployment identity tables, which are dark.
 *
 * What these hold is that "dark" stays true -- nothing in the running product
 * reads them yet -- and that the two rules the database enforces are the same
 * two the application would apply before writing: an endpoint carries
 * constrained traffic only when its destination is proven, and a deployment is
 * enabled only when its own gate passed.
 */

const migration = () =>
    readFileSync(
        new URL(
            "../prisma/migrations/20260923120000_deployment_identity_dark/migration.sql",
            import.meta.url
        ),
        "utf8"
    );

const schema = () =>
    readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

test("residency fails closed for everything that is not proven", () => {
    assert.equal(endpointMayServeConstrainedTraffic("proven"), true);
    for (const value of ["unproven", "", null, undefined, "PROVEN", "probably"]) {
        assert.equal(endpointMayServeConstrainedTraffic(value), false, String(value));
    }
});

test("there is no third residency value for probably", () => {
    // A middle value would be read as a yes by whoever needed one.
    assert.deepEqual([...ENDPOINT_RESIDENCY_CLASSES], ["proven", "unproven"]);
});

test("a deployment is enabled only on its own passed gate", () => {
    assert.equal(deploymentMayBeEnabled("passed"), true);
    for (const status of DEPLOYMENT_QUALITY_GATE_STATUSES) {
        if (status === "passed") continue;
        assert.equal(deploymentMayBeEnabled(status), false, status);
    }
});

test("stale is its own status, not a kind of failure", () => {
    // Evidence that expired is not evidence the model got worse.
    assert.ok(DEPLOYMENT_QUALITY_GATE_STATUSES.includes("stale"));
    assert.ok(DEPLOYMENT_QUALITY_GATE_STATUSES.includes("failed"));
    assert.notEqual("stale", "failed");
});

test("the database holds the same two rules", () => {
    const sql = migration();
    // Written out rather than matched loosely: these two CHECKs are the ones
    // an operator could otherwise break with a single UPDATE.
    assert.match(
        sql,
        /ModelDeployment_enabled_requires_gate_check[\s\S]*?CHECK \("enabled" = false OR "qualityGateStatus" = 'passed'\)/
    );
    assert.match(
        sql,
        /ProviderEndpoint_residencyClass_check[\s\S]*?CHECK \("residencyClass" IN \('proven', 'unproven'\)\)/
    );
    // An approval that permits nothing would read as "no restriction" to
    // anything that iterated it.
    assert.match(sql, /jsonb_array_length\("allowedRecipients"\) > 0/);
    assert.match(sql, /jsonb_array_length\("allowedRegions"\) > 0/);
    // A window that ends before it starts permits nothing while looking valid.
    assert.match(sql, /"effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom"/);
});

test("an approval cannot be reassigned or deleted out from under a request", () => {
    // RESTRICT rather than CASCADE: the record answers what was allowed when a
    // request ran, and an endpoint being tidied up must not remove the answer.
    const sql = migration();
    assert.match(
        sql,
        /EndpointResidencyApproval_providerEndpointId_fkey[\s\S]*?ON DELETE RESTRICT ON UPDATE RESTRICT/
    );
    assert.match(
        sql,
        /ModelDeployment_providerEndpointId_fkey[\s\S]*?ON DELETE RESTRICT ON UPDATE RESTRICT/
    );
});

test("nothing is switched on by omission", () => {
    const sql = migration();
    assert.match(sql, /"enabled" BOOLEAN NOT NULL DEFAULT false/);
    assert.match(sql, /"residencyClass" TEXT NOT NULL DEFAULT 'unproven'/);
    assert.match(sql, /"qualityGateStatus" TEXT NOT NULL DEFAULT 'pending'/);
});

test("a logical model id is not a foreign key", () => {
    // The catalogue is partly static, and a registry edit must not delete a
    // deployment. It is also what keeps a user's saved model a product model
    // rather than an infrastructure identifier.
    const sql = migration();
    assert.ok(
        !/FOREIGN KEY \("logicalModelId"\)/.test(sql),
        "logicalModelId must not carry a foreign key"
    );
    // It is indexed, which is a different thing: the lookup is by model.
    assert.match(sql, /ModelDeployment_logicalModelId_enabled_idx/);
    assert.match(schema(), /logicalModelId\s+String/);
});

test("the identity tables are dark", () => {
    // The claim the commit makes: nothing routes from these yet. When that
    // stops being true, this test is the thing that has to be updated
    // deliberately rather than a fact nobody noticed changing.
    const models = ["providerEndpoint", "modelDeployment", "endpointResidencyApproval"];
    const readers = [
        "lib/routerCandidates.ts",
        "lib/routerSelection.ts",
        "lib/routerDecision.ts",
        "lib/routerRuntimeSignals.ts",
        "lib/routingShadow.ts",
        "lib/routingAttemptStore.ts",
        "app/api/chat/route.ts",
    ];
    for (const reader of readers) {
        const source = readFileSync(new URL(`../${reader}`, import.meta.url), "utf8");
        for (const model of models) {
            assert.ok(
                !source.includes(`prisma.${model}`),
                `${reader} reads ${model}; the identity tables are supposed to be dark`
            );
        }
    }
});
