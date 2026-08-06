import assert from "node:assert/strict";
import test from "node:test";
import { decideMemoryInjection } from "../lib/memoryInjectionGate.ts";
import {
    CONVERSATION_MEMORY_MODES,
    DEFAULT_CONVERSATION_MEMORY_MODE,
    isConversationMemoryMode,
    overridesAccountDefault,
    resolveConversationMemoryMode,
} from "../lib/conversationMemoryMode.ts";

/**
 * §8.1 invariant 1 — a conversation's memory mode.
 *
 * The interesting assertions are about `inherit` staying a distinct stored
 * value, and about which way an unrecognized value resolves. Both are places
 * where an obvious-looking simplification changes what the product does to
 * someone's settings.
 */

test("inherit is the default and stays a value of its own", () => {
    // Storing today's account default instead would freeze the conversation
    // against a later change: the user chose to follow the default, not to
    // copy it.
    assert.equal(DEFAULT_CONVERSATION_MEMORY_MODE, "inherit");
    assert.deepEqual([...CONVERSATION_MEMORY_MODES], ["inherit", "on", "off"]);
    assert.equal(overridesAccountDefault("inherit"), false);
    assert.equal(overridesAccountDefault("on"), true);
    assert.equal(overridesAccountDefault("off"), true);
});

test("an explicit mode wins over the account default, in both directions", () => {
    assert.equal(resolveConversationMemoryMode("off", "on"), "off");
    assert.equal(resolveConversationMemoryMode("on", "off"), "on");
});

test("inherit follows the account, including when the account changes", () => {
    assert.equal(resolveConversationMemoryMode("inherit", "on"), "on");
    assert.equal(resolveConversationMemoryMode("inherit", "off"), "off");
});

test("a conversation with no stored mode inherits", () => {
    for (const stored of [null, undefined]) {
        assert.equal(resolveConversationMemoryMode(stored, "off"), "off");
        assert.equal(resolveConversationMemoryMode(stored, "on"), "on");
    }
});

test("only the exact string off disables memory", () => {
    // The column is a string. A value nobody anticipated must not switch off
    // a control the user believes is on -- and the opposite mistake is
    // contained, because the account toggle, the rollout flag and the
    // approved-pair gate all still have to say yes above this.
    for (const stored of ["OFF", "Off", "disabled", "false", "0", "", " "]) {
        assert.equal(
            resolveConversationMemoryMode(stored, "on"),
            "on",
            `${JSON.stringify(stored)} must not read as off`
        );
    }
    for (const accountDefault of ["OFF", "Off", "disabled", "", null]) {
        assert.equal(
            resolveConversationMemoryMode("inherit", accountDefault),
            "on",
            `account default ${JSON.stringify(accountDefault)} must not read as off`
        );
    }
});

test("an unrecognized stored mode does not count as an override", () => {
    // It resolves like inherit, so it must describe itself like inherit too;
    // telling the user "this conversation differs from your default" about a
    // value that follows the default would be a lie.
    assert.equal(overridesAccountDefault("nonsense"), false);
    assert.equal(overridesAccountDefault(null), false);
    assert.equal(overridesAccountDefault(undefined), false);
});

test("the guard admits exactly the three stored values", () => {
    for (const mode of CONVERSATION_MEMORY_MODES) {
        assert.equal(isConversationMemoryMode(mode), true);
    }
    for (const value of ["ON", "", null, undefined, 1, {}, ["off"]]) {
        assert.equal(
            isConversationMemoryMode(value),
            false,
            `${JSON.stringify(value)} is not a stored mode`
        );
    }
});

/* ------------------------------------------------- resolver meets the gate */

/**
 * The composition is asserted here rather than through the service, because
 * §8.1 orders the gate so the rollout flag and the approved-pair check refuse
 * first — and no pair is approved (§12.4). Reaching the mode branch through
 * the service would mean faking a governance decision, so the two halves are
 * joined at the only place that is honest: the pure functions.
 */
const decideWith = (storedMode, accountDefault) =>
    decideMemoryInjection({
        isAuthenticated: true,
        injectionFlagEnabled: true,
        hasApprovedExtractionPair: true,
        accountMasterEnabled: true,
        conversationMode: resolveConversationMemoryMode(
            storedMode,
            accountDefault
        ),
    });

test("a conversation set to off is refused for being off", () => {
    assert.deepEqual(decideWith("off", "on"), {
        allowed: false,
        reason: "conversation_off",
    });
});

test("a conversation set to on runs even when the account default is off", () => {
    assert.deepEqual(decideWith("on", "off"), { allowed: true });
});

test("inherit tracks the account default in both directions", () => {
    assert.deepEqual(decideWith("inherit", "on"), { allowed: true });
    assert.deepEqual(decideWith("inherit", "off"), {
        allowed: false,
        reason: "conversation_off",
    });
});

test("the mode never overrides a gate above it", () => {
    // §8.1: the mode must not bypass the flag, revocation, authentication or
    // the account toggle. Explicitly `on` is the case that would be tempting
    // to let through.
    const above = [
        { isAuthenticated: false, reason: "guest" },
        { injectionFlagEnabled: false, reason: "flag_off" },
        { hasApprovedExtractionPair: false, reason: "no_approved_pair" },
        { accountMasterEnabled: false, reason: "account_off" },
    ];
    for (const { reason, ...override } of above) {
        assert.deepEqual(
            decideMemoryInjection({
                isAuthenticated: true,
                injectionFlagEnabled: true,
                hasApprovedExtractionPair: true,
                accountMasterEnabled: true,
                conversationMode: resolveConversationMemoryMode("on", "on"),
                ...override,
            }),
            { allowed: false, reason }
        );
    }
});
