import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
    LOCK_RESOURCE_TYPES,
    isLockResourceType,
    unlockCookieNameFor,
    unlockGrantMaterial,
} from "../lib/resourceLockCore.ts";

/**
 * docs/policy/external-conversation-import-and-memory.md §7.
 *
 * Two properties, and the second is the one with teeth:
 *
 *   * the `conversation` namespace is byte-for-byte what Release A shipped, so
 *     a grant a browser is already holding survives this deploy;
 *   * a grant is bound to type AND id in both the cookie name and the signed
 *     material, so two resources whose ids happen to be equal — both id spaces
 *     are cuids from the same generator — can never unlock each other.
 */

const SHARED_ID = "clx0000000000000000000000";

test("the conversation cookie name is unchanged from Release A", () => {
    // Pinned as a literal on purpose. Any edit that changes this string logs
    // every user holding a grant out, and that has to be a deliberate act
    // rather than a side effect of refactoring.
    assert.equal(
        unlockCookieNameFor("conversation", SHARED_ID),
        `tomverse_unlock_${SHARED_ID}`
    );
});

test("the conversation signed material is unchanged from Release A", () => {
    assert.equal(
        unlockGrantMaterial({
            resourceType: "conversation",
            userId: "user-1",
            resourceId: SHARED_ID,
            expiresAt: 1_700_000_000,
            fingerprint: "print",
        }),
        `user-1:${SHARED_ID}:1700000000:print`
    );
});

test("an external resource is stored under a different cookie name", () => {
    assert.notEqual(
        unlockCookieNameFor("external_conversation", SHARED_ID),
        unlockCookieNameFor("conversation", SHARED_ID)
    );
});

test("equal ids across types never produce the same signed material", () => {
    const common = {
        userId: "user-1",
        resourceId: SHARED_ID,
        expiresAt: 1_700_000_000,
        fingerprint: "print",
    };
    assert.notEqual(
        unlockGrantMaterial({ ...common, resourceType: "conversation" }),
        unlockGrantMaterial({
            ...common,
            resourceType: "external_conversation",
        })
    );
});

test("a conversation grant's signature does not verify as an external one", () => {
    // The real consequence of the property above: even if an attacker moved a
    // valid cookie into the other namespace's name, the HMAC is over a
    // different string and simply fails.
    const secret = "resource-lock-test-secret";
    const common = {
        userId: "user-1",
        resourceId: SHARED_ID,
        expiresAt: 1_700_000_000,
        fingerprint: "print",
    };
    const sign = (resourceType) =>
        createHmac("sha256", secret)
            .update(unlockGrantMaterial({ ...common, resourceType }))
            .digest("base64url");
    assert.notEqual(sign("conversation"), sign("external_conversation"));
});

test("the id cannot be smuggled across a namespace boundary", () => {
    // A conversation id that looks like the other namespace's prefix must not
    // collide with it, or the separation is decorative. The separator does
    // this structurally: `_` after the prefix for a conversation, `.` for
    // anything else, and ids cannot contain `.`.
    assert.notEqual(
        unlockCookieNameFor("conversation", `ext_${SHARED_ID}`),
        unlockCookieNameFor("external_conversation", SHARED_ID)
    );
    assert.notEqual(
        unlockCookieNameFor(
            "conversation",
            `external_conversation_${SHARED_ID}`
        ),
        unlockCookieNameFor("external_conversation", SHARED_ID)
    );
});

test("an identifier that could forge another identity is refused", () => {
    // Both builders concatenate, so a separator inside an identifier would let
    // one (user, resource) pair produce another's signed material. Refused
    // rather than escaped: every real id is a cuid, so anything else here is a
    // bug, and throwing surfaces it instead of signing something surprising.
    for (const bad of [
        `external_conversation:${SHARED_ID}`,
        "user:1:1700000000:print",
        "has space",
        "has.dot",
        "",
    ]) {
        assert.throws(() =>
            unlockGrantMaterial({
                resourceType: "conversation",
                userId: "user-1",
                resourceId: bad,
                expiresAt: 1,
                fingerprint: "print",
            })
        );
        assert.throws(() => unlockCookieNameFor("conversation", bad));
    }
    assert.throws(() =>
        unlockGrantMaterial({
            resourceType: "conversation",
            userId: "alice:conv-1:1700000000",
            resourceId: SHARED_ID,
            expiresAt: 1,
            fingerprint: "print",
        })
    );
});

test("every declared type has a distinct name and material", () => {
    const names = new Set(
        LOCK_RESOURCE_TYPES.map((type) => unlockCookieNameFor(type, SHARED_ID))
    );
    const materials = new Set(
        LOCK_RESOURCE_TYPES.map((type) =>
            unlockGrantMaterial({
                resourceType: type,
                userId: "user-1",
                resourceId: SHARED_ID,
                expiresAt: 1,
                fingerprint: "print",
            })
        )
    );
    assert.equal(names.size, LOCK_RESOURCE_TYPES.length);
    assert.equal(materials.size, LOCK_RESOURCE_TYPES.length);
});

test("only declared types are accepted", () => {
    assert.ok(isLockResourceType("conversation"));
    assert.ok(isLockResourceType("external_conversation"));
    assert.ok(!isLockResourceType("memory"));
    assert.ok(!isLockResourceType(""));
    assert.ok(!isLockResourceType(null));
});
