import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
    resolveChatContentState,
    shouldRenderWelcomeSurface,
} from "../lib/chatContentState.ts";
import {
    LEGACY_CONTINUATION_TITLE,
    continuationDisplayTitle,
} from "../lib/continuationDisplayTitle.ts";

/**
 * What a continuation looks like on arrival, before anyone has answered.
 *
 * docs/policy/external-conversation-continuation.md §8.2.
 *
 * The defect these pin: a continuation opens with a read-only imported
 * transcript and no native `Message`, so every panel reports `empty` --
 * truthfully -- and the shell greeted its owner with "welcome back", offered
 * them other recent conversations, and floated the composer in the middle of a
 * screen that already had a conversation on it.
 */

const code = (path) =>
    readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");

/* ------------------------------------------------- the two empty states */

test("an ordinary empty conversation still gets the welcome surface", () => {
    assert.equal(
        shouldRenderWelcomeSurface({
            contentState: "empty",
            hasConversationPrelude: false,
        }),
        true
    );
});

test("a continuation with no answers yet does not", () => {
    assert.equal(
        shouldRenderWelcomeSurface({
            contentState: "empty",
            hasConversationPrelude: true,
        }),
        false
    );
});

test("nothing else renders it, prelude or not", () => {
    // `unknown` in particular: the state machine exists so a conversation
    // still loading is never claimed to be empty.
    for (const contentState of ["unknown", "non-empty"]) {
        for (const hasConversationPrelude of [false, true]) {
            assert.equal(
                shouldRenderWelcomeSurface({
                    contentState,
                    hasConversationPrelude,
                }),
                false,
                `${contentState} / prelude=${hasConversationPrelude}`
            );
        }
    }
});

test("the content state itself is untouched by the prelude", () => {
    /*
      `empty` still means "no native turn", which is what the comparison rail
      reads: a conversation with no answers has nothing to compare whatever
      else is on screen. Bending that meaning instead of adding the narrower
      question would have made the rail offer a comparison of nothing.
    */
    const state = resolveChatContentState({
        isConversationSelectionResolved: true,
        conversationId: "c1",
        selectedModelIds: ["m1"],
        reported: { "c1:m1": "empty" },
    });
    assert.equal(state, "empty");
});

/* ------------------------------------------------- what the shells read */

