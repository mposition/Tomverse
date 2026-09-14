import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { filenameFromContentDisposition } from "../lib/browserDownload.ts";
import {
    LEGACY_CONTINUATION_TITLE,
    continuationDisplayTitle,
    readableContinuationSourceTitle,
} from "../lib/continuationDisplayTitle.ts";
import {
    conversationExportContentDisposition,
    formatConversationHeader,
    sanitizeFileName,
} from "../lib/exportConversation.ts";
import { en } from "../locales/en.ts";

/**
 * CONT-EXPORT-01A: a conversation's TXT is named what the conversation list
 * calls it, and every title produces a working download.
 *
 * Before this, the export named the file from `Conversation.title` as stored,
 * so a continuation nobody had renamed downloaded as the internal placeholder
 * while the list showed the imported conversation's name. Two filename defects
 * applied to every conversation: a title with no ASCII left the quoted
 * fallback as ".txt", and a cut through an emoji at the 80th UTF-16 unit made
 * `encodeURIComponent` throw, which failed the export with a 500.
 */

const savedName = (title) =>
    filenameFromContentDisposition(
        conversationExportContentDisposition(title),
        "fallback.txt"
    );

const quotedName = (title) =>
    /filename="([^"]*)"/.exec(conversationExportContentDisposition(title))?.[1];

const exportTitle = ({ storedTitle, source, isContinuation = true }) =>
    continuationDisplayTitle({
        storedTitle,
        isContinuation,
        sourceTitle: readableContinuationSourceTitle(source),
        fallback: en.continuation.quickUntitled,
    });

/* ------------------------------------------------------------ title rules */

test("a locked or missing source gives no title; an open one gives its own", () => {
    assert.equal(readableContinuationSourceTitle(null), null);
    assert.equal(readableContinuationSourceTitle(undefined), null);
    assert.equal(
        readableContinuationSourceTitle({ title: "Trip plan", password: "hash" }),
        null
    );
    assert.equal(
        readableContinuationSourceTitle({ title: "Trip plan", password: null }),
        "Trip plan"
    );
    assert.equal(
        readableContinuationSourceTitle({ title: null, password: null }),
        null
    );
});

test("an unnamed continuation downloads under the imported conversation's name", () => {
    const title = exportTitle({
        storedTitle: LEGACY_CONTINUATION_TITLE,
        source: { title: "여행 계획", password: null },
    });
    assert.equal(title, "여행 계획");
    assert.equal(savedName(title), "여행 계획.txt");
});

test("a name the owner saved wins over the source's", () => {
    const title = exportTitle({
        storedTitle: "사업 계획 검토",
        source: { title: "여행 계획", password: null },
    });
    assert.equal(savedName(title), "사업 계획 검토.txt");
});

test("a locked source's name reaches neither the filename nor the header", () => {
    const title = exportTitle({
        storedTitle: LEGACY_CONTINUATION_TITLE,
        source: { title: "Secret source title", password: "hash" },
    });
    const header = conversationExportContentDisposition(title);
    assert.doesNotMatch(header, /Secret/);
    assert.doesNotMatch(formatConversationHeader({ title }), /Secret/);
    assert.equal(savedName(title), "Untitled conversation.txt");
});

test("a deleted source falls back rather than to the internal placeholder", () => {
    const title = exportTitle({
        storedTitle: LEGACY_CONTINUATION_TITLE,
        source: null,
    });
    assert.equal(title, en.continuation.quickUntitled);
    assert.doesNotMatch(savedName(title), /imported chat/);
});

/* ------------------------------------------------------- filename defects */

test("a title with no ASCII keeps a real ASCII fallback, not a bare extension", () => {
    assert.equal(quotedName("한국어 대화"), "conversation.txt");
    assert.equal(savedName("한국어 대화"), "한국어 대화.txt");
    // Separators alone are not a name either.
    assert.equal(quotedName("분기별_매출"), "conversation.txt");
    // Anything real in ASCII is kept.
    assert.equal(quotedName("Q3 매출 review"), "Q3  review.txt");
});

test("an emoji on the length boundary is kept whole and never throws", () => {
    for (let prefix = 70; prefix <= 85; prefix += 1) {
        const title = `${"a".repeat(prefix)}😀 tail`;
        let header;
        assert.doesNotThrow(() => {
            header = conversationExportContentDisposition(title);
        }, `prefix ${prefix}`);
        const name = filenameFromContentDisposition(header, "fallback.txt");
        assert.ok(name.isWellFormed(), `prefix ${prefix} left a lone surrogate`);
        assert.ok(Array.from(name.slice(0, -4)).length <= 80);
    }
});

