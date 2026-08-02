import assert from "node:assert/strict";
import { test } from "node:test";
import {
    accountNamespace,
    conversationIdBelongsToIdentity,
    describeIdentityTransition,
    guestNamespace,
    identityNamespaceKey,
    isGuestConversationId,
    resolveIdentityNamespace,
    selectionAfterIdentityTransition,
} from "../lib/chatIdentityNamespace.ts";

test("the namespace follows the session, and is unresolved while it loads", () => {
    assert.deepEqual(resolveIdentityNamespace("loading", null), {
        kind: "unresolved",
    });
    assert.deepEqual(resolveIdentityNamespace("unauthenticated", null), {
        kind: "guest",
    });
    assert.deepEqual(resolveIdentityNamespace("authenticated", "user-1"), {
        kind: "account",
        userId: "user-1",
    });
    // A session that is still loading but already carries a user is that user.
    assert.deepEqual(resolveIdentityNamespace("loading", "user-1"), {
        kind: "account",
        userId: "user-1",
    });
});

test("guest ids belong to guests and to no account", () => {
    assert.equal(isGuestConversationId("guest_1754000000000"), true);
    assert.equal(isGuestConversationId("cm5abc123"), false);
    assert.equal(isGuestConversationId(null), false);

    assert.equal(
        conversationIdBelongsToIdentity("guest_1", guestNamespace()),
        true
    );
    assert.equal(
        conversationIdBelongsToIdentity("guest_1", accountNamespace("u1")),
        false
    );
    assert.equal(
        conversationIdBelongsToIdentity("cm5abc123", accountNamespace("u1")),
        true
    );
    assert.equal(
        conversationIdBelongsToIdentity("cm5abc123", guestNamespace()),
        false
    );
});

test("nothing belongs to an unresolved session", () => {
    for (const id of ["guest_1", "cm5abc123", null]) {
        assert.equal(
            conversationIdBelongsToIdentity(id, { kind: "unresolved" }),
            false
        );
    }
});

test("signing in is a guest-to-account transition", () => {
    const transition = describeIdentityTransition(
        guestNamespace(),
        accountNamespace("u1")
    );
    assert.equal(transition.changed, true);
    assert.equal(transition.guestToAccount, true);
    assert.equal(transition.accountSwitch, false);
});

test("swapping accounts is a transition; reloading the same one is not", () => {
    const switched = describeIdentityTransition(
        accountNamespace("a"),
        accountNamespace("b")
    );
    assert.equal(switched.changed, true);
    assert.equal(switched.accountSwitch, true);

    const same = describeIdentityTransition(
        accountNamespace("a"),
        accountNamespace("a")
    );
    assert.equal(same.changed, false);
    assert.equal(same.accountSwitch, false);
});

test("the first resolution is marked initial, so nothing is treated as carried over", () => {
    const transition = describeIdentityTransition(null, accountNamespace("u1"));
    assert.equal(transition.changed, true);
    assert.equal(transition.initial, true);
});

test("a guest id is released on sign-in and never handed to the account API", () => {
    const transition = describeIdentityTransition(
        guestNamespace(),
        accountNamespace("u1")
    );
    assert.equal(
        selectionAfterIdentityTransition("guest_1754000000000", transition),
        null
    );
});

test("account A's conversation is released when account B signs in", () => {
    const transition = describeIdentityTransition(
        accountNamespace("a"),
        accountNamespace("b")
    );
    assert.equal(selectionAfterIdentityTransition("cm5abc123", transition), null);
});

test("signing out releases the account conversation but keeps guests on theirs", () => {
    const signOut = describeIdentityTransition(
        accountNamespace("a"),
        guestNamespace()
    );
    assert.equal(selectionAfterIdentityTransition("cm5abc123", signOut), null);
    assert.equal(
        selectionAfterIdentityTransition("guest_1", signOut),
        "guest_1"
    );
});

test("a selection survives when the identity did not change", () => {
    const unchanged = describeIdentityTransition(
        guestNamespace(),
        guestNamespace()
    );
    // A guest pressing F5 keeps the conversation they were reading.
    assert.equal(
        selectionAfterIdentityTransition("guest_1", unchanged),
        "guest_1"
    );
});

test("the namespace key distinguishes every identity, including two accounts", () => {
    assert.equal(identityNamespaceKey(guestNamespace()), "guest");
    assert.equal(identityNamespaceKey({ kind: "unresolved" }), "unresolved");
    assert.notEqual(
        identityNamespaceKey(accountNamespace("a")),
        identityNamespaceKey(accountNamespace("b"))
    );
    assert.notEqual(
        identityNamespaceKey(accountNamespace("a")),
        identityNamespaceKey(guestNamespace())
    );
});
