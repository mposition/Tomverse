// Release C4: §14's version pinning, as a decision rather than a memory.
//
// The rule is one sentence — a new conversation pins to the latest active
// version, an existing one keeps what it started with, and a move is an
// explicit user action. The assertions below are about the ways that sentence
// could quietly stop being true.

import assert from "node:assert/strict";
import test from "node:test";

import {
    PROFILE_BINDING_REFUSALS,
    planProfileBinding,
    profileBindingStatus,
} from "../lib/conversationProfileBinding.ts";

const published = (overrides = {}) => ({
    id: "p-1",
    currentVersionId: "v-3",
    currentRevision: 3,
    modelIds: ["gpt-5-6-luna"],
    ...overrides,
});

const plan = (overrides = {}) =>
    planProfileBinding({
        requested: "p-1",
        flagEnabled: true,
        boundProfileId: null,
        profile: published(),
        ...overrides,
    });

/* ------------------------------------------------------------- the pin */

test("binding pins the profile's current revision, not one the caller named", () => {
    // The client sends a profile; the server writes down which version that
    // was. There is no parameter here a caller could use to ask for a
    // different revision, which is the point.
    const result = plan();
    assert.equal(result.outcome, "bind");
    assert.equal(result.profileVersionId, "v-3");
    assert.equal(result.revision, 3);
});

test("the conversation adopts the version's models", () => {
    // A profile that names a model and then answers on another is a profile
    // whose model choice does nothing.
    assert.deepEqual(plan().modelIds, ["gpt-5-6-luna"]);
});

test("a request that says nothing about the profile changes nothing", () => {
    // `undefined` is not `null`. A PATCH that only renames a conversation
    // must not detach its assistant.
    assert.deepEqual(plan({ requested: undefined }), { outcome: "unchanged" });
    assert.deepEqual(
        planProfileBinding({
            requested: undefined,
            flagEnabled: false,
            boundProfileId: "p-9",
            profile: null,
        }),
        { outcome: "unchanged" }
    );
});

test("re-sending the same profile is a bind, not a no-op", () => {
    // This is how §14's explicit move to a newer revision is expressed. The
    // planner cannot answer "did anything change" because only the caller
    // knows which version id is stored; collapsing it to `unchanged` here
    // would make the move impossible to express at all.
    const result = plan({ boundProfileId: "p-1" });
    assert.equal(result.outcome, "bind");
    assert.equal(result.profileVersionId, "v-3");
});

/* --------------------------------------------------------- the refusals */

test("a draft profile cannot be bound", () => {
    // A profile with no published version would leave the conversation
    // pointing at nothing, and the runtime would then refuse every turn. It
    // is refused once, here, where the owner can still publish.
    const result = plan({
        profile: published({ currentVersionId: null, currentRevision: null }),
    });
    assert.deepEqual(result, {
        outcome: "refused",
        reason: "no_active_version",
    });
});

test("a profile the account does not own is not found, never forbidden", () => {
    assert.deepEqual(plan({ profile: null }), {
        outcome: "refused",
        reason: "not_found",
    });
    assert.equal(PROFILE_BINDING_REFUSALS.not_found.status, 404);
});

test("the flag being off refuses a bind", () => {
    assert.deepEqual(plan({ flagEnabled: false }), {
        outcome: "refused",
        reason: "flag_off",
    });
});

/* ---------------------------------------------------------- the detach */

test("detaching works with the flag off", () => {
    // A rollout control must not be able to trap an account in a state it
    // cannot leave. Switching profiles off would otherwise leave every bound
    // conversation permanently bound.
    assert.deepEqual(
        planProfileBinding({
            requested: null,
            flagEnabled: false,
            boundProfileId: "p-1",
            profile: null,
        }),
        { outcome: "detach" }
    );
});

test("detaching a conversation that has no profile changes nothing", () => {
    assert.deepEqual(
        planProfileBinding({
            requested: null,
            flagEnabled: true,
            boundProfileId: null,
            profile: null,
        }),
        { outcome: "unchanged" }
    );
});

/* --------------------------------------------------------- the status */

test("a conversation on the newest revision is current", () => {
    assert.equal(
        profileBindingStatus({ pinnedRevision: 3, latestRevision: 3 }),
        "current"
    );
});

test("a conversation the owner has published past is superseded", () => {
    assert.equal(
        profileBindingStatus({ pinnedRevision: 3, latestRevision: 5 }),
        "superseded"
    );
});

test("a pin ahead of the latest reads as current, not as an error", () => {
    // Only reachable if the profile's pointer moved backwards, which nothing
    // does today. Reporting `superseded` would offer a "move to the latest"
    // that moves the conversation backwards.
    assert.equal(
        profileBindingStatus({ pinnedRevision: 4, latestRevision: 2 }),
        "current"
    );
});
