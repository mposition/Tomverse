import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    CREDENTIAL_BILLING_OWNERS,
    CREDENTIAL_BINDING_STATUSES,
    QUOTA_SCOPE_KINDS,
    QUOTA_SCOPE_REQUIRED_FIELDS,
    credentialBindingFundingProblems,
    quotaScopeProblems,
} from "../lib/deploymentIdentity.ts";

/**
 * Quota scopes and credential bindings, which are dark.
 *
 * The rule worth holding is the one an independent review supplied: a limit
 * counted against nothing is indistinguishable from no limit until somebody
 * spends against it. So a scope carries exactly the columns its kind needs,
 * behind foreign keys, and there is only one row per scope.
 */

const migration = () =>
    readFileSync(
        new URL(
            "../prisma/migrations/20260923140000_credential_binding_quota_scope_dark/migration.sql",
            import.meta.url
        ),
        "utf8"
    );

const ALL_FIELDS = [
    "credentialBindingId",
    "providerEndpointId",
    "modelDeploymentId",
    "accountId",
    "providerId",
];

const rowFor = (scopeKind, fields) => {
    const row = { scopeKind };
    for (const field of ALL_FIELDS) row[field] = fields.includes(field) ? "id" : null;
    return row;
};

test("a well formed scope of every kind is accepted", () => {
    for (const kind of QUOTA_SCOPE_KINDS) {
        const required = QUOTA_SCOPE_REQUIRED_FIELDS[kind];
        assert.deepEqual(quotaScopeProblems(rowFor(kind, required)), [], kind);
    }
});

test("a scope missing its own column is refused", () => {
    for (const kind of QUOTA_SCOPE_KINDS) {
        for (const field of QUOTA_SCOPE_REQUIRED_FIELDS[kind]) {
            const without = QUOTA_SCOPE_REQUIRED_FIELDS[kind].filter((f) => f !== field);
            assert.deepEqual(
                quotaScopeProblems(rowFor(kind, without)),
                [`${kind} needs ${field}`],
                `${kind} without ${field}`
            );
        }
    }
});

test("a scope carrying a column of another kind is refused", () => {
    // A `provider` scope holding a credential id is two scopes wearing one
    // row, and whichever reader looked first would decide which it was.
    for (const kind of QUOTA_SCOPE_KINDS) {
        const required = QUOTA_SCOPE_REQUIRED_FIELDS[kind];
        for (const field of ALL_FIELDS) {
            if (required.includes(field)) continue;
            assert.deepEqual(
                quotaScopeProblems(rowFor(kind, [...required, field])),
                [`${kind} must not carry ${field}`],
                `${kind} with ${field}`
            );
        }
    }
});

test("an unknown scope kind is refused rather than guessed at", () => {
    assert.deepEqual(quotaScopeProblems({ scopeKind: "workspace", accountId: "a" }), [
        'unknown scope kind "workspace"',
    ]);
});

test("there is no workspace scope, because there is no workspace", () => {
    // BYOK ownership is the account. A scope pointing at an entity the schema
    // does not have would be a limit on nothing.
    assert.ok(!QUOTA_SCOPE_KINDS.includes("workspace"));
    assert.ok(QUOTA_SCOPE_KINDS.includes("account"));
});

test("an account-funded binding names its account and no Tomverse budget", () => {
    assert.deepEqual(
        credentialBindingFundingProblems({
            billingOwner: "account",
            accountId: "u_1",
            providerBudgetAccountId: null,
        }),
        []
    );
    assert.deepEqual(
        credentialBindingFundingProblems({
            billingOwner: "account",
            accountId: null,
            providerBudgetAccountId: "budget",
        }),
        [
            "an account-funded binding names its account",
            "an account-funded binding draws down no Tomverse budget",
        ]
    );
});

test("a Tomverse-funded binding is the reverse", () => {
    assert.deepEqual(
        credentialBindingFundingProblems({
            billingOwner: "tomverse",
            accountId: null,
            providerBudgetAccountId: "budget",
        }),
        []
    );
    assert.deepEqual(
        credentialBindingFundingProblems({
            billingOwner: "tomverse",
            accountId: "u_1",
            providerBudgetAccountId: null,
        }),
        [
            "a Tomverse-funded binding names no account",
            "a Tomverse-funded binding names the budget it spends against",
        ]
    );
});

test("revoked is not the same fact as disabled", () => {
    // One was switched off and can be switched back on; the other was
    // withdrawn and the secret behind it should be assumed gone.
    assert.ok(CREDENTIAL_BINDING_STATUSES.includes("disabled"));
    assert.ok(CREDENTIAL_BINDING_STATUSES.includes("revoked"));
    assert.deepEqual([...CREDENTIAL_BILLING_OWNERS], ["tomverse", "account"]);
});

