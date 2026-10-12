import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CONVERSATION_PRODUCT_KEYS } from "../lib/conversationProduct.ts";
import {
    conversationProductLabel,
    CHAT_WORKSPACE_COMPATIBILITY_PATH,
    CHAT_WORKSPACE_PATH,
    LEGACY_REVIEW_PATH,
    PRODUCT_LABEL,
    PRODUCT_SURFACE_PATH,
    productSurfacePathOrReview,
    resolveLegacyChatDeepLink,
    REVIEW_WORKSPACE_PATH,
} from "../lib/productSurfaceRoutes.ts";

/**
 * Stored-product routing: docs/ui-contracts/chat-product-switcher.md. The stored product, never a URL guess, decides
 * which canonical workspace opens the conversation.
 */

test("every product has a surface path and a label", () => {
    for (const productKey of CONVERSATION_PRODUCT_KEYS) {
        assert.ok(PRODUCT_SURFACE_PATH[productKey], productKey);
        assert.ok(PRODUCT_LABEL[productKey], productKey);
    }
});

test("a Review conversation moves off the legacy /chat path", () => {
    // Historical bookmarks may still point at /chat after the cutover.
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

test("Chat and Review expose canonical entries while the prior Chat URL remains inbound-only", () => {
    assert.equal(CHAT_WORKSPACE_PATH, "/chat");
    assert.equal(CHAT_WORKSPACE_COMPATIBILITY_PATH, "/chat/workspace");
    assert.equal(REVIEW_WORKSPACE_PATH, "/review");
});

test("a public share follows its stored product and defaults unknown rows to Review", () => {
    assert.equal(productSurfacePathOrReview("chat"), "/chat");
    assert.equal(productSurfacePathOrReview("review"), "/review");
    assert.equal(productSurfacePathOrReview("studio"), "/studio");
    assert.equal(productSurfacePathOrReview(null), "/review");
    assert.equal(productSurfacePathOrReview("future-product"), "/review");
});

test("the generic account menu defaults to Review and accepts an explicit Chat product", () => {
    const authButton = readFileSync(
        new URL("../components/auth/AuthButton.tsx", import.meta.url),
        "utf8"
    );
    assert.match(
        authButton,
        /currentProduct = "review"/
    );
    assert.match(
        authButton,
        /PRODUCT_SURFACE_PATH\[currentProduct\]/
    );
    assert.match(authButton, /currentProduct\?: ChatWorkspaceProduct/);
    assert.match(authButton, /returnTo=\{accountCallbackUrl\}/);
});

test("shared account, quota, artifact, and sidebar returns carry the actual workspace product", () => {
    const expectedProductAwareFiles = [
        "../components/chat/UserUsageSummary.tsx",
        "../components/chat/UsageLimitModal.tsx",
        "../components/chat/ChatMessageList.tsx",
        "../components/chat/GeneratedArtifactCard.tsx",
        "../components/chat/SidebarAccountRailButton.tsx",
    ];
    for (const relativePath of expectedProductAwareFiles) {
        const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
        assert.match(source, /currentProduct(?:\s*=\s*"review")?/,
            `${relativePath} must accept the workspace product`);
        assert.match(source, /localizedProductHref\(currentProduct, lang\)/,
            `${relativePath} must derive its return from the workspace product`);
    }

    for (const relativePath of [
        "../components/chat/DesktopChatShell.tsx",
        "../components/chat/MobileChatShell.tsx",
    ]) {
        const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
        assert.match(source, /<ChatSidebar[\s\S]*?currentProduct=\{currentProduct\}/,
            `${relativePath} must carry product identity into shared account actions`);
        assert.match(source, /<ChatApp[\s\S]*?currentProduct=\{currentProduct\}/,
            `${relativePath} must carry product identity into quota and artifact actions`);
    }

    const sidebar = readFileSync(
        new URL("../components/chat/ChatSidebar.tsx", import.meta.url),
        "utf8"
    );
    assert.match(sidebar, /<AuthButton[\s\S]*?currentProduct=\{currentProduct\}/);
    assert.match(sidebar, /<SidebarAccountRailButton[\s\S]*?currentProduct=\{currentProduct\}/);
    assert.match(sidebar, /<UserUsageSummary[\s\S]*?currentProduct=\{currentProduct\}/);
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
