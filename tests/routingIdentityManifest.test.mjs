import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    MANIFEST_DIGEST_FIELDS,
    manifestDigest,
    manifestProblems,
} from "../lib/routingIdentityManifest.ts";

/**
 * One published snapshot of the routing identity configuration.
 *
 * What these hold is that a published version keeps meaning what it meant: the
 * digest covers a written-down field list in a written-down encoding, the row
 * cannot be edited, and a decision that names a version also records what that
 * version held.
 */

const migration = () =>
    readFileSync(
        new URL(
            "../prisma/migrations/20260923300000_routing_identity_manifest_dark/migration.sql",
            import.meta.url
        ),
        "utf8"
    );

const entry = (overrides = {}) => ({
    modelDeploymentId: "dep_1",
    providerEndpointId: "end_1",
    logicalModelId: "gpt-5-6-luna",
    upstreamDeploymentName: "luna-prod",
    modelVersion: "2026-09-01",
    endpointResidencyClass: "unknown",
    residencyApprovalVersion: null,
    qualityGateStatus: "pending",
    enabled: true,
    ...overrides,
});

const manifest = (entries, overrides = {}) => ({
    version: 1,
    digest: manifestDigest(entries),
    entries,
    approvedBy: "@mposition",
    approvedAt: new Date("2026-09-23T00:00:00.000Z"),
    ...overrides,
});

test("a well formed manifest is publishable", () => {
    assert.deepEqual(manifestProblems(manifest([entry()])), []);
});

test("the digest does not depend on the order rows came back in", () => {
    const a = entry({ modelDeploymentId: "dep_a" });
    const b = entry({ modelDeploymentId: "dep_b" });
    assert.equal(manifestDigest([a, b]), manifestDigest([b, a]));
});

test("every field in the list changes the digest", () => {
    // The point of a written-down list: a field nobody covered is one a
    // decision could turn on while the manifest said nothing moved.
    const base = entry();
    const baseline = manifestDigest([base]);
    const changes = {
        modelDeploymentId: "dep_2",
        providerEndpointId: "end_2",
        logicalModelId: "gpt-5-4-mini",
        upstreamDeploymentName: "luna-canary",
        modelVersion: "2026-10-01",
        endpointResidencyClass: "domestic",
        residencyApprovalVersion: "v3",
        qualityGateStatus: "passed",
        enabled: false,
    };
    assert.deepEqual(Object.keys(changes).sort(), [...MANIFEST_DIGEST_FIELDS].sort());
    for (const [field, value] of Object.entries(changes)) {
        assert.notEqual(
            manifestDigest([entry({ [field]: value })]),
            baseline,
            field
        );
    }
});

test("null and the word null are different facts", () => {
    // A deployment that declares no model version, and one whose version is
    // literally "null", are not the same placement.
    assert.notEqual(
        manifestDigest([entry({ modelVersion: null })]),
        manifestDigest([entry({ modelVersion: "null" })])
    );
});

test("fields are length-prefixed, so a boundary cannot be moved", () => {
    // Without it, ["ab", "c"] and ["a", "bc"] concatenate the same way and
    // digest the same, which is the ordinary way a digest over joined fields
    // stops meaning anything.
    assert.notEqual(
        manifestDigest([entry({ logicalModelId: "ab", upstreamDeploymentName: "c" })]),
        manifestDigest([entry({ logicalModelId: "a", upstreamDeploymentName: "bc" })])
    );
});

test("a manifest of N cannot digest the same as one of N+1", () => {
    const one = [entry({ modelDeploymentId: "dep_a" })];
    const two = [...one, entry({ modelDeploymentId: "dep_b" })];
    assert.notEqual(manifestDigest(one), manifestDigest(two));
});

test("the digest is checked against the entries, which the database cannot do", () => {
    // The reason a caller passes entries rather than being handed a digest:
    // the database never sees the deployments, so nothing there can say the
    // digest describes them.
    assert.deepEqual(
        manifestProblems(manifest([entry()], { digest: "0".repeat(64) })),
        ["the digest does not describe these deployments"]
    );
});

test("a version starts at one, and a manifest is not published by omission", () => {
    for (const version of [0, -1, 1.5]) {
        assert.ok(
            manifestProblems(manifest([entry()], { version })).includes(
                "a manifest version is a whole number from one"
            ),
            String(version)
        );
    }
    assert.ok(
        manifestProblems(manifest([])).includes(
            "a manifest with no deployments is not published by omission"
        )
    );
});

test("a deployment cannot appear twice", () => {
    const entries = [entry(), entry()];
    assert.ok(
        manifestProblems(manifest(entries)).includes('deployment "dep_1" appears twice')
    );
});

test("a manifest names who published it and when", () => {
    // It is what a legal judgement about residency rests on. An approval with
    // no time is one nobody can place against the version it approved.
    assert.deepEqual(
        manifestProblems(manifest([entry()], { approvedBy: "  ", approvedAt: null })),
        ["a manifest names who published it", "a manifest says when it was published"]
    );
});

