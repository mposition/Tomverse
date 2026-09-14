import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    CONVERSATION_TITLE_MAX_LENGTH,
    renameDecision,
} from "../lib/conversationRename.ts";
import {
    LEGACY_CONTINUATION_TITLE,
    isDerivedContinuationTitle,
} from "../lib/continuationDisplayTitle.ts";

/**
 * CONT-TITLE-01, step 1: confirming the rename dialog without a change saves
 * nothing.
 *
 * The dialog opens with the title as shown. For a continuation nobody has
 * named, that is the imported conversation's own name, resolved for display
 * and stored nowhere. Pressing OK on it used to PATCH it onto
 * `Conversation.title`, where deleting the source no longer removes it
 * (docs/policy/external-conversation-continuation.md §3).
 */

const code = (path) => readFileSync(path, "utf8");

test("an unchanged submit saves nothing", () => {
    assert.deepEqual(
        renameDecision({ initialValue: "여행 계획", nextValue: "여행 계획" }),
        { action: "none" }
    );
});

test("spaces added around the same name are not a change", () => {
    // The server trims, so it would store exactly the same string.
    assert.deepEqual(
        renameDecision({ initialValue: "여행 계획", nextValue: "  여행 계획 " }),
        { action: "none" }
    );
    assert.deepEqual(
        renameDecision({ initialValue: " 여행 계획", nextValue: "여행 계획" }),
        { action: "none" }
    );
});

test("editing and reverting is not a change", () => {
    let value = "여행 계획";
    value = "여행 계획 2";
    value = "여행 계획";
    assert.deepEqual(
        renameDecision({ initialValue: "여행 계획", nextValue: value }),
        { action: "none" }
    );
});

test("a real change is saved, trimmed", () => {
    assert.deepEqual(
        renameDecision({ initialValue: "여행 계획", nextValue: " 사업 계획 검토 " }),
        { action: "save", title: "사업 계획 검토" }
    );
});

test("a name equal to the source's is allowed when the owner typed it", () => {
    // Only the accidental copy is prevented, not the string.
    assert.deepEqual(
        renameDecision({ initialValue: "Untitled conversation", nextValue: "여행 계획" }),
        { action: "save", title: "여행 계획" }
    );
});

test("an empty field is invalid", () => {
    assert.deepEqual(renameDecision({ initialValue: "a", nextValue: "   " }), {
        action: "invalid",
    });
});

test("only a bridged row carrying the placeholder shows a derived title", () => {
    assert.equal(
        isDerivedContinuationTitle({
            storedTitle: LEGACY_CONTINUATION_TITLE,
            isContinuation: true,
        }),
        true
    );
    assert.equal(
        isDerivedContinuationTitle({
            storedTitle: LEGACY_CONTINUATION_TITLE,
            isContinuation: false,
        }),
        false
    );
    assert.equal(
        isDerivedContinuationTitle({ storedTitle: "여행 계획", isContinuation: true }),
        false
    );
});

test("the sidebar dialog submits through the decision, never unconditionally", () => {
    const sidebar = code("components/chat/ChatSidebar.tsx");
    const start = sidebar.indexOf("{renameTarget && (");
    const end = sidebar.indexOf("{shareTarget && (", start);
    assert.ok(start > 0 && end > start, "the rename dialog must be findable");
    const dialog = sidebar.slice(start, end);

    assert.match(dialog, /renameDecision\(\{/);
    assert.match(dialog, /initialValue: renameTarget\.title/);
    assert.match(dialog, /if \(decision\.action === "save"\) \{\s*onRename\(renameTarget\.id, decision\.title\)/);
    // The one other call is the explicitly labelled "save the shown name".
    const calls = dialog.match(/onRename\(/g) ?? [];
    assert.equal(calls.length, 2);
    assert.match(dialog, /data-testid="rename-save-displayed-title"/);
    assert.match(dialog, /t\("sidebar\.saveDisplayedTitle"\)/);
    assert.match(dialog, /renameTarget\.titleIsDerived &&/);
});

test("the list marks a derived title with the same rule the resolver uses", () => {
    const client = code("app/(site)/(application)/chat/ChatPageClient.tsx");
    assert.match(client, /titleIsDerived: isDerivedContinuationTitle\(\{/);
});

test("the API and the dialog share one title length limit", () => {
    assert.equal(CONVERSATION_TITLE_MAX_LENGTH, 120);
    const route = code("app/api/conversations/[conversationId]/route.ts");
    assert.match(route, /max\(CONVERSATION_TITLE_MAX_LENGTH\)/);
});
