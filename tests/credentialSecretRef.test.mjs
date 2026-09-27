import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
    CREDENTIAL_SECRET_STATUSES,
    credentialSecretRefusal,
    resolveCredentialSecret,
} from "../lib/credentialSecretRef.ts";

const at = new Date("2026-09-23T00:00:00.000Z");
const later = new Date("2026-10-01T00:00:00.000Z");
const earlier = new Date("2026-09-01T00:00:00.000Z");

const active = {
    secretRef: "vault://sail/primary",
    billingOwner: "tomverse",
    status: "active",
    expiresAt: later,
    lastRotatedAt: earlier,
};

test("an active reference resolves from the vault and nowhere else", () => {
    let asked = null;
    const resolved = resolveCredentialSecret(active, at, (secretRef) => {
        asked = secretRef;
        return "secret-value";
    });
    assert.equal(asked, active.secretRef);
    assert.deepEqual(resolved, { ok: true, secret: "secret-value" });
});

test("a disabled or revoked row never reaches the vault", () => {
    for (const status of ["disabled", "revoked"]) {
        const resolved = resolveCredentialSecret(
            { ...active, status },
            at,
            () => {
                throw new Error("vault was asked");
            }
        );
        assert.deepEqual(resolved, { ok: false, code: "status_not_active" });
    }
});

test("expiry is inclusive and a missing expiry is not an invented lifetime", () => {
    assert.equal(
        credentialSecretRefusal({ ...active, expiresAt: at }, at),
        "expired"
    );
    assert.equal(
        credentialSecretRefusal({ ...active, expiresAt: null }, at),
        null
    );
    assert.equal(
        credentialSecretRefusal(
            { ...active, lastRotatedAt: later, expiresAt: earlier },
            at
        ),
        "rotation_after_expiry"
    );
});

test("a blank reference, an unknown owner and a missing vault entry are refusals", () => {
    assert.equal(
        credentialSecretRefusal({ ...active, secretRef: "  " }, at),
        "secret_ref_blank"
    );
    assert.equal(
        credentialSecretRefusal({ ...active, billingOwner: "workspace" }, at),
        "billing_owner_unknown"
    );
    assert.deepEqual(
        resolveCredentialSecret(active, at, () => undefined),
        { ok: false, code: "secret_not_in_vault" }
    );
    assert.deepEqual(
        resolveCredentialSecret(active, at, () => "  "),
        { ok: false, code: "secret_blank" }
    );
    assert.equal(resolveCredentialSecret(active, new Date(Number.NaN), () => "x"), null);
});

test("the status vocabulary is the database check", () => {
    const sql = readFileSync(
        "prisma/migrations/20260923140000_credential_binding_quota_scope_dark/migration.sql",
        "utf8"
    );
    const match = sql.match(/"status" IN \(([^)]+)\)/);
    assert.ok(match, "status check is in the migration");
    const listed = [...match[1].matchAll(/'([^']+)'/g)].map((found) => found[1]);
    assert.deepEqual(listed, [...CREDENTIAL_SECRET_STATUSES]);
});

test("the request path does not import the secret resolver", () => {
    const hits = [];
    const walk = (directory) => {
        for (const name of readdirSync(directory)) {
            const path = join(directory, name);
            if (statSync(path).isDirectory()) {
                walk(path);
                continue;
            }
            if (!/\.(?:ts|tsx|mjs|js)$/.test(name)) continue;
            if (path === join("lib", "credentialSecretRef.ts")) continue;
            const source = readFileSync(path, "utf8");
            if (source.includes("credentialSecretRef") || source.includes("resolveCredentialSecret")) {
                hits.push(path);
            }
        }
    };
    for (const root of ["app", "lib"]) walk(root);
    assert.deepEqual(hits, []);
});
