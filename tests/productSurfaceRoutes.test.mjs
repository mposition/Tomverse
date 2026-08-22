import { strict as assert } from "node:assert";
import test from "node:test";

import { CONVERSATION_PRODUCT_KEYS } from "../lib/conversationProduct.ts";
import {
    conversationProductLabel,
    LEGACY_REVIEW_PATH,
    PRODUCT_LABEL,
    PRODUCT_SURFACE_PATH,
    resolveLegacyChatDeepLink,
} from "../lib/productSurfaceRoutes.ts";

/**
 * Decision record v1.2 §8 — prepared, not wired. Nothing calls these in
 * production yet; the rule is written now because it needs productKey settled
 * before it can be applied, and writing it later means writing it under
 * deadline.
 */

test("every product has a surface path and a label", () => {
    for (const productKey of CONVERSATION_PRODUCT_KEYS) {
        assert.ok(PRODUCT_SURFACE_PATH[productKey], productKey);
        assert.ok(PRODUCT_LABEL[productKey], productKey);
    }
});

test("a Review conversation moves off the legacy /chat path", () => {
    // The bookmark case: every Review deep link points at /chat today.
    assert.deepEqual(resolveLegacyChatDeepLink("review"), {
        action: "move",
        path: "/review",
    });
});

test("a Chat conversation stays where it is", () => {
    assert.deepEqual(resolveLegacyChatDeepLink("chat"), {
        action: "stay",
        path: LEGACY_REVIEW_PATH,
    });
});

test("a Studio conversation moves to /studio", () => {
    assert.deepEqual(resolveLegacyChatDeepLink("studio"), {
        action: "move",
        path: "/studio",
    });
});

test("a conversation with no stored product is reported, never guessed", () => {
    // A redirect decided from a NULL column would move Review conversations to
    // Chat or leave them behind, and nothing else on the row could say which.
    assert.deepEqual(resolveLegacyChatDeepLink(null), {
        action: "report",
        path: null,
    });
});

test("an unrecognised product is reported rather than routed", () => {
    for (const value of ["code", "insight", ""]) {
        assert.equal(resolveLegacyChatDeepLink(value).action, "report", value);
    }
});

test("the legacy path and Review's canonical path are separate constants", () => {
    // They mean different things -- one is a fact about today, one a decision
    // about afterwards -- and they stop being equal at the cutover.
    assert.equal(LEGACY_REVIEW_PATH, "/chat");
    assert.equal(PRODUCT_SURFACE_PATH.review, "/review");
    assert.notEqual(LEGACY_REVIEW_PATH, PRODUCT_SURFACE_PATH.review);
});

/* ------------------------------------------------------------ labelling */

test("an image conversation is labelled Studio before /studio exists", () => {
    // §8's open item: recording it as Studio and showing it under Review
    // chrome puts the user and the data back to naming different products.
    assert.equal(
        conversationProductLabel({ productKey: "studio", kind: "image" }),
        "Tomverse Studio"
    );
});

test("an image conversation is labelled Studio even before the backfill", () => {
    // kind = 'image' can only ever be Studio -- the modality constraint says
    // so -- which makes this fallback a fact rather than a guess.
    assert.equal(
        conversationProductLabel({ productKey: null, kind: "image" }),
        "Tomverse Studio"
    );
});

test("a chat-modality conversation with no product is labelled Review", () => {
    // kind = 'chat' says nothing about Chat versus Review, so this follows the
    // transition read mode rather than inventing a third answer.
    assert.equal(
        conversationProductLabel({ productKey: null, kind: "chat" }),
        "Tomverse Review"
    );
});

test("a stored product wins over the modality fallback", () => {
    assert.equal(
        conversationProductLabel({ productKey: "chat", kind: "chat" }),
        "Tomverse Chat"
    );
});

test("no label carries the retired product name", () => {
    for (const label of Object.values(PRODUCT_LABEL)) {
        assert.ok(!label.includes("Insight"), label);
    }
});
