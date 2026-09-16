import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { LEGACY_CONTINUATION_TITLE } from "../lib/continuationDisplayTitle.ts";
import { continuationExportCopy } from "../lib/continuationExportCopy.ts";
import {
    DISPLAY_LANGUAGE_HEADER,
    DISPLAY_TIME_ZONE_HEADER,
    continuationExportTitle,
    continuationRowNaming,
    continuationRowTitle,
    continuationSourceState,
    displayDateInTimeZone,
    effectiveDisplayTimeZone,
} from "../lib/continuationTitleContext.ts";
import { en } from "../locales/en.ts";
import { ko } from "../locales/ko.ts";

/**
 * CONT-TITLE-01, step 3: an unnamed continuation whose source cannot name it
 * is still told apart from its siblings, says "deleted" only when it was, and
 * carries one date on the screen, in the filename and in the TXT header.
 */

const code = (path) => readFileSync(path, "utf8");
const providerLabel = (provider) =>
    ({ chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" })[provider] ?? provider;
const koCopy = {
    fallbackTemplate: ko.continuation.untitledFrom,
    untitled: ko.continuation.quickUntitled,
    providerLabel,
};
const enCopy = {
    fallbackTemplate: en.continuation.untitledFrom,
    untitled: en.continuation.quickUntitled,
    providerLabel,
};

const bridge = (overrides = {}) => ({
    provider: "chatgpt",
    createdAt: new Date("2026-09-13T23:30:00Z"),
    externalConversationId: "src_1",
    externalConversation: { title: "여행 계획", password: null },
    ...overrides,
});

/* -------------------------------------------------------------- time zone */

test("a real zone is kept and canonicalised", () => {
    assert.equal(effectiveDisplayTimeZone("Asia/Seoul"), "Asia/Seoul");
    assert.equal(effectiveDisplayTimeZone("asia/seoul"), "Asia/Seoul");
    assert.equal(effectiveDisplayTimeZone("  Asia/Seoul "), "Asia/Seoul");
    // Aliases resolve rather than being refused.
    assert.equal(effectiveDisplayTimeZone("US/Pacific"), "America/Los_Angeles");
    assert.notEqual(effectiveDisplayTimeZone("Asia/Kolkata"), "UTC");
    assert.equal(effectiveDisplayTimeZone("UTC"), "UTC");
});

test("anything else is an explicit UTC", () => {
    for (const hint of [
        undefined,
        null,
        "",
        "   ",
        "+09:00",
        "-05:00",
        "GMT+9",
        "Mars/Base",
        "A".repeat(65),
    ]) {
        assert.equal(effectiveDisplayTimeZone(hint), "UTC", JSON.stringify(hint));
    }
});

test("the date is the calendar day in that zone, in Latin digits", () => {
    const instant = new Date("2026-09-13T23:30:00Z");
    assert.equal(displayDateInTimeZone(instant, "Asia/Seoul"), "2026-09-14");
    assert.equal(displayDateInTimeZone(instant, "UTC"), "2026-09-13");
    assert.equal(displayDateInTimeZone(instant, "America/Los_Angeles"), "2026-09-13");
    assert.match(displayDateInTimeZone(instant, "Asia/Riyadh"), /^\d{4}-\d{2}-\d{2}$/);
});

/* ----------------------------------------------------------- source state */

test("four source states, and only a nulled key is deleted", () => {
    assert.equal(continuationSourceState(bridge()), "available");
    assert.equal(
        continuationSourceState(bridge({ externalConversationId: null, externalConversation: null })),
        "deleted"
    );
    assert.equal(
        continuationSourceState(bridge({ externalConversation: { title: "t", password: "hash" } })),
        "locked"
    );
    assert.equal(
        continuationSourceState(bridge({ externalConversation: { title: "  ", password: null } })),
        "empty"
    );
});

test("a locked source's title is withheld from the naming payload", () => {
    const naming = continuationRowNaming(
        bridge({ externalConversation: { title: "Secret", password: "hash" } }),
        "Asia/Seoul"
    );
    assert.equal(naming.sourceTitle, null);
    assert.equal(naming.sourceState, "locked");
    assert.equal(naming.sourceProvider, "chatgpt");
    assert.equal(naming.fallbackTitleDate, "2026-09-14");
    assert.doesNotMatch(JSON.stringify(naming), /Secret|hash/);
});

test("a row without a bridge carries no naming at all", () => {
    assert.deepEqual(continuationRowNaming(null, "Asia/Seoul"), {
        sourceTitle: null,
        sourceProvider: null,
        sourceState: null,
        fallbackTitleDate: null,
    });
});

/* ------------------------------------------------------------- row title */

test("an unnamed continuation with a deleted source gets the dated fallback", () => {
    const naming = continuationRowNaming(
        bridge({ externalConversationId: null, externalConversation: null }),
        "Asia/Seoul"
    );
    assert.equal(
        continuationRowTitle(
            { storedTitle: LEGACY_CONTINUATION_TITLE, isContinuation: true, ...naming },
            koCopy
        ),
        "ChatGPT에서 이어온 대화 · 2026-09-14"
    );
});

test("two unnamed continuations made on different days are told apart", () => {
    const deleted = { externalConversationId: null, externalConversation: null };
    const first = continuationRowNaming(bridge({ ...deleted }), "UTC");
    const second = continuationRowNaming(
        bridge({ ...deleted, createdAt: new Date("2026-09-15T08:00:00Z") }),
        "UTC"
    );
    const title = (naming) =>
        continuationRowTitle(
            { storedTitle: LEGACY_CONTINUATION_TITLE, isContinuation: true, ...naming },
            enCopy
        );
    assert.notEqual(title(first), title(second));
});

test("the source's own name and an owner's name still win", () => {
    const naming = continuationRowNaming(bridge(), "UTC");
    assert.equal(
        continuationRowTitle(
            { storedTitle: LEGACY_CONTINUATION_TITLE, isContinuation: true, ...naming },
            koCopy
        ),
        "여행 계획"
    );
    assert.equal(
        continuationRowTitle({ storedTitle: "사업 계획", isContinuation: true, ...naming }, koCopy),
        "사업 계획"
    );
    // No bridge: the placeholder's exact words are an ordinary title.
    assert.equal(
        continuationRowTitle({ storedTitle: LEGACY_CONTINUATION_TITLE, isContinuation: false }, koCopy),
        LEGACY_CONTINUATION_TITLE
    );
});

/* ------------------------------------------------------------------ export */

test("the export writes the list's date and names the zone only for a dated fallback", () => {
    const deleted = continuationExportTitle({
        storedTitle: LEGACY_CONTINUATION_TITLE,
        bridge: bridge({ externalConversationId: null, externalConversation: null }),
        timeZone: "Asia/Seoul",
        copy: enCopy,
    });
    assert.equal(deleted.title, "Continued from ChatGPT · 2026-09-14");
    assert.deepEqual(deleted.headerLines, ["Title date timezone: Asia/Seoul"]);

    const available = continuationExportTitle({
        storedTitle: LEGACY_CONTINUATION_TITLE,
        bridge: bridge(),
        timeZone: "Asia/Seoul",
        copy: enCopy,
    });
    assert.equal(available.title, "여행 계획");
    assert.deepEqual(available.headerLines, []);

    const ordinary = continuationExportTitle({
        storedTitle: "Plain chat",
        bridge: null,
        timeZone: "Asia/Seoul",
        copy: enCopy,
    });
    assert.deepEqual(ordinary, { title: "Plain chat", headerLines: [] });
});

test("every locale's fallback template carries both placeholders", () => {
    for (const locale of ["en", "ko", "de", "es", "fr", "pt", "zh"]) {
        const source = code(`locales/${locale}.ts`);
        const match = /untitledFrom: "([^"]*)"/.exec(source);
        assert.ok(match, `${locale} has untitledFrom`);
        assert.match(match[1], /\{provider\}/, locale);
        assert.match(match[1], /\{date\}/, locale);
    }
});

