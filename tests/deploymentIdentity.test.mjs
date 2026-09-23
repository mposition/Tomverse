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

const at = new Date("2026-09-23T00:00:00.000Z");
const live = [{ effectiveFrom: new Date("2026-01-01T00:00:00.000Z"), effectiveTo: null }];

test("a proven class is not on its own a permission", () => {
    // Three places could answer this question -- the provider registry, the
    // endpoint column, and the approval rows -- and a legal question with
    // three answers has none. The approval is the authority; the class is a
    // summary that can go stale.
    assert.equal(
        endpointMayServeConstrainedTraffic({ residencyClass: "proven", approvals: [], at }),
        false,
        "proven with no live approval is a stale summary, not a permission"
    );
    assert.equal(
        endpointMayServeConstrainedTraffic({ residencyClass: "proven", approvals: live, at }),
        true
    );
});

test("residency fails closed for everything that is not proven", () => {
    for (const value of ["unproven", "", null, undefined, "PROVEN", "probably"]) {
        assert.equal(
            endpointMayServeConstrainedTraffic({ residencyClass: value, approvals: live, at }),
            false,
            String(value)
        );
    }
});

test("an approval outside its window permits nothing", () => {
    const cases = [
        { effectiveFrom: new Date("2026-12-01T00:00:00.000Z"), effectiveTo: null },
        {
            effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
            effectiveTo: new Date("2026-06-01T00:00:00.000Z"),
        },
        // Ends exactly now: a window that closed is closed.
        { effectiveFrom: new Date("2026-01-01T00:00:00.000Z"), effectiveTo: at },
    ];
    for (const approval of cases) {
        assert.equal(
            endpointMayServeConstrainedTraffic({
                residencyClass: "proven",
                approvals: [approval],
                at,
            }),
            false,
            JSON.stringify(approval)
        );
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


test("the approval record is append-only in the database, not only in a comment", () => {
    // An earlier draft said "append-only" in a comment and left nothing
    // stopping an UPDATE. A comment that claims more than the database holds
    // is the sentence somebody quotes when asking whether a past disclosure
    // could have been edited.
    const sql = migration();
    assert.match(sql, /CREATE TRIGGER "endpoint_residency_approval_is_append_only_trigger"/);
    assert.match(sql, /BEFORE UPDATE ON "EndpointResidencyApproval"/);
    assert.match(sql, /CREATE TRIGGER "endpoint_residency_approval_is_not_deletable_trigger"/);
    assert.match(sql, /BEFORE DELETE ON "EndpointResidencyApproval"/);

    // Every field that says what was approved is named in the immutability
    // check. A field left out is a field somebody can change afterwards.
    for (const column of [
        "providerEndpointId",
        "evidenceRef",
        "allowedRecipients",
        "allowedRegions",
        "enforcementMechanism",
        "effectiveFrom",
        "approvedBy",
    ]) {
        assert.match(
            sql,
            new RegExp(`NEW\."${column}" IS DISTINCT FROM OLD\."${column}"`),
            column
        );
    }
});

test("an open approval can be ended exactly once", () => {
    // Wholly immutable would leave a permission nobody could withdraw, which
    // is the opposite of what this record is for. Setting `effectiveTo` once,
    // forward, is the one edit allowed.
    const sql = migration();
    assert.match(
        sql,
        /OLD\."effectiveTo" IS NOT NULL AND NEW\."effectiveTo" IS DISTINCT FROM OLD\."effectiveTo"/
    );
    assert.match(sql, /has already been ended/);
});

test("a passed gate cannot be carried onto a different thing", () => {
    // A gate passes for a particular model version, quantization and set of
    // capabilities. Editing those while enabled keeps the pass and changes
    // what it was about.
    //
    // The trigger is created in the first migration. The function body was
    // replaced when the version gate added the pin, so the columns are read
    // from that replacement. Reading the first file would still pass after
    // the replacement lost a column.
    const sql = migration();
    assert.match(sql, /CREATE TRIGGER "model_deployment_gate_follows_identity_trigger"/);
    const replaced = readFileSync(
        new URL(
            "../prisma/migrations/20260923390000_deployment_version_gate_dark/migration.sql",
            import.meta.url
        ),
        "utf8"
    );
    for (const column of [
        "logicalModelId",
        "providerEndpointId",
        "upstreamDeploymentName",
        "modelVersion",
        "modelRevision",
        "quantization",
        "tokenizerRevision",
        "qualityTier",
        "capabilities",
        "versionPinStrength",
        "allowVersionDrift",
        "qualityBenchmarkVersion",
    ]) {
        assert.match(
            replaced,
            new RegExp(`NEW\\."${column}" IS DISTINCT FROM OLD\\."${column}"`),
            column
        );
    }
});

test("an enabled deployment carries an expiry", () => {
    // Expiry is part of being gated. A gate that expired is evidence that no
    // longer applies, and an enabled row resting on one is an ungated row.
    assert.match(
        migration(),
        /ModelDeployment_enabled_requires_expiry_check[\s\S]*?CHECK \("enabled" = false OR "qualityGateExpiresAt" IS NOT NULL\)/
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
    // deployment. It is also what keeps a person's saved model a product model
    // rather than an infrastructure identifier.
    const sql = migration();
    assert.ok(
        !/FOREIGN KEY \("logicalModelId"\)/.test(sql),
        "logicalModelId must not carry a foreign key"
    );
    assert.match(sql, /ModelDeployment_logicalModelId_enabled_idx/);
    assert.match(schema(), /logicalModelId\s+String/);
});

test("darkness is checked by a gate, not by this test", () => {
    // The first version of this grepped seven named files for
    // `prisma.<delegate>`, which a new route, a cron, `tx.modelDeployment` or
    // raw SQL would all have walked past. `npm run check:dark-tables` reads
    // every runtime source instead; what is asserted here is that the gate
    // exists and knows about all three tables.
    const gate = readFileSync(
        new URL("../scripts/check-dark-tables.mjs", import.meta.url),
        "utf8"
    );
    for (const table of [
        "ModelDeployment",
        "ProviderEndpoint",
        "EndpointResidencyApproval",
    ]) {
        assert.ok(gate.includes(`"${table}"`), `${table} is covered by the gate`);
    }
    const packageJson = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8")
    );
    assert.equal(packageJson.scripts["check:dark-tables"], "node scripts/check-dark-tables.mjs");
});
