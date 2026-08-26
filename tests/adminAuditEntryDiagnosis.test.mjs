import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { computeAdminAuditEntryHash } from "../lib/adminAuditIntegrityCore.ts";

/**
 * Naming what changed on an entry that no longer verifies.
 *
 * A failing row reports one thing — some byte is not what was signed — for
 * three very different situations: a forged row, a column an unrelated action
 * rewrote, and a value the application later normalised. An operator cannot
 * act on an answer that covers all three, and on 2026-08-26 that is exactly
 * where staging stopped: 115 of 116 entries verified, the failure at the
 * chain's first row, and no way to say what about that row had moved.
 *
 * `scripts/diagnose-admin-audit-entry.mjs` asks the inverted question — what
 * would have to be different for this to match — by re-deriving the hash under
 * one single-field variation at a time. These assertions hold the two
 * properties that makes it worth trusting: the derivation is exact, so a match
 * is proof rather than a hint, and a match under a variation is specific
 * enough to name the field.
 */

const SIGNED = {
    previousHash: null,
    actorUserId: "cmrh9593400010pmqagulj6q2",
    actorEmail: "admin@example.test",
    action: "billing.updated",
    targetType: "BillingConfig",
    targetId: null,
    summary: "Updated billing plans.",
    metadata: { plans: ["free", "pro"], localizedPricesUpdated: true },
    ipAddress: "unknown",
    userAgent: "Mozilla/5.0",
    createdAt: "2026-07-19T13:43:07.359Z",
};

const SECRET = "test-signing-key";

test("the hash is reproducible from stored content alone", () => {
    // The premise of the whole exercise. If two derivations of the same input
    // could differ, a mismatch would mean nothing and neither would a match.
    assert.equal(
        computeAdminAuditEntryHash(SIGNED, SECRET),
        computeAdminAuditEntryHash({ ...SIGNED }, SECRET)
    );
});

test("key order in metadata does not change the digest", () => {
    // Postgres does not preserve jsonb key order, so a verifier that depended
    // on it would fail rows nobody touched. `canonical()` sorts; this holds it.
    const reordered = {
        ...SIGNED,
        metadata: {
            localizedPricesUpdated: SIGNED.metadata.localizedPricesUpdated,
            plans: SIGNED.metadata.plans,
        },
    };
    assert.equal(
        computeAdminAuditEntryHash(reordered, SECRET),
        computeAdminAuditEntryHash(SIGNED, SECRET)
    );
});

test("array order inside metadata does change the digest", () => {
    // The counterpart, and the reason the script varies array order too: order
    // is content here, so a reordered array is a changed row.
    const reversed = {
        ...SIGNED,
        metadata: { ...SIGNED.metadata, plans: ["pro", "free"] },
    };
    assert.notEqual(
        computeAdminAuditEntryHash(reversed, SECRET),
        computeAdminAuditEntryHash(SIGNED, SECRET)
    );
});

test("a single changed field is recovered by varying that field back", () => {
    // The mechanism the script runs, end to end: sign a row, mutate one column
    // the way `onDelete: SetNull` would, and confirm that reverting exactly
    // that field — and no other — reproduces the signature.
    const signature = computeAdminAuditEntryHash(SIGNED, SECRET);
    const rewritten = { ...SIGNED, actorUserId: null };

    assert.notEqual(computeAdminAuditEntryHash(rewritten, SECRET), signature);

    const recovered = Object.keys(SIGNED).filter(
        (field) =>
            computeAdminAuditEntryHash(
                { ...rewritten, [field]: SIGNED[field] },
                SECRET
            ) === signature
    );
    assert.deepEqual(recovered, ["actorUserId"], "exactly one field explains it");
});

test("the script neither writes nor prints key material", () => {
    // Two properties that have to survive editing. Re-hashing a broken row
    // under the current key would make the checker pass by editing the thing
    // being checked; and a diagnostic that echoed a secret would turn a
    // read-only investigation into an exposure.
    const script = readFileSync(
        resolve(import.meta.dirname, "..", "scripts", "diagnose-admin-audit-entry.mjs"),
        "utf8"
    );
    for (const write of ["prisma.adminAuditLog.update", "updateMany", "create(", "delete("]) {
        assert.ok(!script.includes(write), `the diagnosis must not ${write}`);
    }
    assert.ok(
        !/console\.log\([^)]*\bsecret\b/.test(script) &&
            !/console\.log\([^)]*\bkeys\[/.test(script),
        "no key value may be printed"
    );
    assert.ok(
        script.includes("keyPosition"),
        "the key is reported by position, the same way the integrity panel does"
    );
});
