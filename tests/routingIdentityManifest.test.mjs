import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    MANIFEST_DIGEST_FIELDS,
    canonicalCapabilities,
    manifestDigest,
    manifestProblems,
} from "../lib/routingIdentityManifest.ts";

/**
 * One published snapshot of the routing identity configuration.
 *
 * What these hold is that a published version keeps meaning what it meant, and
 * that "what it meant" can be read back rather than only checked: the digest
 * covers every field the repository already calls identity, the entries are
 * stored, and the rows cannot be edited.
 */

const migration = () =>
    readFileSync(
        new URL(
            "../prisma/migrations/20260923320000_routing_manifest_entries_dark/migration.sql",
            import.meta.url
        ),
        "utf8"
    );

const identityMigration = () =>
    readFileSync(
        new URL(
            // The migration that last replaced the function, named here rather
            // than discovered as "the newest file". A later migration must not
            // become the authority by existing.
            "../prisma/migrations/20260923390000_deployment_version_gate_dark/migration.sql",
            import.meta.url
        ),
        "utf8"
    );

const statements = (sql) =>
    sql
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");

const entry = (overrides = {}) => ({
    modelDeploymentId: "dep_1",
    logicalModelId: "gpt-5-6-luna",
    upstreamDeploymentName: "luna-prod",
    modelVersion: "2026-09-01",
    modelRevision: null,
    quantization: null,
    tokenizerRevision: null,
    qualityTier: "advanced",
    capabilities: canonicalCapabilities({ vision: true, tools: ["search"] }),
    qualityGateStatus: "pending",
    qualityGateExpiresAt: null,
    versionPinStrength: "strong",
    allowVersionDrift: false,
    qualityBenchmarkVersion: null,
    qualityLastVerifiedAt: null,
    deploymentEnabled: true,
    providerEndpointId: "end_1",
    gatewayProvider: "openai",
    servingProvider: "openai",
    endpointUrl: "https://api.openai.com/v1",
    endpointResidencyClass: "unproven",
    endpointEnabled: true,
    residencyApprovalId: null,
    ...overrides,
});

const manifest = (entries, overrides = {}) => ({
    version: 1,
    digest: manifestDigest(entries),
    entryCount: entries.length,
    entries,
    approvedBy: "@mposition",
    approvedAt: new Date("2026-09-23T00:00:00.000Z"),
    ...overrides,
});

test("a well formed manifest is publishable", () => {
    assert.deepEqual(manifestProblems(manifest([entry()])), []);
});

