import assert from "node:assert/strict";
import test from "node:test";

import { temporaryChatOnLeave, temporaryChatOnView } from "../lib/temporaryChatClientCore.ts";
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

test("every language states the 24-hour fallback beside the delete on leaving", () => {
    for (const language of SUPPORTED_LANGUAGES) {
        assert.match(chatPersonalizationCopy(language).temporaryDescription, /24/, language);
    }
    assert.match(chatPersonalizationCopy("en").temporaryDescription, /deleted when you leave them; one that can't be deleted then/);
});
