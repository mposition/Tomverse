import assert from "node:assert/strict";
import test from "node:test";

import { temporaryChatOnCreated, temporaryChatOnLeave, temporaryChatOnView } from "../lib/temporaryChatClientCore.ts";
import { chatPersonalizationCopy } from "../locales/chatPersonalization.ts";
import { SUPPORTED_LANGUAGES } from "../lib/language.ts";

/**
 * "Deleted when you leave it": every way of leaving a temporary Chat deletes
 * it from the browser, and the copy names the server's 24-hour fallback for
 * the cases a browser delete cannot reach.
 */

const created = { owner: "u-1", id: "c-temp", entered: false };
const opened = { ...created, entered: true };

test("the Chat screen going away deletes the temporary Chat, opened or not", () => {
    // An in-app navigation unmounts the page before the open conversation
    // changes; a reload or closed tab fires pagehide. Both reach this.
    assert.equal(temporaryChatOnLeave(opened), "c-temp");
    assert.equal(temporaryChatOnLeave(created), "c-temp");
    assert.equal(temporaryChatOnLeave(null), null);
});

test("opening another conversation or a new one after it deletes it", () => {
    assert.deepEqual(temporaryChatOnView(opened, { ownerKey: "u-1", currentChatId: "c-other" }), {
        next: null, deleteId: "c-temp", disarm: false,
    });
    assert.deepEqual(temporaryChatOnView(opened, { ownerKey: "u-1", currentChatId: null }), {
        next: null, deleteId: "c-temp", disarm: false,
    });
});

test("a signed-in account changing tries to delete it", () => {
    for (const ownerKey of [null, "u-2"]) {
        assert.deepEqual(temporaryChatOnView(created, { ownerKey, currentChatId: null }), {
            next: null, deleteId: "c-temp", disarm: true,
        });
    }
});

test("while its first message is still being saved it is kept, and opening it marks it entered", () => {
    assert.deepEqual(temporaryChatOnView(created, { ownerKey: "u-1", currentChatId: null }), {
        next: created, deleteId: null, disarm: false,
    });
    assert.deepEqual(temporaryChatOnView(created, { ownerKey: "u-1", currentChatId: "c-temp" }), {
        next: opened, deleteId: null, disarm: true,
    });
    assert.deepEqual(temporaryChatOnView(opened, { ownerKey: "u-1", currentChatId: "c-temp" }), {
        next: opened, deleteId: null, disarm: false,
    });
    assert.deepEqual(temporaryChatOnView(null, { ownerKey: "u-1", currentChatId: "c-temp" }), {
        next: null, deleteId: null, disarm: false,
    });
});

test("opening another conversation before the temporary one was ever opened deletes it", () => {
    assert.deepEqual(temporaryChatOnView(created, { ownerKey: "u-1", currentChatId: "c-other" }), {
        next: null, deleteId: "c-temp", disarm: false,
    });
});

const onCreated = (overrides) => temporaryChatOnCreated({
    ownerKey: "u-1",
    created: { id: "c-temp", temporary: true },
    screenLeft: false,
    currentChatId: null,
    previous: null,
    ...overrides,
});

test("a create that answers after the person left the screen or opened another conversation is deleted on arrival", () => {
    assert.deepEqual(onCreated({ screenLeft: true }), { track: null, deleteIds: ["c-temp"] });
    assert.deepEqual(onCreated({ ownerKey: null }), { track: null, deleteIds: ["c-temp"] });
    assert.deepEqual(onCreated({ currentChatId: "c-other" }), { track: null, deleteIds: ["c-temp"] });
    // Still on the new chat it was started from: tracked.
    assert.deepEqual(onCreated({}), { track: created, deleteIds: [] });
});

test("a newer temporary Chat replaces an older one that was never opened, which is deleted", () => {
    const older = { owner: "u-1", id: "c-older", entered: false };
    assert.deepEqual(onCreated({ previous: older }), { track: created, deleteIds: ["c-older"] });
    // The same response twice changes nothing.
    assert.deepEqual(onCreated({ previous: created }), { track: created, deleteIds: [] });
});

test("an ordinary conversation, or a response that is not one, is never deleted here", () => {
    const older = { owner: "u-1", id: "c-older", entered: false };
    for (const other of [{ id: "c-1", temporary: false }, { id: "c-1" }, null, { temporary: true }]) {
        assert.deepEqual(onCreated({ created: other, screenLeft: true, previous: older }), {
            track: older, deleteIds: [],
        });
    }
});

test("every language states the 24-hour fallback beside the delete on leaving, without promising the minute", () => {
    for (const language of SUPPORTED_LANGUAGES) {
        assert.match(chatPersonalizationCopy(language).temporaryDescription, /24/, language);
    }
    const en = chatPersonalizationCopy("en").temporaryDescription;
    assert.match(en, /deleted when you leave them/);
    assert.match(en, /stops taking messages 24 hours after it started and is deleted automatically soon after/);
});