test("the digest covers every column the identity trigger already names", () => {
    // The first field list was smaller than what the repository already calls
    // identity, and `satisfies` could not notice: it checks that each name is
    // a key of the type, not that the type mentioned every column.
    // Read from the whole function body and by the comparison itself, not by
    // slicing at the first `) THEN`: a column added after such a token, or
    // inside a comment, would have gone unseen while the count floor still
    // passed.
    const body =
        /CREATE OR REPLACE FUNCTION "model_deployment_gate_follows_identity"[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(
            identityMigration()
        );
    assert.ok(body, "the identity trigger is in its migration");
    const code = body[1]
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
    const columns = [
        ...new Set(
            [
                ...code.matchAll(
                    /NEW\."(\w+)" IS DISTINCT FROM OLD\."\1"/g
                ),
            ].map((match) => match[1])
        ),
    ];
    assert.ok(columns.length >= 9, `found ${columns.length} identity columns`);
    for (const column of columns) {
        assert.ok(
            MANIFEST_DIGEST_FIELDS.includes(column),
            `${column} is identity to the trigger and not to the digest`
        );
    }
});

test("the endpoint fields that route and that make it legal are covered", () => {
    // ProviderEndpoint has no identity trigger, so nothing else holds this.
    // Section 2.1's rule: swap the two rows, and if the answer or its legality
    // changes, it belongs in the upper layer.
    for (const field of [
        "providerEndpointId",
        "gatewayProvider",
        "servingProvider",
        "endpointUrl",
        "endpointResidencyClass",
        "endpointEnabled",
        "residencyApprovalId",
    ]) {
        assert.ok(MANIFEST_DIGEST_FIELDS.includes(field), field);
    }
    // And the ones deliberately left out, each for a stated reason.
    for (const field of [
        "routingPolicyDigest",
        "region",
        "destinationRegions",
        "resourceId",
        "cloudAccountId",
    ]) {
        assert.ok(!MANIFEST_DIGEST_FIELDS.includes(field), field);
    }
});

test("the sequence that moved capabilities under a stable digest", () => {
    // Disable the deployment, which moves the digest; change capabilities
    // while it is disabled, which the identity trigger permits; re-enable and
    // restore the gate status. Under the first field list every digested value
    // was back where it started and the candidate filter read different
    // capabilities.
    const before = entry();
    const disabled = entry({ deploymentEnabled: false, qualityGateStatus: "withdrawn" });
    const edited = entry({
        deploymentEnabled: false,
        qualityGateStatus: "withdrawn",
        capabilities: canonicalCapabilities({ vision: true, tools: ["search", "code"] }),
    });
    const after = entry({
        capabilities: canonicalCapabilities({ vision: true, tools: ["search", "code"] }),
    });

    assert.notEqual(manifestDigest([disabled]), manifestDigest([before]));
    assert.notEqual(manifestDigest([edited]), manifestDigest([disabled]));
    // The one that matters: back to enabled and pending, and still different.
    assert.notEqual(manifestDigest([after]), manifestDigest([before]));
});

test("every field in the list changes the digest", () => {
    const baseline = manifestDigest([entry()]);
    const changes = {
        modelDeploymentId: "dep_2",
        logicalModelId: "gpt-5-4-mini",
        upstreamDeploymentName: "luna-canary",
        modelVersion: "2026-10-01",
        modelRevision: "r2",
        quantization: "int8",
        tokenizerRevision: "t2",
        qualityTier: "standard",
        capabilities: canonicalCapabilities({ vision: false }),
        qualityGateStatus: "passed",
        qualityGateExpiresAt: new Date("2026-12-01T00:00:00.000Z"),
        versionPinStrength: "weak",
        allowVersionDrift: true,
        qualityBenchmarkVersion: "bench-2",
        qualityLastVerifiedAt: new Date("2026-09-01T00:00:00.000Z"),
        deploymentEnabled: false,
        providerEndpointId: "end_2",
        gatewayProvider: "azure",
        servingProvider: "openai-on-azure",
        endpointUrl: "https://example.openai.azure.com",
        endpointResidencyClass: "domestic",
        endpointEnabled: false,
        residencyApprovalId: "appr_1",
    };
    assert.deepEqual(Object.keys(changes).sort(), [...MANIFEST_DIGEST_FIELDS].sort());
    for (const [field, value] of Object.entries(changes)) {
        assert.notEqual(manifestDigest([entry({ [field]: value })]), baseline, field);
    }
});

test("the expiry digests as one instant, however it was spelled", () => {
    // The one field a row could not reproduce. As a free string,
    // 2026-12-01T00:00:00.000Z and 2026-12-01T00:00:00Z are the same instant
    // and digested differently, the TIMESTAMP(3) column kept one of them, and
    // a string that was not a date at all digested fine and failed to insert.
    const expiry = new Date("2026-12-01T00:00:00.000Z");
    assert.equal(
        manifestDigest([entry({ qualityGateExpiresAt: expiry })]),
        manifestDigest([entry({ qualityGateExpiresAt: new Date("2026-12-01T00:00:00Z") })])
    );
    assert.notEqual(
        manifestDigest([entry({ qualityGateExpiresAt: expiry })]),
        manifestDigest([entry({ qualityGateExpiresAt: null })])
    );
    // And one that is not an instant is refused rather than digested.
    assert.deepEqual(
        manifestProblems(manifest([entry({ qualityGateExpiresAt: new Date("nonsense") })])),
        ['deployment "dep_1" has an expiry that is not an instant']
    );
});

test("the verification instant digests as one instant, however it was spelled", () => {
    const verified = new Date("2026-09-01T00:00:00.000Z");
    assert.equal(
        manifestDigest([entry({ qualityLastVerifiedAt: verified })]),
        manifestDigest([entry({ qualityLastVerifiedAt: new Date("2026-09-01T00:00:00Z") })])
    );
    assert.notEqual(
        manifestDigest([entry({ qualityLastVerifiedAt: verified })]),
        manifestDigest([entry({ qualityLastVerifiedAt: null })])
    );
    assert.deepEqual(
        manifestProblems(manifest([entry({ qualityLastVerifiedAt: new Date("nonsense") })])),
        ['deployment "dep_1" has a verification time that is not an instant']
    );
});

test("capabilities canonicalise by key and keep array order", () => {
    // Key order is not a declaration; a differently ordered list of
    // capabilities is.
    assert.equal(
        canonicalCapabilities({ a: 1, b: 2 }),
        canonicalCapabilities({ b: 2, a: 1 })
    );
    assert.notEqual(
        canonicalCapabilities({ tools: ["a", "b"] }),
        canonicalCapabilities({ tools: ["b", "a"] })
    );
    // A capability added or removed moves it, which is the whole reason this
    // one field gets a generic canonicaliser.
    assert.notEqual(
        canonicalCapabilities({ vision: true }),
        canonicalCapabilities({ vision: true, tools: [] })
    );
    assert.equal(canonicalCapabilities(undefined), canonicalCapabilities(null));
    // JSON.stringify turns several distinct values into the same bytes. None
    // can arrive from the jsonb column this reads, and a digest that quietly
    // agreed about two different declarations is worth refusing.
    for (const value of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        new Date("2026-01-01"),
        { nested: Number.NaN },
        { at: new Date(0) },
    ]) {
        assert.throws(() => canonicalCapabilities(value), TypeError);
    }
});

