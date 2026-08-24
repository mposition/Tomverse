import { strict as assert } from "node:assert";
import test from "node:test";

import {
    AUTO_SELECTION_PRODUCT,
    CONVERSATION_PRODUCT_KEYS,
    conversationProductViolation,
    isConversationProductKey,
    PRODUCT_MODALITY,
    productAllowsAutoSelection,
} from "../lib/conversationProduct.ts";

/**
 * The pure half of product boundary decision record v1.2, decision 2. What
 * only a database can establish -- that the CHECKs refuse the same set --
 * is in tests/integration/conversation-product-key.db.test.ts.
 */

test("v1 admits three products, and code is not one of them", () => {
    // The brand axis has four. This column has three, because Tomverse Code
    // writes no Conversation rows and a `code` row would be one nothing opens.
    assert.deepEqual([...CONVERSATION_PRODUCT_KEYS], ["chat", "review", "studio"]);
    assert.equal(isConversationProductKey("code"), false);
});

test("the retired product name is not a product key", () => {
    assert.equal(isConversationProductKey("insight"), false);
    assert.equal(isConversationProductKey("review"), true);
});

test("isConversationProductKey rejects non-strings and near misses", () => {
    for (const value of [null, undefined, 3, {}, [], "Review", "chat ", ""]) {
        assert.equal(isConversationProductKey(value), false, `${String(value)}`);
    }
});

test("every product declares exactly one modality", () => {
    assert.deepEqual(Object.keys(PRODUCT_MODALITY).sort(), [...CONVERSATION_PRODUCT_KEYS].sort());
    assert.equal(PRODUCT_MODALITY.chat, "chat");
    assert.equal(PRODUCT_MODALITY.review, "chat");
    assert.equal(PRODUCT_MODALITY.studio, "image");
});

test("Auto is offered by exactly one product", () => {
    // Written as one allowed product rather than a forbidden list: v1.1
    // forbade review + auto and left studio + auto passing.
    const allowed = CONVERSATION_PRODUCT_KEYS.filter(productAllowsAutoSelection);
    assert.deepEqual(allowed, ["chat"]);
    assert.equal(AUTO_SELECTION_PRODUCT, "chat");
});

/* ------------------------------------------- the eight-combination matrix */

const violation = (productKey, selectionMode, kind) =>
    conversationProductViolation({ productKey, kind, selectionMode });

test("1. review + manual + chat is allowed", () => {
    assert.equal(violation("review", "manual", "chat"), null);
});

test("2. review + auto is refused as Auto-outside-Chat", () => {
    assert.equal(violation("review", "auto", "chat"), "auto_not_chat");
});

test("3. studio + manual + image is allowed", () => {
    assert.equal(violation("studio", "manual", "image"), null);
});

test("4. studio + auto + image is refused as Auto-outside-Chat", () => {
    assert.equal(violation("studio", "auto", "image"), "auto_not_chat");
});

test("5. studio + manual + chat is refused on modality", () => {
    assert.equal(violation("studio", "manual", "chat"), "product_modality");
});

test("6. chat + auto + chat is allowed", () => {
    assert.equal(violation("chat", "auto", "chat"), null);
});

test("7. a NULL productKey is allowed while the transition runs", () => {
    assert.equal(violation(null, "manual", "chat"), null);
    assert.equal(violation(null, "auto", "chat"), null);
    assert.equal(violation(null, "manual", "image"), null);
});

test("an unknown product is named as unknown, not as a modality problem", () => {
    assert.equal(violation("insight", "manual", "chat"), "unknown_product");
});

test("review in the image modality is refused", () => {
    assert.equal(violation("review", "manual", "image"), "product_modality");
});

test("chat in the image modality is refused", () => {
    assert.equal(violation("chat", "manual", "image"), "product_modality");
});

test("the modality check runs before the Auto check", () => {
    // Both are wrong here. Reporting the more fundamental one keeps the
    // refusal counts readable, the same reason lib/autoCohort.ts orders its
    // refusals.
    assert.equal(violation("studio", "auto", "chat"), "product_modality");
});
