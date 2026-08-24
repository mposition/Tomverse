import { strict as assert } from "node:assert";
import test from "node:test";

import {
    autoProductBoundary,
    chatSurfaceAvailable,
} from "../lib/autoProductBoundary.ts";
import { selectAutoModel } from "../lib/autoModelSelection.ts";
import { autoUiAvailability } from "../lib/autoRoutingUi.ts";
import { AVAILABLE_MODELS } from "../lib/models.ts";

/**
 * Decision record v1.2 §3 — the product is settled before the cohort, and one
 * decision serves all three consumers.
 *
 * The tests the decision record asks for by name are the four-row matrix
 * below. What each row is really checking is that a Review conversation is
 * never *counted* as a cohort refusal: it was not a subject of the cohort
 * question, and counting it would dilute the rollout percentage with Review
 * traffic until "what share of Chat users are routed" stopped being readable.
 */

const READY = { ready: true, outstanding: [], problems: [] };
const NOT_READY = {
    ready: false,
    outstanding: ["shadow_report"],
    problems: [],
};
const OPEN_COHORT = {
    killSwitch: false,
    rolloutPercent: 100,
    salt: "cohort-2026-08",
    eligiblePlans: ["Pro", "Max"],
};

/* --------------------------------------------------- the boundary itself */

const boundary = (productKey, overrides = {}) =>
    autoProductBoundary({ productKey, hasConversation: true, ...overrides });

test("chat is the one product Auto may act in", () => {
    assert.equal(boundary("chat").allowed, true);
    assert.equal(boundary("review").reason, "product_not_chat");
    assert.equal(boundary("studio").reason, "product_not_chat");
});

test("no conversation is not a product refusal", () => {
    // No row means no trusted product. That is `no_conversation` further down
    // the order, which counts a different thing.
    const decision = autoProductBoundary({ productKey: null, hasConversation: false });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, null);
});

test("a row whose product is still NULL resolves to Review and is refused", () => {
    // Every conversation in the database is in this state today. Conflating it
    // with "no conversation" is how a Review conversation gets routed during
    // the transition.
    const decision = boundary(null);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "product_not_chat");
    assert.equal(decision.defect, false);
});

test("under strict, a NULL product on an existing row is a defect and still not Chat", () => {
    const decision = boundary(null, { readMode: "strict" });
    assert.equal(decision.reason, "product_not_chat");
    // Reported so a defect is not logged as an ordinary Review conversation.
    assert.equal(decision.defect, true);
});

test("an unrecognised stored product is not Chat", () => {
    // Being permissive here would let a value the allowlist does not know
    // about route turns.
    for (const value of ["code", "insight", "Chat", ""]) {
        assert.equal(boundary(value).reason, "product_not_chat", value);
    }
});

/* ------------------------------------ the four-row matrix, UI availability */

const availability = (productKey, readiness, overrides = {}) =>
    autoUiAvailability({
        subjectKey: "user_abc",
        isGuest: false,
        plan: "Pro",
        productKey,
        hasConversation: true,
        flagEnabled: true,
        cohortConfig: OPEN_COHORT,
        readiness,
        ...overrides,
    });

test("Review + readiness incomplete -> product_not_chat", () => {
    const result = availability("review", NOT_READY);
    assert.equal(result.offered, false);
    assert.equal(result.reason, "product_not_chat");
    // The cohort was not consulted, so there is no bucket to report -- which
    // is the half that keeps the rollout figures about Chat.
    assert.equal(result.cohort, null);
});

test("Review + cohort eligible -> product_not_chat", () => {
    const result = availability("review", READY);
    assert.equal(result.offered, false);
    assert.equal(result.reason, "product_not_chat");
    assert.equal(result.cohort, null);
});

test("Chat + readiness incomplete -> a cohort refusal, not a product one", () => {
    const result = availability("chat", NOT_READY);
    assert.equal(result.offered, false);
    assert.equal(result.reason, "not_eligible");
    assert.equal(result.cohort?.eligible, false);
});

test("Chat + cohort eligible -> offered", () => {
    const result = availability("chat", READY);
    assert.equal(result.offered, true);
    assert.equal(result.reason, null);
});