test("null is not any string, including the ones that look like it", () => {
    const declared = manifestDigest([entry({ modelVersion: null })]);
    for (const value of ["null", "\u0000", "", "-"]) {
        assert.notEqual(
            manifestDigest([entry({ modelVersion: value })]),
            declared,
            JSON.stringify(value)
        );
    }
});

test("the three encoded shapes cannot be confused for each other", () => {
    // A string begins with its length, so with a digit; a null is `-`; a
    // boolean is `~`. An earlier version wrote a boolean as `2:b1`, which is
    // exactly what the string "b1" encodes to -- the per-field types meant no
    // two well typed entries could collide, but the comment claimed the three
    // shapes were disjoint and they were not.
    const source = readFileSync(
        new URL("../lib/routingIdentityManifest.ts", import.meta.url),
        "utf8"
    );
    assert.match(source, /return value \? "~1" : "~0";/);
    assert.ok(!source.includes('"2:b1"'));
    const digests = new Set([
        manifestDigest([entry({ deploymentEnabled: true })]),
        manifestDigest([entry({ deploymentEnabled: false })]),
        manifestDigest([entry({ modelVersion: "1" })]),
        manifestDigest([entry({ modelVersion: "0" })]),
        manifestDigest([entry({ modelVersion: "b1" })]),
    ]);
    assert.equal(digests.size, 5);
});

test("fields are length-prefixed, so a boundary cannot be moved", () => {
    assert.notEqual(
        manifestDigest([entry({ logicalModelId: "ab", upstreamDeploymentName: "c" })]),
        manifestDigest([entry({ logicalModelId: "a", upstreamDeploymentName: "bc" })])
    );
});

test("the digest does not depend on input order, even for duplicates", () => {
    // Sorting by deployment id alone left duplicates order-sensitive.
    // `manifestProblems()` refuses them, but a digest function that answers
    // differently for the same set is worth not having.
    const a = entry({ modelDeploymentId: "dep_a" });
    const b = entry({ modelDeploymentId: "dep_b" });
    assert.equal(manifestDigest([a, b]), manifestDigest([b, a]));
    const same = entry({ modelDeploymentId: "dep_x" });
    const alsoSame = entry({ modelDeploymentId: "dep_x", endpointUrl: "https://other" });
    assert.equal(manifestDigest([same, alsoSame]), manifestDigest([alsoSame, same]));
});

test("a manifest of N cannot digest the same as one of N+1", () => {
    const one = [entry({ modelDeploymentId: "dep_a" })];
    const two = [...one, entry({ modelDeploymentId: "dep_b" })];
    assert.notEqual(manifestDigest(one), manifestDigest(two));
});