test("the database holds the shape, and the row cannot be rewritten", () => {
    const sql = migration();
    assert.match(sql, /RoutingIdentityManifest_version_positive_check/);
    assert.match(sql, /RoutingIdentityManifest_entryCount_positive_check/);
    assert.match(sql, /RoutingIdentityManifest_digest_shape_check/);
    assert.match(sql, /RoutingIdentityManifest_approvedBy_present_check/);
    assert.match(sql, /CREATE UNIQUE INDEX "RoutingIdentityManifest_version_key"/);
    // Published once and never edited.
    assert.match(sql, /CREATE TRIGGER "routing_identity_manifest_is_immutable_trigger"/);
    assert.match(sql, /BEFORE UPDATE OR DELETE ON "RoutingIdentityManifest"/);
    // TRUNCATE does not fire an ON DELETE trigger.
    assert.match(
        sql,
        /CREATE TRIGGER "routing_identity_manifest_is_not_truncatable_trigger"/
    );
    assert.match(sql, /BEFORE TRUNCATE ON "RoutingIdentityManifest"/);
});

test("the digest is not unique, and the version is", () => {
    // Two versions may publish identical configuration -- a republish after a
    // stopped rollout -- and that is a different publication, not a duplicate.
    // Forcing the digest unique would refuse the second and record nothing.
    const sql = migration();
    assert.ok(!/CREATE UNIQUE INDEX "RoutingIdentityManifest_digest/.test(sql));
    assert.match(sql, /CREATE UNIQUE INDEX "RoutingIdentityManifest_version_key"/);
});

test("an attempt records both the manifest and what it held", () => {
    // The foreign key says which row; the digest says what that row held at
    // the time. A disagreement is the finding.
    const sql = migration();
    assert.match(
        sql,
        /ADD COLUMN "identityManifestId" TEXT,\s*\n\s*ADD COLUMN "identityManifestDigest" TEXT;/
    );
    assert.match(sql, /RoutingAttempt_identity_manifest_binding_check/);
    assert.match(sql, /RoutingAttempt_identityManifestDigest_shape_check/);
    assert.match(
        sql,
        /FOREIGN KEY \("identityManifestId"\)[\s\S]{0,140}?ON DELETE RESTRICT/
    );
});

test("neither binding branch uses an operator that can evaluate to NULL", () => {
    // Refuses six operators by name inside that one constraint; it does not
    // evaluate the expression. What holds the current text is the test above,
    // which pins the constraint by name and the columns whole.
    const sql = migration();
    const constraint =
        /ADD CONSTRAINT "RoutingAttempt_identity_manifest_binding_check"([\s\S]*?);/.exec(sql);
    assert.ok(constraint, "the constraint is in the migration");
    const body = constraint[1]
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
    for (const column of ["identityManifestId", "identityManifestDigest"]) {
        for (const operator of ["=", "<>", "!=", " IN ", " ~ ", " LIKE "]) {
            assert.ok(
                !body.includes(`"${column}" ${operator.trim()}`),
                `${column} meets ${operator.trim()}, which can evaluate to NULL`
            );
        }
    }
});

test("the module holds no product decision and no I/O", () => {
    // It says what a manifest commits to, not which deployments exist.
    const source = readFileSync(
        new URL("../lib/routingIdentityManifest.ts", import.meta.url),
        "utf8"
    );
    const imports = source.match(/^\s*import\s[^;]*from\s+["'][^"']+["']/gm) ?? [];
    assert.deepEqual(
        imports.map((statement) => /["']([^"']+)["']/.exec(statement)[1]),
        ["node:crypto"]
    );
    const code = source
        .split("\n")
        .filter((line) => {
            const trimmed = line.trimStart();
            return (
                !trimmed.startsWith("*") &&
                !trimmed.startsWith("/*") &&
                !trimmed.startsWith("//")
            );
        })
        .join("\n");
    for (const forbidden of ["prisma.", "fetch(", "Date.now", "Math.random"]) {
        assert.ok(!code.includes(forbidden), forbidden);
    }
});

test("credentials are not part of identity", () => {
    // The hard invariant of the design: a credential authorises access to a
    // deployment and must never redefine its endpoint, region, residency,
    // model version or capability semantics. A manifest that committed to one
    // would make the two inseparable again.
    for (const forbidden of ["credential", "apiKey", "secret", "token"]) {
        assert.ok(
            !MANIFEST_DIGEST_FIELDS.some((field) =>
                field.toLowerCase().includes(forbidden.toLowerCase())
            ),
            forbidden
        );
    }
    const statements = migration()
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
    for (const forbidden of ["Credential", "apiKey", "secret"]) {
        assert.ok(!statements.includes(forbidden), forbidden);
    }
});
