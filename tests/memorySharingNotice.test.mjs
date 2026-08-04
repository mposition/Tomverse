import assert from "node:assert/strict";
import test from "node:test";
import {
    formatConversationAsText,
    formatConversationHeader,
} from "../lib/exportConversation.ts";
import { conversationExportPersonalizationNotice } from "../lib/memorySharingNotice.ts";
import { shareSnapshotSchema } from "../lib/shareSnapshot.ts";

/**
 * §13.3 — the disclosure a shared conversation and an export carry.
 *
 * The notice exists to tell a third party that answers may have been shaped
 * by the author's personalisation, and to tell them the remembered notes
 * themselves were not shared. Two ways it can go wrong, and both are asserted
 * here: it can become a channel (carrying a count or a statement), or it can
 * become conditional on the *author* — at which point its mere presence
 * discloses who personalises.
 */

/** Anything that would mean memory itself reached a third party. */
const FORBIDDEN = [
    "memoryContext",
    "memoryIds",
    "statement",
    "evidence",
    "searchTerms",
    "contextBundle",
    "retrievalHash",
];

const validSnapshot = () => ({
    version: 1,
    title: "Shared conversation",
    conversationCreatedAt: "2026-08-01T00:00:00.000Z",
    sharedAt: "2026-08-02T00:00:00.000Z",
    messages: [
        {
            id: "m-1",
            role: "assistant",
            content: "An answer.",
            modelId: "gpt-5-6-luna",
            createdAt: "2026-08-01T00:00:01.000Z",
        },
    ],
});

/* --------------------------------------------------------------- snapshot -- */

test("the personalization flag is a boolean and nothing else", () => {
    // A boolean can say "answers here may have been shaped"; it cannot say by
    // what. Anything richer would turn the disclosure into a channel.
    const parsed = shareSnapshotSchema.parse({
        ...validSnapshot(),
        personalizationPossible: true,
    });
    assert.equal(parsed.personalizationPossible, true);
    for (const value of ["사용자는 커피를 좋아한다", 3, ["mem-1"], { count: 2 }]) {
        assert.throws(
            () =>
                shareSnapshotSchema.parse({
                    ...validSnapshot(),
                    personalizationPossible: value,
                }),
            `${JSON.stringify(value)} must not be storable`
        );
    }
});

test("a snapshot written before the field parses unchanged", () => {
    // Every snapshot taken before injection existed. Absent reads as false,
    // which is the correct answer for all of them.
    const parsed = shareSnapshotSchema.parse(validSnapshot());
    assert.equal(parsed.personalizationPossible, undefined);
});

test("the flag survives a round trip, so it is not re-read at view time", () => {
    // Recorded at share time on purpose: turning injection off later does not
    // un-influence answers that were already generated.
    const stored = JSON.stringify(
        shareSnapshotSchema.parse({
            ...validSnapshot(),
            personalizationPossible: true,
        })
    );
    assert.equal(
        shareSnapshotSchema.parse(JSON.parse(stored)).personalizationPossible,
        true
    );
});

/* ----------------------------------------------------------------- export -- */

test("the notice names no count, kind or statement", () => {
    const notice = conversationExportPersonalizationNotice();
    assert.ok(notice.length > 0);
    for (const forbidden of FORBIDDEN) {
        assert.ok(
            !notice.includes(forbidden),
            `the notice must not carry ${forbidden}`
        );
    }
    assert.ok(
        !/\d/.test(notice),
        "a number in the notice would disclose how much was remembered"
    );
});

test("the notice says the remembered notes were not shared", () => {
    // Half the §13.3 disclosure is the reassurance; without it the line only
    // raises a question it does not answer.
    const notice = conversationExportPersonalizationNotice().toLowerCase();
    assert.ok(notice.includes("may have been"), "it states possibility");
    assert.ok(notice.includes("not included"), "it states what was withheld");
});

test("the export header carries the notice only when it is given one", () => {
    const conversation = {
        title: "Exported",
        createdAt: "2026-08-01T00:00:00.000Z",
    };
    const withNotice = formatConversationHeader(
        conversation,
        conversationExportPersonalizationNotice()
    );
    assert.ok(withNotice.includes("personalisation settings"));
    assert.ok(withNotice.includes("Tomverse Insight Export"), "header intact");

    const without = formatConversationHeader(conversation);
    assert.ok(
        !without.toLowerCase().includes("personalisation"),
        "a notice about a feature that could not have run is noise"
    );
});

test("the notice is a header line, not something mixed into the transcript", () => {
    // It must be attributable to the document, not read as part of an answer.
    const header = formatConversationHeader(
        { title: "Exported", createdAt: "2026-08-01T00:00:00.000Z" },
        conversationExportPersonalizationNotice()
    );
    const body = formatConversationAsText({
        title: "Exported",
        createdAt: "2026-08-01T00:00:00.000Z",
        messages: [{ role: "assistant", content: "An answer." }],
    });
    assert.ok(header.includes("personalisation settings"));
    assert.ok(!body.includes("personalisation settings"));
});
