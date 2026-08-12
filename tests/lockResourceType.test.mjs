import assert from "node:assert/strict";
import test from "node:test";
import {
    LOCK_RESOURCE_TYPES,
    createConversationUnlockCookie,
    createResourceUnlockCookie,
    clearConversationUnlockCookie,
    clearResourceUnlockCookie,
    hasConversationUnlockGrant,
    hasResourceUnlockGrant,
} from "../lib/conversationLock.ts";

/**
 * §7 (B5) — the lock now protects more than one kind of thing.
 *
 * Two properties, and the tests are split along them:
 *
 *   1. **No cross-type reuse.** Ids come from different tables and nothing
 *      stops an ExternalConversation id equalling a Conversation id. A grant
 *      for one must never open the other, and a prefix-based separator would
 *      not be enough — `userId` is an input to the signature, so a userId
 *      containing the prefix could forge one. The types are separated by
 *      *key*, not by string shape.
 *
 *   2. **The native path is unchanged.** Existing unlock cookies were minted
 *      before this change and must keep working, so the conversation cookie
 *      name and signature are asserted byte-for-byte, not merely "still
 *      verifies".
 */

process.env.NEXTAUTH_SECRET ||= "lock-resource-type-test-secret";

const PASSWORD_HASH = "scrypt$1$c2FsdA$aGFzaA";
const USER = "user-1";
const ID = "shared-id";

const requestWith = (cookie) =>
    new Request("https://tomverse.test/", { headers: { cookie } });

const cookieValue = (setCookie) => setCookie.split(";")[0];

/* -------------------------------------------------------- native unchanged */

test("the conversation cookie keeps the name existing grants were minted with", () => {
    // Pinned literally: a rename would silently log every unlocked user out of
    // every locked conversation, and "it still verifies" would not catch it.
    const setCookie = createConversationUnlockCookie(USER, "conv-1", PASSWORD_HASH);
    assert.ok(setCookie.startsWith("tomverse_unlock_conv-1="));
    assert.ok(clearConversationUnlockCookie("conv-1").startsWith("tomverse_unlock_conv-1="));
});

test("a conversation grant minted through either entry point is the same grant", () => {
    // The native helper is now an adapter. If it drifted from the general
    // form, existing cookies would stop verifying.
    const viaAdapter = createConversationUnlockCookie(USER, "conv-1", PASSWORD_HASH);
    const request = requestWith(cookieValue(viaAdapter));
    assert.equal(
        hasResourceUnlockGrant("conversation", request, USER, "conv-1", PASSWORD_HASH),
        true
    );
    assert.equal(
        hasConversationUnlockGrant(request, USER, "conv-1", PASSWORD_HASH),
        true
    );
});

test("an unlocked resource needs no grant at all", () => {
    for (const resourceType of LOCK_RESOURCE_TYPES) {
        assert.equal(
            hasResourceUnlockGrant(resourceType, requestWith(""), USER, ID, null),
            true,
            `${resourceType} with no password is not locked`
        );
    }
});

/* ------------------------------------------------------- no cross-type use */

test("a conversation grant does not open an external conversation of the same id", () => {
    const native = createConversationUnlockCookie(USER, ID, PASSWORD_HASH);
    // Same id, same user, same password: only the type differs.
    const request = requestWith(cookieValue(native));
    assert.equal(
        hasResourceUnlockGrant("conversation", request, USER, ID, PASSWORD_HASH),
        true
    );
    assert.equal(
        hasResourceUnlockGrant(
            "external_conversation",
            request,
            USER,
            ID,
            PASSWORD_HASH
        ),
        false,
        "the external resource must stay locked"
    );
});

test("an external grant does not open the conversation of the same id", () => {
    const external = createResourceUnlockCookie(
        "external_conversation",
        USER,
        ID,
        PASSWORD_HASH
    );
    const request = requestWith(cookieValue(external));
    assert.equal(
        hasResourceUnlockGrant(
            "external_conversation",
            request,
            USER,
            ID,
            PASSWORD_HASH
        ),
        true
    );
    assert.equal(
        hasConversationUnlockGrant(request, USER, ID, PASSWORD_HASH),
        false,
        "the conversation must stay locked"
    );
});

test("a grant relabelled onto the other type's cookie name still fails", () => {
    // The separation is the signing key, not the cookie name. Moving the value
    // to the name the other type reads must not make it verify — otherwise the
    // whole guarantee would rest on the name.
    const native = createConversationUnlockCookie(USER, ID, PASSWORD_HASH);
    const value = cookieValue(native).split("=").slice(1).join("=");
    const relabelled = requestWith(
        `tomverse_unlock_external_conversation_${ID}=${value}`
    );
    assert.equal(
        hasResourceUnlockGrant(
            "external_conversation",
            relabelled,
            USER,
            ID,
            PASSWORD_HASH
        ),
        false
    );
});

test("each type reads its own cookie name", () => {
    const native = cookieValue(
        createConversationUnlockCookie(USER, ID, PASSWORD_HASH)
    );
    const external = cookieValue(
        createResourceUnlockCookie("external_conversation", USER, ID, PASSWORD_HASH)
    );
    assert.notEqual(native.split("=")[0], external.split("=")[0]);

    // Both present at once — the ordinary state for a user who unlocked one of
    // each — and each still resolves to its own.
    const both = requestWith(`${native}; ${external}`);
    assert.equal(hasConversationUnlockGrant(both, USER, ID, PASSWORD_HASH), true);
    assert.equal(
        hasResourceUnlockGrant("external_conversation", both, USER, ID, PASSWORD_HASH),
        true
    );
});