test("the digest and the count are both checked against the entries", () => {
    // A CHECK sees one row at a time, so neither of these can live in the
    // database: a row could carry the hash of two entries beside a count of
    // one and nothing reading the row alone could tell.
    assert.deepEqual(
        manifestProblems(manifest([entry()], { digest: "0".repeat(64) })),
        ["the digest does not describe these deployments"]
    );
    assert.deepEqual(
        manifestProblems(manifest([entry()], { entryCount: 2 })),
        ["the count does not match these deployments"]
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
    assert.ok(
        manifestProblems(manifest([entry(), entry()])).includes(
            'deployment "dep_1" appears twice'
        )
    );
});

test("blank means the same six characters on both sides", () => {
    // `String.trim()` strips U+00A0 and every other Unicode space; the
    // constraint's character class does not. A name of one non-breaking space
    // was refused here and accepted by the database.
    for (const name of [" ", "\t", "\n", "\r", "\f", "\v", ""]) {
        assert.ok(
            manifestProblems(manifest([entry()], { approvedBy: name })).includes(
                "a manifest names who published it"
            ),
            JSON.stringify(name)
        );
    }
    assert.deepEqual(manifestProblems(manifest([entry()], { approvedBy: " " })), []);
    const sql = statements(migration());
    assert.match(sql, /"approvedBy" ~ E'\[\^ \\\\t\\\\n\\\\r\\\\f\\\\v\]'/);
    assert.ok(!sql.includes("btrim"));
});

test("a manifest says when it was published", () => {
    assert.ok(
        manifestProblems(manifest([entry()], { approvedAt: null })).includes(
            "a manifest says when it was published"
        )
    );
});

test("every digest field is a column of the entry table", () => {
    // The review's rejection was that a digest proves values were not altered
    // while you still have the values, and ModelDeployment and
    // ProviderEndpoint are mutable rows that will have moved by the time
    // anybody asks. This checks the DDL declares a column per digest field,
    // which is what makes the reconstruction possible; it writes no row.
    const added = readFileSync(
        new URL(
            "../prisma/migrations/20260923390000_deployment_version_gate_dark/migration.sql",
            import.meta.url
        ),
        "utf8"
    );
    // The deployment table's alter names the same pin columns. This test is
    // about the entry table, so the deployment alter is not evidence.
    const entryAdded = added.slice(added.indexOf('ALTER TABLE "RoutingIdentityManifestEntry"'));
    assert.ok(entryAdded.length > 0);
    const sql = `${statements(migration())}\n${entryAdded}`;
    assert.match(sql, /CREATE TABLE "RoutingIdentityManifestEntry"/);
    for (const field of MANIFEST_DIGEST_FIELDS) {
        assert.match(sql, new RegExp(`"${field}"`), field);
    }
});

test("the approval is a key, and the mutable rows are copies", () => {
    // EndpointResidencyApproval is append-only, so its recipients, regions,
    // enforcement mechanism, evidence and dates are already immutable where
    // they are; copying them would be a second place they could disagree.
    const sql = statements(migration());
    assert.match(
        sql,
        /FOREIGN KEY \("residencyApprovalId"\) REFERENCES "EndpointResidencyApproval"\("id"\)\s*\n\s*ON DELETE RESTRICT/
    );
    for (const copied of ["allowedRecipients", "allowedRegions", "enforcementMechanism"]) {
        assert.ok(!sql.includes(copied), copied);
    }
});

test("an entry cannot be rewritten, and there is one per deployment", () => {
    const sql = statements(migration());
    assert.match(
        sql,
        /CREATE UNIQUE INDEX "RoutingIdentityManifestEntry_manifestId_modelDeploymentId_key"/
    );
    assert.match(
        sql,
        /CREATE TRIGGER "routing_identity_manifest_entry_is_immutable_trigger"/
    );
    assert.match(sql, /BEFORE UPDATE OR DELETE ON "RoutingIdentityManifestEntry"/);
    assert.match(
        sql,
        /CREATE TRIGGER "routing_identity_manifest_entry_is_not_truncatable_trigger"/
    );
    assert.match(sql, /BEFORE TRUNCATE ON "RoutingIdentityManifestEntry"/);
    // RESTRICT to everything it describes; Cascade only to the publication.
    // By parent rather than by count -- moving the cascade onto the
    // deployment and the restrict onto the manifest would keep the counts.
    for (const [column, parent, action] of [
        ["manifestId", "RoutingIdentityManifest", "CASCADE"],
        ["modelDeploymentId", "ModelDeployment", "RESTRICT"],
        ["providerEndpointId", "ProviderEndpoint", "RESTRICT"],
        ["residencyApprovalId", "EndpointResidencyApproval", "RESTRICT"],
    ]) {
        assert.match(
            sql,
            new RegExp(
                `FOREIGN KEY \\("${column}"\\) REFERENCES "${parent}"\\("id"\\)\\s*\\n\\s*ON DELETE ${action}`
            ),
            `${column} -> ${parent} ${action}`
        );
    }
});

test("the module holds no I/O and imports only node:crypto", () => {
    // It also holds product rules -- an empty manifest is refused and an
    // approver is required -- so this is not a claim that it holds none.
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

test("no field name and no column reaches a credential", () => {
    // A substring check, which is what it is: it stops the obvious name and
    // would not stop something spelled differently. What actually holds the
    // invariant is that this commit has no path to a credential at all -- the
    // module imports only node:crypto, and the table's foreign keys go to a
    // deployment, an endpoint, an approval and the manifest.
    // "token" is not on this list: `tokenizerRevision` is identity, and token
    // counts are everywhere in this domain. A word that means two things
    // cannot be a guard.
    for (const forbidden of ["credential", "apikey", "secret", "bearer", "keyid"]) {
        assert.ok(
            !MANIFEST_DIGEST_FIELDS.some((field) =>
                field.toLowerCase().includes(forbidden)
            ),
            forbidden
        );
    }
    const sql = statements(migration());
    for (const forbidden of ["Credential", "apiKey", "secret"]) {
        assert.ok(!sql.includes(forbidden), forbidden);
    }
    assert.deepEqual(
        [...new Set([...sql.matchAll(/REFERENCES "(\w+)"/g)].map((match) => match[1]))].sort(),
        [
            "EndpointResidencyApproval",
            "ModelDeployment",
            "ProviderEndpoint",
            "RoutingIdentityManifest",
        ]
    );
});
