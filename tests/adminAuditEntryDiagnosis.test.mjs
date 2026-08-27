import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { diagnoseAdminAuditEntry } from "../lib/adminAuditEntryDiagnosis.ts";
import {
    adminAuditEntryHashVariants,
    computeAdminAuditEntryHash,
} from "../lib/adminAuditIntegrityCore.ts";

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

test("the console can reach the diagnosis without a shell", () => {
    // The diagnosis needs the database and the signing keys. Telling an
    // operator to clone the repository and run `railway run` moves the work
    // rather than doing it, and puts production secrets somewhere new on the
    // way. The application already holds both and the administrator is already
    // authenticated in front of it.
    const route = readFileSync(
        resolve(
            import.meta.dirname,
            "..",
            "app",
            "api",
            "admin",
            "audit",
            "[auditId]",
            "diagnose",
            "route.ts"
        ),
        "utf8"
    );
    assert.ok(route.includes("export async function GET"));
    assert.ok(
        route.includes("isAdminSession"),
        "the diagnosis reads an audit row and must be behind the admin check"
    );
    assert.ok(
        !/prisma\.adminAuditLog\.(update|delete|create)/.test(route),
        "the endpoint must not write to the chain it inspects"
    );

    const panel = readFileSync(
        resolve(import.meta.dirname, "..", "components", "admin", "AdminAuditIntegrityPanel.tsx"),
        "utf8"
    );
    assert.match(
        panel,
        /fetch\(\s*\n?\s*`\/api\/admin\/audit\/\$\{encodeURIComponent\(auditId\)\}\/diagnose`/,
        "the panel must call the endpoint"
    );
    assert.ok(
        panel.includes('data-testid="admin-audit-integrity-diagnose"'),
        "the diagnosis needs a control the operator can press"
    );
    assert.ok(
        panel.includes('data-testid="admin-audit-integrity-diagnosis"'),
        "the result needs somewhere to render"
    );
});

test("one definition of what to try, shared by both callers", () => {
    // Two candidate sets would answer the same question two ways, and the
    // divergence would show up as a console and a shell disagreeing about
    // what changed on the same row -- the worst possible place for it.
    const script = readFileSync(
        resolve(import.meta.dirname, "..", "scripts", "diagnose-admin-audit-entry.mjs"),
        "utf8"
    );
    assert.ok(
        script.includes("adminAuditEntryDiagnosis"),
        "the script must use the shared module, not its own candidate list"
    );
    assert.ok(
        !script.includes("candidates.push"),
        "the script must not build candidates of its own"
    );
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
        script.includes("keyPosition") || script.includes("diagnosis"),
        "the key is reported by position, the same way the integrity panel does"
    );
});

test("a collation difference is detectable, and is not a changed field", () => {
    // `localeCompare` sorts under the runtime's collation, so the canonical
    // form of a row depends on the container rather than on the bytes. Two of
    // this repository's own audit metadata key pairs order differently under
    // it than by code point, so a collation change breaks a scattered subset
    // of rows -- which is what a key change can never look like, and what
    // staging showed on 2026-08-26 when eight rows that had verified an hour
    // earlier stopped.
    const metadata = { creditUsd: 12, creditsPurchased: 3 };
    assert.notEqual(
        "creditUsd".localeCompare("creditsPurchased") < 0,
        "creditUsd" < "creditsPurchased",
        "this pair is the whole point: the two orders must disagree about it"
    );

    const row = { ...SIGNED, metadata };
    const variants = adminAuditEntryHashVariants(row, SECRET);
    assert.notEqual(
        variants.locale,
        variants.codepoint,
        "the two key orders must produce different digests for such a row"
    );
    assert.equal(
        computeAdminAuditEntryHash(row, SECRET),
        variants.codepoint,
        "signing moved to code point on 2026-08-27; it must not depend on collation"
    );

    // A row signed before that move reproduces under the legacy order, and is
    // reported as that rather than as a field that changed -- nothing about it
    // did. Verification accepts it, so this is a statement of provenance.
    const legacy = diagnoseAdminAuditEntry(row, variants.locale, [SECRET]);
    assert.equal(legacy.reproducesUnderOrder, "locale");
    assert.equal(legacy.verifiesAsStored, false);
    assert.deepEqual(legacy.matches, [], "no field differs; do not claim one does");

    // And a row signed after it answers with the signing order, not the legacy
    // one: the search must report the order that actually matched.
    const current = diagnoseAdminAuditEntry(row, variants.codepoint, [SECRET]);
    assert.equal(current.reproducesUnderOrder, "codepoint");
    assert.equal(current.verifiesAsStored, true);
});

test("a row that verifies normally reports the signing order, not the legacy one", () => {
    // The two orders agree on an object with no divergent pair, which is the
    // ordinary case. The report must name the signing order it tried first,
    // never the legacy one -- otherwise every healthy row would read as though
    // it predated the migration.
    const diagnosis = diagnoseAdminAuditEntry(
        SIGNED,
        computeAdminAuditEntryHash(SIGNED, SECRET),
        [SECRET]
    );
    assert.equal(diagnosis.verifiesAsStored, true);
    assert.equal(diagnosis.reproducesUnderOrder, "codepoint");
});

test("a row nothing reproduces reports no order at all", () => {
    // The useful half of the finding: `null` rules the collation story out
    // rather than leaving it open, which is what a genuinely broken row needs.
    const diagnosis = diagnoseAdminAuditEntry(SIGNED, "0".repeat(64), [SECRET]);
    assert.equal(diagnosis.verifiesAsStored, false);
    assert.equal(diagnosis.reproducesUnderOrder, null);
});