test("the flag is still checked before anything, including the product", () => {
    // Nothing turns on it, and hashing a subject to answer a question already
    // answered is work the request does not need to do.
    const result = autoUiAvailability({
        subjectKey: "user_abc",
        isGuest: false,
        plan: "Pro",
        productKey: "chat",
        hasConversation: true,
        flagEnabled: false,
        cohortConfig: OPEN_COHORT,
        readiness: READY,
    });
    assert.equal(result.reason, "ui_flag_off");
});

test("a surface with no conversation still asks the cohort", () => {
    // The surface-entry question: may this account start a Chat? There is no
    // row to read a product from, and a null product must not fall back to a
    // surface (§6).
    const entry = (readiness) => availability(null, readiness, { hasConversation: false });
    assert.equal(entry(READY).offered, true);
    assert.equal(entry(NOT_READY).offered, false);
});

test("an existing conversation with no product is refused where a fresh surface is not", () => {
    // The same `productKey: null`, two different answers, and the difference
    // is whether a row exists.
    assert.equal(availability(null, READY).reason, "product_not_chat");
    assert.equal(
        availability(null, READY, { hasConversation: false }).offered,
        true
    );
});

/* ------------------------------------- the same matrix, at turn routing */

const routing = (productKey, readiness, overrides = {}) =>
    selectAutoModel({
        requestedModelId: "gpt-5-6-luna",
        conversation: { selectionMode: "auto", routerModelId: null, routerChallengerTurns: 0 },
        productKey,
        subjectKey: "user_abc",
        isGuest: false,
        plan: "Pro",
        attachmentsUnmeasurable: false,
        text: "이 문장을 영어로 번역해 주세요.",
        attachments: [],
        webSearchRequested: false,
        models: AVAILABLE_MODELS,
        reservedInputTokens: 1_200,
        requestOutputCapTokens: 4_000,
        cohortConfig: OPEN_COHORT,
        readiness,
        ...overrides,
    });

test("turn routing refuses Review before the cohort, in both readiness states", () => {
    for (const readiness of [READY, NOT_READY]) {
        const selection = routing("review", readiness);
        assert.equal(selection.routed, false);
        assert.equal(selection.reason, "product_not_chat");
        // No cohort on the refusal: a bucket logged here would appear in
        // rollout figures for a conversation that was never a subject.
        assert.equal(selection.cohort, undefined);
        // Every refusal still lands on the model the user would have had.
        assert.equal(selection.fallbackModelId, "gpt-5-6-luna");
    }
});

test("turn routing refuses Studio the same way", () => {
    assert.equal(routing("studio", READY).reason, "product_not_chat");
});

test("Chat + readiness incomplete is a cohort refusal at turn routing too", () => {
    const selection = routing("chat", NOT_READY);
    assert.equal(selection.routed, false);
    assert.equal(selection.reason, "cohort_refused");
});

test("Chat + cohort eligible routes", () => {
    assert.equal(routing("chat", READY).routed, true);
});

test("a routed turn is impossible without a Chat product", () => {
    // The property the whole section exists to establish. `null` is in the
    // list because every conversation in the database is NULL today, and it
    // resolves to Review rather than to "unknown, proceed".
    for (const productKey of ["review", "studio", "code", null]) {
        assert.equal(routing(productKey, READY).routed, false, String(productKey));
    }
});

test("product is decided before no_conversation, but null is not product_not_chat", () => {
    const selection = routing(null, READY, { conversation: null });
    assert.equal(selection.reason, "no_conversation");
});

test("a manual Chat conversation is still reported as manual, not as a product refusal", () => {
    const selection = routing("chat", READY, {
        conversation: { selectionMode: "manual", routerModelId: null, routerChallengerTurns: 0 },
    });
    assert.equal(selection.reason, "conversation_is_manual");
});

/* ------------------------------------------------------- surface entry */

test("chatSurfaceAvailable reads the same availability the toggle does", () => {
    // Two callers computing availability separately is exactly the drift that
    // produces a control which saves and changes nothing.
    assert.equal(chatSurfaceAvailable({ offered: true }), true);
    assert.equal(chatSurfaceAvailable({ offered: false }), false);
});