test("both shells decide the welcome surface with the shared function", () => {
    for (const path of [
        "components/chat/DesktopChatShell.tsx",
        "components/chat/MobileChatShell.tsx",
    ]) {
        const source = code(path);
        assert.match(source, /shouldRenderWelcomeSurface\(\{/, path);
        // The welcome screen, the composer's position and the panels' inertness
        // all follow the narrower question, never the raw content state.
        assert.doesNotMatch(
            source,
            /isConversationEmpty \? welcomeInputSlot/,
            `${path} must place the composer by the welcome decision`
        );
        assert.doesNotMatch(
            source,
            /variant=\{isConversationEmpty \?/,
            `${path} must choose the composer variant by the welcome decision`
        );
    }
    // And the desktop overlay is gated on it too.
    assert.match(
        code("components/chat/DesktopChatShell.tsx"),
        /\{showsWelcomeSurface && \(/
    );
});

test("the prelude flag is the server's answer, never the node or the title", () => {
    const client = code("app/(site)/(application)/chat/ChatPageClient.tsx");
    assert.match(
        client,
        /\)\?\.surface === "continuation";/,
        "derived from the row's server-decided surface"
    );
    const derivation = client.slice(
        client.indexOf("const hasConversationPrelude ="),
        client.indexOf("return (\n")
    );
    for (const forbidden of ["productKey", "kind", "selectionMode", "title"]) {
        assert.ok(
            !derivation.includes(forbidden),
            `the imported-half flag must not be derived from ${forbidden}`
        );
    }
});

/* ------------------------------------------- the transcript in the timeline */

test("the imported transcript is inside the chat's own scroll container", () => {
    /*
      Not a block above the panels with a scroller of its own. The panel
      already owns the one vertical scroll the chat has, so a second one is a
      second conversation on the page -- which is what
      docs/policy/external-conversation-continuation.md §8.2 stopped allowing.
    */
    const app = code("components/chat/ChatApp.tsx");
    assert.match(app, /\.\.\.\(importedMessages \?\? \[\]\)/);
    // Before the panel's own messages, because they are the earlier part of
    // the same conversation.
    const importedAt = app.indexOf("...(importedMessages ?? [])");
    const ownAt = app.indexOf("...(useCenteredWelcome");
    assert.ok(importedAt > 0 && ownAt > importedAt);

    const list = code("components/chat/ChatMessageList.tsx");
    // One scroller, the one the chat has always had.
    assert.equal(
        (list.match(/overflow-y-auto/g) ?? []).length,
        1,
        "no nested scroll container was added"
    );
});

test("an imported bubble is the ordinary bubble, dashed", () => {
    const source = code("components/chat/ChatMessageList.tsx");
    // The same element, the same class string: only the edge is added.
    assert.match(source, /imported\s*\n?\s*\? isUser\s*\n?\s*\? "border border-dashed/);
    assert.match(source, /: "border-dashed"/);
    // And the state is announced, not only drawn.
    assert.match(source, /continuation\.importedMessageDescription/);
});

test("an imported message carries no action that changes a Tomverse turn", () => {
    /*
      Regenerate, retry, "continue without files" and the error report are all
      inside the `error` and `cancelled` branches, and the mapper gives every
      imported message `status: "normal"`. That is what makes the absence
      structural rather than a list of conditions somebody has to maintain.
    */
    const mapper = code("lib/continuationTimelineMessages.ts");
    assert.match(mapper, /status: "normal"/);
    for (const forbidden of ["error", "cancelled", "pending"]) {
        assert.ok(
            !new RegExp(`status: "${forbidden}"`).test(mapper),
            `an imported message must never be ${forbidden}`
        );
    }
});

test("the divider is a separator, in every source state", () => {
    const source = code("components/chat/ChatMessageList.tsx");
    assert.match(source, /role="separator"/);
    assert.match(source, /aria-label=\{t\("continuation\.divider"\)\}/);
    // Exactly two places it can be drawn -- after the last imported message,
    // or on its own when nothing was imported (a deleted or locked snapshot,
    // where the boundary is what must not vanish with the source).
    assert.equal(
        (source.match(/data-testid="continuation-divider"/g) ?? []).length,
        2
    );
    assert.match(source, /isLastImported &&/);
    assert.match(
        source,
        /importedTranscript && !messages\.some\(\(message\) => message\.imported\)/
    );
});

test("only one divider can render for a conversation", () => {
    /*
      The two sites are mutually exclusive by construction: `isLastImported`
      requires an imported message and the standalone one requires that there
      is none.
    */
    const source = code("components/chat/ChatMessageList.tsx");
    assert.match(
        source,
        /const isLastImported =\s*\n?\s*Boolean\(imported\) && !messages\[idx \+ 1\]\?\.imported/
    );
});

test("a long transcript pages inside the timeline, from the divider back", () => {
    const hook = code("components/continuations/useContinuationSource.ts");
    // The page next to the divider first: it is the part the next answer
    // follows on from.
    assert.match(hook, /offset=end/);
    // And backwards from there, never overlapping what is held.
    assert.match(hook, /windowStart - CONTINUATION_SOURCE_PAGE_SIZE/);
    assert.match(hook, /const nextLimit = windowStart - nextOffset/);
    const list = code("components/chat/ChatMessageList.tsx");
    assert.match(list, /data-testid="imported-load-older"/);
    assert.match(list, /continuation\.showOlderImported/);
});

/* ----------------------------------------------------------- the title */

test("a name the owner typed is never replaced", () => {
    for (const storedTitle of [
        "Migration plan review",
        "Continued from an imported chat!",
        "continued from an imported chat",
    ]) {
        assert.equal(
            continuationDisplayTitle({
                storedTitle,
                sourceTitle: "Something else",
                fallback: "Untitled",
            }),
            storedTitle,
            storedTitle
        );
    }
});

test("only the exact placeholder gives way to the source's name", () => {
    assert.equal(
        continuationDisplayTitle({
            storedTitle: LEGACY_CONTINUATION_TITLE,
            sourceTitle: "Migration plan review",
            fallback: "Untitled",
        }),
        "Migration plan review"
    );
});

test("a deleted, locked or unnamed source falls back to the translation", () => {
    // Three different facts with one answer: the server sends no source title
    // for any of them, and the row must still be nameable on screen.
    for (const sourceTitle of [undefined, null, "", "   "]) {
        assert.equal(
            continuationDisplayTitle({
                storedTitle: LEGACY_CONTINUATION_TITLE,
                sourceTitle,
                fallback: "제목 없는 대화",
            }),
            "제목 없는 대화",
            String(sourceTitle)
        );
    }
});

test("the source's name is resolved for display, never stored on the row", () => {
    /*
      §3 keeps the source's words out of every table its deletion does not
      reach, and `Conversation.title` is one: deleting a snapshot deliberately
      leaves the continuation standing, so a title copied at creation would
      outlive the deletion request meant to remove it.
    */
    const source = code("lib/externalContinuationService.ts");
    // Scoped to the creation path. The timeline reader below it *does* return
    // the snapshot's title -- that is the read-only display this feature is
    // about, and it is already gated on the unlock grant.
    const writer = source.slice(
        source.indexOf("async function createContinuationRows"),
        source.indexOf("export async function getContinuationBridge")
    );
    assert.ok(writer.length > 0, "the creation path must be findable");
    assert.match(writer, /title: LEGACY_CONTINUATION_TITLE/);
    assert.doesNotMatch(writer, /title: snapshot\.title/);
    // The snapshot's title is not even selected by the creation path.
    const loader = source.slice(
        source.indexOf("async function loadUnlockedSnapshot"),
        source.indexOf("async function readSeedPlan")
    );
    assert.doesNotMatch(loader, /\btitle: true\b/);
});

test("a locked source withholds its name from the list", () => {
    // Its title is part of the transcript the lock is withholding.
    const route = code("app/api/conversations/route.ts");
    assert.match(route, /externalConversation\?\.password === null/);
});