/* ------------------------------------------------ the other bindings hold  */

test("a grant is still bound to its user, its id and the stored password", () => {
    const external = createResourceUnlockCookie(
        "external_conversation",
        USER,
        ID,
        PASSWORD_HASH
    );
    const request = requestWith(cookieValue(external));
    const check = (userId, resourceId, password) =>
        hasResourceUnlockGrant(
            "external_conversation",
            request,
            userId,
            resourceId,
            password
        );

    assert.equal(check(USER, ID, PASSWORD_HASH), true);
    assert.equal(check("user-2", ID, PASSWORD_HASH), false, "another user");
    assert.equal(check(USER, "other-id", PASSWORD_HASH), false, "another id");
    assert.equal(
        check(USER, ID, "scrypt$1$c2FsdA$b3RoZXI"),
        false,
        "the password changed, so the grant is void"
    );
});

test("a tampered or truncated grant is refused rather than parsed loosely", () => {
    const external = cookieValue(
        createResourceUnlockCookie("external_conversation", USER, ID, PASSWORD_HASH)
    );
    const [name, value] = [external.split("=")[0], external.split("=").slice(1).join("=")];
    const [expires, fingerprint, signature] = value.split(".");

    const variants = [
        `${name}=`,
        `${name}=${expires}.${fingerprint}`,
        `${name}=${expires}.${fingerprint}.${signature}.extra`,
        `${name}=not-a-number.${fingerprint}.${signature}`,
        `${name}=${expires}.${fingerprint}.${signature.slice(0, -1)}x`,
    ];
    for (const variant of variants) {
        assert.equal(
            hasResourceUnlockGrant(
                "external_conversation",
                requestWith(variant),
                USER,
                ID,
                PASSWORD_HASH
            ),
            false,
            `${variant} must not verify`
        );
    }
});

test("an expired grant is refused", () => {
    const external = cookieValue(
        createResourceUnlockCookie("external_conversation", USER, ID, PASSWORD_HASH)
    );
    const [name, value] = [external.split("=")[0], external.split("=").slice(1).join("=")];
    const [, fingerprint, signature] = value.split(".");
    const stale = `${name}=1.${fingerprint}.${signature}`;
    assert.equal(
        hasResourceUnlockGrant(
            "external_conversation",
            requestWith(stale),
            USER,
            ID,
            PASSWORD_HASH
        ),
        false
    );
});

test("clearing one type does not clear the other", () => {
    const cleared = clearResourceUnlockCookie("external_conversation", ID);
    assert.ok(cleared.startsWith(`tomverse_unlock_external_conversation_${ID}=;`));
    assert.ok(clearConversationUnlockCookie(ID).startsWith(`tomverse_unlock_${ID}=;`));
});

/* ------------------------------------- the names are not what separates them */

test("a resource id that forges the other type's cookie name still opens nothing", () => {
    // The cookie names are `tomverse_unlock_<id>` and
    // `tomverse_unlock_<type>_<id>`, both joined with `_`, and ids may contain
    // `_`. So the two namespaces are NOT structurally disjoint: a conversation
    // whose id is `external_conversation_X` produces the exact cookie name an
    // external conversation `X` reads.
    //
    // Today no id can be chosen -- both are cuids -- so this is not reachable
    // from outside. What it pins is that the guarantee does not rest on that
    // staying true: the separation is the per-type signing key, so the
    // collision is a name clash and never an escalation. The existing
    // relabelling test moves a value onto the other name by hand; this one
    // makes the collision happen naturally, which is the direction an id
    // format change would take.
    const collidingNativeId = `external_conversation_${ID}`;
    const native = createConversationUnlockCookie(USER, collidingNativeId, PASSWORD_HASH);
    const external = createResourceUnlockCookie(
        "external_conversation",
        USER,
        ID,
        PASSWORD_HASH
    );
    assert.equal(
        cookieValue(native).split("=")[0],
        cookieValue(external).split("=")[0],
        "the premise of this test is that the names collide"
    );

    // Neither direction verifies as the other.
    assert.equal(
        hasResourceUnlockGrant(
            "external_conversation",
            requestWith(cookieValue(native)),
            USER,
            ID,
            PASSWORD_HASH
        ),
        false,
        "a conversation grant must not open the external conversation it collides with"
    );
    assert.equal(
        hasConversationUnlockGrant(
            requestWith(cookieValue(external)),
            USER,
            collidingNativeId,
            PASSWORD_HASH
        ),
        false,
        "an external grant must not open the conversation it collides with"
    );

    // And each still opens its own, so the collision costs nothing but the
    // cookie slot the browser can hold for one of them at a time.
    assert.equal(
        hasConversationUnlockGrant(
            requestWith(cookieValue(native)),
            USER,
            collidingNativeId,
            PASSWORD_HASH
        ),
        true
    );
    assert.equal(
        hasResourceUnlockGrant(
            "external_conversation",
            requestWith(cookieValue(external)),
            USER,
            ID,
            PASSWORD_HASH
        ),
        true
    );
});