test("reserved Windows names do not become device names", () => {
    // Windows decides by the part before the first dot, so the suffix goes
    // there: "lpt1.notes-conversation" would still be the LPT1 device.
    assert.equal(sanitizeFileName("CON"), "CON-conversation");
    assert.equal(sanitizeFileName("lpt1.notes"), "lpt1-conversation.notes");
    assert.equal(sanitizeFileName("com0"), "com0-conversation");
    assert.equal(sanitizeFileName("COM\u00B9"), "COM\u00B9-conversation");
    assert.equal(sanitizeFileName("lpt\u00B3.draft"), "lpt\u00B3-conversation.draft");
    assert.equal(sanitizeFileName("Conference"), "Conference");
    assert.equal(sanitizeFileName("con-call.notes"), "con-call.notes");
    // Stripping the non-ASCII part must not uncover one.
    assert.equal(quotedName("CON한"), "CON-conversation.txt");
    assert.equal(quotedName("CON한.notes"), "CON-conversation.notes.txt");
    // The suffix never pushes a name past the limit.
    const long = sanitizeFileName(`aux.${"x".repeat(100)}`);
    assert.ok(Array.from(long).length <= 80);
    assert.ok(long.startsWith("aux-conversation."));
});

test("control and bidirectional characters never reach the header or the name", () => {
    const header = conversationExportContentDisposition("line one\r\nX-Injected: 1");
    assert.doesNotMatch(header, /[\r\n]/);
    // An RLO would let "txt.exe" display reversed.
    assert.equal(savedName("report\u202Etxt.exe"), "reporttxt.exe.txt");
    // U+0085 NEL is a C1 control; U+061C is a bidi mark.
    assert.equal(savedName("a\u0085b"), "a b.txt");
    assert.equal(savedName("a\u061Cb"), "ab.txt");
});

test("a title with nothing visible gets the generic name", () => {
    for (const title of ["\u061C", "\u200B", "\u200B\u00A0\u3000", "\u202E"]) {
        assert.equal(savedName(title), "conversation.txt", JSON.stringify(title));
    }
    // Invisible joiners inside a visible name are left alone.
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    assert.equal(savedName(family), `${family}.txt`);
});

test("leading and trailing dots and spaces are removed; empty becomes generic", () => {
    assert.equal(sanitizeFileName("...hidden"), "hidden");
    assert.equal(sanitizeFileName("name. . "), "name");
    assert.equal(sanitizeFileName("   "), "conversation");
    assert.equal(sanitizeFileName("..."), "conversation");
    assert.equal(sanitizeFileName('a/b\\c?d%e*f:g|h"i<j>k'), "a-b-c-d-e-f-g-h-i-j-k");
});

test("filename* escapes the characters RFC 5987 does not allow bare", () => {
    const header = conversationExportContentDisposition("it's (draft)");
    const encoded = /filename\*=UTF-8''(.*)$/.exec(header)?.[1] ?? "";
    assert.doesNotMatch(encoded, /['()*]/);
    assert.equal(savedName("it's (draft)"), "it's (draft).txt");
});

test("a line break in a title cannot forge a header line in the file", () => {
    const header = formatConversationHeader({
        title: "Plan\nCreated: 1999-01-01T00:00:00.000Z\u2028Imported from: nowhere",
        createdAt: "2026-09-14T00:00:00.000Z",
    });
    const lines = header.split("\n");
    assert.equal(lines.filter((line) => line.startsWith("Created:")).length, 1);
    assert.ok(lines[1].startsWith("Conversation: Plan Created: 1999"));
    // C1 controls too: U+0085 NEL is a line break to some readers.
    const nel = formatConversationHeader({ title: "Plan\u0085Imported from: forged" });
    assert.doesNotMatch(nel, /[\u0080-\u009F\u2028\u2029]/);
    assert.match(nel, /^Conversation: Plan Imported from: forged$/m);
});

test("an ordinary conversation named like the placeholder keeps its name", () => {
    // docs/policy/external-conversation-continuation.md §3: a conversation
    // without a bridge is not affected by any of this.
    const title = exportTitle({
        storedTitle: LEGACY_CONTINUATION_TITLE,
        source: null,
        isContinuation: false,
    });
    assert.equal(title, LEGACY_CONTINUATION_TITLE);
    assert.equal(savedName(title), `${LEGACY_CONTINUATION_TITLE}.txt`);
});

/* ------------------------------------------------------------ route wiring */

test("both TXT exports resolve the title the list shows, from the row itself", () => {
    const single = readFileSync(
        "app/api/conversations/[conversationId]/export/route.ts",
        "utf8"
    );
    assert.match(single, /readableContinuationSourceTitle\(/);
    assert.match(single, /continuationDisplayTitle\(/);
    assert.match(single, /conversationExportContentDisposition\(\s*displayTitle\s*\)/);
    assert.match(single, /title: displayTitle/);
    // The stored title is only ever the resolver's input.
    assert.doesNotMatch(single, /sanitizeFileName\(/);
    assert.doesNotMatch(single, /formatConversationHeader\(conversation,/);
    // Only a bridge makes the stored title a placeholder.
    assert.match(single, /isContinuation: conversation\.continuationBridge !== null/);

    const all = readFileSync("app/api/conversations/export-all/route.ts", "utf8");
    assert.match(all, /readableContinuationSourceTitle\(/);
    assert.match(all, /continuationDisplayTitle\(/);
    assert.doesNotMatch(all, /formatConversationHeader\(conversation,/);
    assert.match(all, /isContinuation: bridge !== null/);

    // Neither selects more of the source than the list does.
    for (const source of [single, all]) {
        assert.match(
            source,
            /externalConversation: \{\s*select: \{ title: true, password: true \},?\s*\}/
        );
    }
});