test("the database holds the same shape rule, and only one row per scope", () => {
    const sql = migration();
    // Not that the kind appears somewhere, but that its arm of the CHECK names
    // exactly the columns the application list requires and forbids the rest.
    // Matching the string alone would survive a column moving between kinds.
    const shape = sql.match(/QuotaScope_shape_check[\s\S]*?\n    \);/);
    assert.ok(shape, "the shape CHECK is present");
    for (const kind of QUOTA_SCOPE_KINDS) {
        const arm = shape[0].match(
            new RegExp(`"scopeKind" = '${kind}'([\\s\\S]*?)\\)`)
        );
        assert.ok(arm, kind);
        const required = QUOTA_SCOPE_REQUIRED_FIELDS[kind];
        for (const field of ALL_FIELDS) {
            const wanted = required.includes(field);
            assert.match(
                arm[1],
                new RegExp(`"${field}" IS ${wanted ? "NOT NULL" : "NULL"}`),
                `${kind}.${field} should be ${wanted ? "required" : "forbidden"}`
            );
        }
    }
    // Foreign keys, so a scope id cannot point at a row that is not there.
    for (const fk of [
        "QuotaScope_credentialBindingId_fkey",
        "QuotaScope_providerEndpointId_fkey",
        "QuotaScope_modelDeploymentId_fkey",
        "QuotaScope_accountId_fkey",
        "QuotaScope_providerId_fkey",
    ]) {
        assert.match(sql, new RegExp(fk), fk);
    }
    // Partial unique indexes: the CHECK says a row has the right shape, these
    // say there is only one of it. Two rows for one scope are two budgets.
    for (const index of [
        "QuotaScope_credential_key",
        "QuotaScope_endpoint_credential_key",
        "QuotaScope_deployment_credential_key",
        "QuotaScope_account_key",
        "QuotaScope_provider_key",
    ]) {
        assert.match(sql, new RegExp(`CREATE UNIQUE INDEX "${index}"`), index);
    }
    assert.equal((sql.match(/WHERE "scopeKind" = /g) ?? []).length, QUOTA_SCOPE_KINDS.length);
});

test("the funding rule is in the database too", () => {
    const sql = migration();
    assert.match(sql, /CredentialBinding_billing_owner_account_check/);
    assert.match(sql, /CredentialBinding_budget_account_check/);
    // The secret is never stored here, only a reference to where it lives.
    assert.match(sql, /"secretRef" TEXT NOT NULL/);
    assert.ok(!/"secret"\s+TEXT/.test(sql), "no column holds a secret");
});

test("a binding starts disabled", () => {
    assert.match(migration(), /"status" TEXT NOT NULL DEFAULT 'disabled'/);
    assert.match(migration(), /"enabled" BOOLEAN NOT NULL DEFAULT false/);
});

test("a blank identifier is absent in both rules", () => {
    // PostgreSQL treats "" as a value and JavaScript truthiness treats it as
    // missing, so without this the database would accept a row the
    // application refuses -- a disagreement on the one input nobody tests.
    assert.deepEqual(
        credentialBindingFundingProblems({
            billingOwner: "tomverse",
            accountId: "   ",
            providerBudgetAccountId: "budget",
        }),
        []
    );
    assert.deepEqual(
        credentialBindingFundingProblems({
            billingOwner: "tomverse",
            accountId: null,
            providerBudgetAccountId: "",
        }),
        ["a Tomverse-funded binding names the budget it spends against"]
    );
});

test("two rules a CHECK cannot hold are held by triggers", () => {
    const sql = migration();
    // A CHECK sees one row, so neither of these could be one.
    //
    // A deployment_credential scope pairs a credential with a placement, and
    // the shape rule forbids it from carrying an endpoint of its own -- which
    // makes a cross-endpoint pair invisible to every constraint in the file.
    assert.match(sql, /CREATE TRIGGER "quota_scope_pairs_one_endpoint_trigger"/);
    assert.match(sql, /BEFORE INSERT OR UPDATE ON "QuotaScope"/);
    // And what a scope counts against cannot change: an attempt records the
    // scope id it spent under, so repointing the row moves spend that already
    // happened onto something else.
    assert.match(sql, /CREATE TRIGGER "quota_scope_target_is_immutable_trigger"/);
    for (const column of [
        "scopeKind",
        "credentialBindingId",
        "providerEndpointId",
        "modelDeploymentId",
        "accountId",
        "providerId",
    ]) {
        assert.match(
            sql,
            new RegExp(`NEW\."${column}" IS DISTINCT FROM OLD\."${column}"`),
            column
        );
    }
});

test("a quota row cannot refuse an account deletion", () => {
    // The scope cascades from its binding rather than restricting it.
    // Operational bookkeeping does not get to outrank a person deleting their
    // account, and a scope has no meaning without the binding it counts
    // against.
    assert.match(
        migration(),
        /QuotaScope_credentialBindingId_fkey[\s\S]*?ON DELETE CASCADE/
    );
    assert.match(
        migration(),
        /CredentialBinding_accountId_fkey[\s\S]*?ON DELETE CASCADE/
    );
});

test("the schema declares the same foreign keys the migration creates", () => {
    // Prisma cannot express a CHECK or a partial unique index, so those live
    // in SQL alone. A foreign key it can express, and `db push` builds a
    // database from the schema rather than the migrations -- a key declared in
    // only one of them is a key that exists in only one environment.
    const schema = readFileSync(
        new URL("../prisma/schema.prisma", import.meta.url),
        "utf8"
    );
    const model = schema.match(/model QuotaScope \{[\s\S]*?\n\}/);
    assert.ok(model, "QuotaScope is in the schema");
    for (const field of ["credentialBindingId", "providerEndpointId", "modelDeploymentId", "accountId", "providerId"]) {
        assert.ok(
            model[0].includes(`@relation(fields: [${field}]`),
            `${field} has a declared relation`
        );
    }
    // Prisma defaults an optional relation to SetNull, which would silently
    // disagree with the migration's RESTRICT. Three infrastructure targets
    // restrict -- deleting an endpoint, a deployment or a provider is not a
    // thing a quota row should let happen quietly -- and the two that cascade
    // are the ones a person's own deletion reaches.
    assert.equal(
        (model[0].match(/onDelete: Restrict/g) ?? []).length,
        3,
        "endpoint, deployment and provider restrict"
    );
});
