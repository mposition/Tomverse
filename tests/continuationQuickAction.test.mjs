import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { continuationQuickActionState } from "../lib/continuationQuickAction.ts";

/**
 * The list's trailing action: which state, and what may reach the network.
 *
 * docs/policy/external-conversation-continuation.md §6, §7, §8.
 *
 * The resolver is pure and the ordering inside it is the whole decision, so it
 * is tested directly rather than through a rendered row. What a rendered row
 * adds -- that the button exists, that a click sends one request, that a menu
 * closes on Escape -- is in tests/e2e/import-list-continuation-quick-action.
 */

test("no continuation yet offers to create one", () => {
    assert.equal(
        continuationQuickActionState({
            locked: false,
            continuationCount: 0,
            hasLatest: false,
        }),
        "create"
    );
});

test("exactly one continuation opens it instead of creating another", () => {
    assert.equal(
        continuationQuickActionState({
            locked: false,
            continuationCount: 1,
            hasLatest: true,
        }),
        "open_existing"
    );
});

test("more than one offers a choice, never a silent pick", () => {
    for (const count of [2, 3, 17]) {
        assert.equal(
            continuationQuickActionState({
                locked: false,
                continuationCount: count,
                hasLatest: true,
            }),
            "choose_existing",
            `count ${count}`
        );
    }
});

test("the flag decides before anything else", () => {
    // Off means absent, not disabled, and not "locked" either: with the
    // rollout switch off there is nothing on this row to act on, and a greyed
    // control would advertise a feature the account cannot reach.
    for (const locked of [false, true]) {
        for (const continuationCount of [0, 1, 5]) {
            assert.equal(
                continuationQuickActionState({
                    continuationEnabled: false,
                    locked,
                    continuationCount,
                    hasLatest: continuationCount > 0,
                }),
                "hidden",
                `locked=${locked} count=${continuationCount}`
            );
        }
    }
});

test("a locked source asks for the password before it counts anything", () => {
    // Even with continuations already made: the action a locked row offers is
    // the way back to the source, and the create endpoint is never called.
    assert.equal(
        continuationQuickActionState({
            locked: true,
            continuationCount: 0,
            hasLatest: false,
        }),
        "locked"
    );
    assert.equal(
        continuationQuickActionState({
            locked: true,
            continuationCount: 3,
            hasLatest: true,
        }),
        "locked"
    );
});

test("a count with nothing to open never renders a button with nowhere to go", () => {
    // The two fields come from one query and should agree. If they ever do
    // not, "create" is the only answer that leads somewhere.
    assert.equal(
        continuationQuickActionState({
            locked: false,
            continuationCount: 1,
            hasLatest: false,
        }),
        "create"
    );
});

test("the quick action never posts from the locked or open states", () => {
    // A source assertion, because the claim is about which branches can reach
    // the network at all. Only the create branch calls the launcher; the other
    // two render links.
    const source = readFileSync(
        "components/imports/ContinuationQuickAction.tsx",
        "utf8"
    );
    const code = source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");

    const starts = code.match(/launcher\.start\(\)/g) ?? [];
    assert.equal(starts.length, 1, "exactly one call site posts");

    const lockedBranch = code.slice(
        code.indexOf('if (state === "locked")'),
        code.indexOf('if (state === "open_existing"')
    );
    assert.doesNotMatch(lockedBranch, /launcher\./);
    // It routes to the source's own page rather than unlocking here.
    assert.match(lockedBranch, /settings\/imports\/conversations\//);
});

test("the list's create logic is the detail card's, not a copy of it", () => {
    // The defect this guards is a second implementation of the idempotency
    // key. Both components must reach the network only through the launcher.
    for (const path of [
        "components/imports/ContinuationQuickAction.tsx",
        "components/imports/ContinueInTomverseCard.tsx",
    ]) {
        const source = readFileSync(path, "utf8");
        assert.match(
            source,
            /useContinuationLauncher/,
            `${path} must use the shared launcher`
        );
        assert.doesNotMatch(
            source,
            /idempotencyKey/,
            `${path} must not mention the key at all`
        );
        assert.doesNotMatch(
            source,
            /fetch\(/,
            `${path} must not post on its own`
        );
    }
});
