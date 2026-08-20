import assert from "node:assert/strict";
import test from "node:test";
import {
    ASSISTANT_PROFILE_CHAT_PATH,
    assistantProfileCreateHref,
    consumePendingChatProfile,
    isChatReturnRequest,
    isPlausibleProfileId,
    stashPendingChatProfile,
} from "../lib/assistantProfileReturn.ts";

/**
 * The round trip's whole security argument is that nothing it carries is a
 * destination. These tests pin that: the query parameter is compared to one
 * literal and never followed, and the return path is a constant.
 */

test("the return path is a constant, not something the caller supplies", () => {
    assert.equal(ASSISTANT_PROFILE_CHAT_PATH, "/chat");
    // The create href is the only URL this module builds, and its only
    // variable part is a flag with two possible values.
    assert.equal(assistantProfileCreateHref(), "/settings/assistants/new");
    assert.equal(
        assistantProfileCreateHref({ fromChat: true }),
        "/settings/assistants/new?from=chat"
    );
});

test("only the exact chat flag reads as a return request", () => {
    assert.equal(isChatReturnRequest("?from=chat"), true);
    assert.equal(isChatReturnRequest("from=chat"), true);
    assert.equal(isChatReturnRequest("?lang=ko&from=chat"), true);

    for (const search of [
        "",
        "?from=",
        "?from=Chat",
        "?from=chatt",
        "?from=https://example.com",
        "?from=//example.com",
        "?from=/settings/assistants",
        "?returnTo=/chat",
        "?lang=ko",
    ]) {
        assert.equal(
            isChatReturnRequest(search),
            false,
            `${search} must not read as a return request`
        );
    }
});

test("a URL in the flag is never treated as a place to go", () => {
    // The failure this exists to make impossible: a `returnTo` parameter that
    // is navigated to. There is no branch that reads the parameter as a
    // destination, so an absolute URL is simply "not chat".
    assert.equal(isChatReturnRequest("?from=https://evil.example"), false);
    assert.equal(isChatReturnRequest("?from=javascript:alert(1)"), false);
});

test("only an id shaped like one this product mints is accepted", () => {
    assert.equal(isPlausibleProfileId("cmt1cx5yq001z02migrx1oe9v"), true);
    assert.equal(isPlausibleProfileId("a_b-c"), true);

    for (const value of [
        "",
        " ",
        "a/b",
        "../../etc/passwd",
        "https://example.com",
        "javascript:alert(1)",
        "a b",
        "a:b",
        "x".repeat(129),
        null,
        undefined,
        42,
        {},
    ]) {
        assert.equal(
            isPlausibleProfileId(value),
            false,
            `${JSON.stringify(value)} must not pass as a profile id`
        );
    }
});

/* ------------------------------------------------------------- handoff */

const withSessionStorage = (run) => {
    const store = new Map();
    globalThis.window = {
        sessionStorage: {
            getItem: (key) => (store.has(key) ? store.get(key) : null),
            setItem: (key, value) => store.set(key, String(value)),
            removeItem: (key) => store.delete(key),
        },
    };
    try {
        return run(store);
    } finally {
        delete globalThis.window;
    }
};

test("a stashed profile is read exactly once", () => {
    withSessionStorage(() => {
        stashPendingChatProfile("cmt1cx5yq001z02migrx1oe9v");
        assert.equal(consumePendingChatProfile(), "cmt1cx5yq001z02migrx1oe9v");
        // The second read is the one that matters: a refresh, or a second tab
        // restoring the same conversation, must not reapply a served request.
        assert.equal(consumePendingChatProfile(), null);
    });
});

test("a malformed stored value is refused rather than sent", () => {
    withSessionStorage((store) => {
        store.set("tomverse_pending_chat_assistant_profile", "../../admin");
        assert.equal(consumePendingChatProfile(), null);
        // Cleared even though it was refused: leaving it would retry the same
        // bad value on every mount.
        assert.equal(store.has("tomverse_pending_chat_assistant_profile"), false);
    });
});

test("an id that is not one is never stashed in the first place", () => {
    withSessionStorage((store) => {
        stashPendingChatProfile("https://example.com/x");
        assert.equal(store.size, 0);
    });
});

test("storage being unavailable loses the handoff and nothing else", () => {
    const throwing = {
        getItem: () => {
            throw new Error("denied");
        },
        setItem: () => {
            throw new Error("denied");
        },
        removeItem: () => {
            throw new Error("denied");
        },
    };
    globalThis.window = { sessionStorage: throwing };
    try {
        assert.doesNotThrow(() => stashPendingChatProfile("abc"));
        assert.equal(consumePendingChatProfile(), null);
    } finally {
        delete globalThis.window;
    }
});

test("on the server there is no handoff and no crash", () => {
    assert.equal(typeof globalThis.window, "undefined");
    assert.doesNotThrow(() => stashPendingChatProfile("abc"));
    assert.equal(consumePendingChatProfile(), null);
});
