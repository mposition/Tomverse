import { strict as assert } from "node:assert";
import test from "node:test";

import {
    REVIEW_ENTRY_MARKER,
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

test("today everybody gets the Review workspace, which is still /chat", () => {
    // Chat is not released and chatSurfaceAvailable is false for everybody, so
    // this function changes nothing yet -- which is the point of landing it
    // before the cutover rather than during it.
    assert.equal(destination(), "/chat?lang=ko");
});

test("a guest keeps the preview entry marker", () => {
    assert.equal(
        destination({ isAuthenticated: false }),
        `/chat?lang=ko&${REVIEW_ENTRY_MARKER}`
    );
});

test("an ineligible visitor is never sent to Chat", () => {
    // The whole point: no link that lands on a product and bounces.
    for (const isAuthenticated of [true, false]) {
        assert.ok(
            !destination({ isAuthenticated, chatPathIsChat: true }).startsWith("/chat"),
            "after the cutover an ineligible visitor goes to /review"
        );
    }
});

test("an eligible visitor gets Chat", () => {
    assert.equal(
        destination({ chatSurfaceAvailable: true }),
        "/chat?lang=ko"
    );
});

test("after the cutover Review moves to /review and Chat keeps /chat", () => {
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
    // A guest cannot be Chat-eligible, and claiming a preview that does not
    // exist is the same failure as a toggle that does nothing.
    assert.ok(
        !destination({
            chatSurfaceAvailable: true,
            isAuthenticated: false,
        }).includes(REVIEW_ENTRY_MARKER)
    );
});

test("the language is encoded, not interpolated raw", () => {
    assert.equal(destination({ lang: "zh-Hant" }), "/chat?lang=zh-Hant");
    assert.ok(destination({ lang: "a&b" }).includes("a%26b"));
});