/* ----------------------------------------------------------- wiring */

test("every request whose response names a continuation sends the zone hint", () => {
    assert.equal(DISPLAY_TIME_ZONE_HEADER, "X-Tomverse-Time-Zone");
    for (const [path, needle, headers] of [
        ["app/(site)/(application)/chat/ChatPageClient.tsx", "fetch(`/api/conversations`, {", /headers: displayTimeZoneHeaders\(\)/],
        ["components/chat/ChatSidebar.tsx", "fetch(`/api/conversations/search?q=", /headers: displayTimeZoneHeaders\(\)/],
        ["components/imports/ExternalImportManagement.tsx", "`/api/external-conversations?offset=", /headers: displayTimeZoneHeaders\(\)/],
        // A file is worded by the server, so exports also send the language.
        // Both modes are the same request with one query away
        // (docs/policy/external-conversation-continuation.md §9.1).
        ["app/(site)/(application)/chat/ChatPageClient.tsx", "`/api/conversations/${convId}/export${options.includeSource", /headers: exportNamingHeaders\(lang\)/],
        ["components/auth/AuthButton.tsx", 'fetch("/api/conversations/export-all", {', /headers: exportNamingHeaders\(globalLang\)/],
    ]) {
        const source = code(path);
        const at = source.indexOf(needle);
        assert.ok(at >= 0, `${path}: ${needle}`);
        assert.match(source.slice(at, at + 400), headers, `${path} sends the hint with ${needle}`);
    }
});

