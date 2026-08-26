import assert from "node:assert/strict";
import test from "node:test";

import { adminAuditIntegrityKeys } from "../lib/adminAuditIntegrityCore.ts";

/**
 * Which keys the audit chain may be verified against, and which one signs.
 *
 * Until 2026-08-25 neither environment set `ADMIN_AUDIT_INTEGRITY_KEY`, so the
 * chain was signed with `NEXTAUTH_SECRET`. Rotating a session secret is routine
 * and sometimes mandatory; doing it here silently invalidated every entry
 * written before the rotation. The 2026-08-16 audit recorded 53 entries
 * verifying, and by 2026-08-21 the same chain failed on its oldest row with
 * nothing tampered with.
 *
 * A list of keys is what makes that recoverable — the old key verifies the old
 * span — and the shape of the list is what keeps it from becoming a way to
 * change what new entries are signed with. Hence the asymmetry these
 * assertions hold: the current key is resolved exactly as it always was, and
 * the new variable can only *add* keys that verification may try.
 */

test("the current key comes first, so it is the one that signs", () => {
    const keys = adminAuditIntegrityKeys({
        ADMIN_AUDIT_INTEGRITY_KEY: "current",
        ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS: "older,oldest",
    });
    assert.deepEqual(keys, ["current", "older", "oldest"]);
});

test("previous keys cannot displace the signing key however they are ordered", () => {
    // The reason this is two variables rather than one list. A single list
    // would let an operator adding history change what new entries are signed
    // with by putting a key first, and nothing would report that they had.
    const keys = adminAuditIntegrityKeys({
        ADMIN_AUDIT_INTEGRITY_KEY: "current",
        ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS: "usurper",
    });
    assert.equal(keys[0], "current");
});

test("NEXTAUTH_SECRET is still the fallback, and still only the fallback", () => {
    assert.deepEqual(
        adminAuditIntegrityKeys({ NEXTAUTH_SECRET: "session" }),
        ["session"]
    );
    // Set alongside a dedicated key it is ignored, which is what stops a
    // rotation of the session secret from touching the audit chain at all.
    assert.deepEqual(
        adminAuditIntegrityKeys({
            ADMIN_AUDIT_INTEGRITY_KEY: "dedicated",
            NEXTAUTH_SECRET: "session",
        }),
        ["dedicated"]
    );
});

test("a previous key equal to the current one is not tried twice", () => {
    // Otherwise every row costs a second HMAC to reach the same answer, and the
    // panel reports two signing keys where there is one.
    assert.deepEqual(
        adminAuditIntegrityKeys({
            ADMIN_AUDIT_INTEGRITY_KEY: "same",
            ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS: "same, same",
        }),
        ["same"]
    );
});

test("whitespace and empty entries in the list are dropped", () => {
    // A trailing comma is what a hand-edited environment variable looks like,
    // and an empty key would otherwise be tried against every row.
    assert.deepEqual(
        adminAuditIntegrityKeys({
            ADMIN_AUDIT_INTEGRITY_KEY: "current",
            ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS: " older , ,, oldest ,",
        }),
        ["current", "older", "oldest"]
    );
});

test("no key anywhere is an empty list, not a list containing nothing", () => {
    // The caller reports `configured: false` from this. A list with one empty
    // string in it would instead verify every row against "" and report a
    // chain that fails for a reason nobody can act on.
    assert.deepEqual(adminAuditIntegrityKeys({}), []);
    assert.deepEqual(
        adminAuditIntegrityKeys({ ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS: "only-old" }),
        ["only-old"]
    );
});
