import { strict as assert } from "node:assert";
import test from "node:test";

import {
    REVIEW_ENTRY_MARKER,
    chatProductDestination,
    workspaceDestination,
} from "../lib/productEntryDestination.ts";

/**
 * Decision record v1.2 §3: a visitor must not be sent somewhere they will be
 * bounced from. The bounce is the only part they see.
 */

const destination = (overrides = {}) =>
    workspaceDestination({
        chatSurfaceAvailable: false,
        lang: "ko",
        isAuthenticated: true,
        ...overrides,
    });

test("the canonical landing fallback is the Review workspace at /review", () => {
    assert.equal(destination(), "/review?lang=ko");
});

test("a guest keeps the preview entry marker", () => {
    assert.equal(
        destination({ isAuthenticated: false }),
        `/review?lang=ko&${REVIEW_ENTRY_MARKER}`
    );
});

test("an ineligible visitor is never sent to Chat", () => {
    // The whole point: no link that lands on a product and bounces.
    for (const isAuthenticated of [true, false]) {
        assert.ok(
            !destination({ isAuthenticated }).startsWith("/chat"),
            "an ineligible visitor goes to /review"
        );
    }
});

test("an eligible visitor gets Chat", () => {
    assert.equal(
        destination({ chatSurfaceAvailable: true }),
        "/chat?lang=ko"
    );
});

test("the canonical mapping is Review at /review and Chat at /chat", () => {
    assert.equal(
        destination({ chatPathIsChat: true }),
        "/review?lang=ko"
    );
    assert.equal(
        destination({ chatPathIsChat: true, chatSurfaceAvailable: true }),
        "/chat?lang=ko"
    );
});

test("a Chat entry is never marked as a guest preview", () => {
    // Chat's single-model trial is separate from Review's comparison preview.
    assert.ok(
        !destination({
            chatSurfaceAvailable: true,
            isAuthenticated: false,
        }).includes(REVIEW_ENTRY_MARKER)
    );
});

test("the guest Chat card trial is independent of Auto availability", () => {
    for (const chatSurfaceAvailable of [true, false]) {
        assert.equal(chatProductDestination({
            chatSurfaceAvailable,
            guestTrialAvailable: true,
            lang: "ko",
            isAuthenticated: false,
        }), "/chat?lang=ko");
    }
});

test("a guest trial cannot bypass signed-in Chat availability", () => {
    assert.equal(chatProductDestination({
        chatSurfaceAvailable: false,
        guestTrialAvailable: true,
        lang: "en",
        isAuthenticated: true,
    }), null);
    assert.equal(chatProductDestination({
        chatSurfaceAvailable: true,
        guestTrialAvailable: false,
        lang: "en",
        isAuthenticated: true,
    }), "/chat?lang=en");
});

test("an unresolved guest trial keeps the normal sign-in callback", () => {
    assert.equal(chatProductDestination({
        chatSurfaceAvailable: false,
        guestTrialAvailable: false,
        lang: "a&b",
        isAuthenticated: false,
    }), "/auth/signin?callbackUrl=%2Fchat%3Flang%3Da%2526b");
});

test("the language is encoded, not interpolated raw", () => {
    assert.equal(destination({ lang: "zh-Hant" }), "/review?lang=zh-Hant");
    assert.ok(destination({ lang: "a&b" }).includes("a%26b"));
});

test("the former route map remains an explicit compatibility calculation", () => {
    assert.equal(destination({ chatPathIsChat: false }), "/chat?lang=ko");
    assert.equal(
        destination({ chatPathIsChat: false, chatSurfaceAvailable: true }),
        "/chat/workspace?lang=ko"
    );
});