test("an export words its fallback title in the page's language, validated", () => {
    const naming = bridge({ externalConversationId: null, externalConversation: null });
    const exportTitleFor = (language) =>
        continuationExportTitle({
            storedTitle: LEGACY_CONTINUATION_TITLE,
            bridge: naming,
            timeZone: "Asia/Seoul",
            copy: continuationExportCopy(
                new Request("https://t.test/", {
                    headers: language === undefined ? {} : { [DISPLAY_LANGUAGE_HEADER]: language },
                })
            ),
        }).title;
    // The same string the Korean list shows for this row.
    const listTitle = continuationRowTitle(
        {
            storedTitle: LEGACY_CONTINUATION_TITLE,
            isContinuation: true,
            ...continuationRowNaming(naming, "Asia/Seoul"),
        },
        koCopy
    );
    assert.equal(exportTitleFor("ko"), listTitle);
    assert.equal(exportTitleFor("ko"), "ChatGPT에서 이어온 대화 · 2026-09-14");
    // Anything unsupported is English.
    for (const hint of [undefined, "", "xx", "ko-KR", "<script>"]) {
        assert.equal(exportTitleFor(hint), "Continued from ChatGPT · 2026-09-14", String(hint));
    }
    for (const path of [
        "app/api/conversations/[conversationId]/export/route.ts",
        "app/api/conversations/export-all/route.ts",
    ]) {
        assert.match(code(path), /continuationExportCopy\(req\)/, path);
    }
});

test("every route that names a continuation validates the hint before using it", () => {
    for (const path of [
        "app/api/conversations/route.ts",
        "app/api/conversations/search/route.ts",
        "app/api/external-conversations/route.ts",
        "app/api/conversations/[conversationId]/export/route.ts",
        "app/api/conversations/export-all/route.ts",
    ]) {
        const source = code(path);
        assert.match(
            source,
            /effectiveDisplayTimeZone\(\s*req\.headers\.get\(DISPLAY_TIME_ZONE_HEADER\)\s*\)/,
            path
        );
        // The raw header is read in exactly that one place.
        assert.equal(source.split("DISPLAY_TIME_ZONE_HEADER)").length - 1, 1, path);
    }
});

test("search hits and the import page menu use the list's resolver", () => {
    const sidebar = code("components/chat/ChatSidebar.tsx");
    assert.match(sidebar, /storedTitle: result\.conversationTitle,/);
    assert.doesNotMatch(sidebar, /\{result\.conversationTitle\}/);

    const menu = code("components/imports/ContinuationQuickAction.tsx");
    assert.match(menu, /continuationRowTitle\(/);
    assert.doesNotMatch(menu, /entry\.title\?\.trim\(\)\s*\?\s*entry\.title/);
});

test("the deleted label appears only for the deleted state", () => {
    const sidebar = code("components/chat/ChatSidebar.tsx");
    assert.match(sidebar, /conv\.sourceState === "deleted" && \(/);
    assert.match(sidebar, /t\("continuation\.sourceDeletedBadge"\)/);
    assert.equal(sidebar.split("sourceDeletedBadge").length - 1, 1);
});
