import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

/**
 * A continuation runs in the ordinary chat workspace.
 *
 * docs/policy/external-conversation-continuation.md §5.1, §8.2, §8.3.
 *
 * These are source assertions, and deliberately so: the claims are about
 * *which component renders what*, and that is a fact about the module graph
 * rather than about any one rendered frame. What a rendered frame adds -- that
 * the sidebar is there, that Enter sends, that a failed panel reports on
 * itself -- is in tests/e2e/external-conversation-continuation.spec.ts.
 */

const read = (path) => readFileSync(path, "utf8");

/**
 * The file with its comments removed.
 *
 * Every claim below is about what the code does, and these files explain at
 * length what they replaced -- so a prose mention of the old screen's textarea
 * would fail an assertion about the new screen having none. Stripping the
 * commentary is what keeps the assertion pointed at the code.
 */
const code = (path) =>
    read(path)
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");

const ROUTE = "app/(site)/(application)/continuations/[conversationId]/page.tsx";
const SOURCE_HOOK = "components/continuations/useContinuationSource.ts";
const MESSAGE_LIST = "components/chat/ChatMessageList.tsx";
const MAPPER = "lib/continuationTimelineMessages.ts";
const CLIENT = "app/(site)/(application)/chat/ChatPageClient.tsx";

/* ------------------------------------------- the route is the shared shell */

test("the continuation route renders the workspace every other chat route renders", () => {
    const source = code(ROUTE);
    assert.match(source, /ReviewWorkspaceShell/);
    assert.match(source, /mountedSurface="continuation"/);
    // The screen it replaced: no composer, no message list, no model list of
    // its own anywhere in this route.
    assert.doesNotMatch(source, /textarea/i);
    assert.doesNotMatch(source, /ChatInput/);
});

test("the standalone continuation screen is gone, not merely unused", () => {
    // Leaving the files behind would leave two implementations of the same
    // screen, and the dead one is the one nobody re-checks.
    for (const path of [
        "components/continuations/ContinuedConversationWorkspace.tsx",
        "components/continuations/ContinuationModelSelector.tsx",
        "lib/continuationModelPanels.ts",
        // The prelude panel that replaced it, and was in turn replaced by the
        // transcript living in the timeline. Same reasoning: a second way to
        // draw the imported half is the one nobody re-checks.
        "components/continuations/ContinuationSourcePrelude.tsx",
    ]) {
        assert.equal(existsSync(path), false, `${path} must be deleted`);
    }
});

/* -------------------------------------------- the imported half only reads */

test("the imported half is read and can do nothing else", () => {
    // §5.1: the excerpt reaches the model as a server-built system block. A
    // reader with no way to post cannot put imported text in a request body,
    // which is the strongest form of that guarantee available here.
    const source = code(SOURCE_HOOK);
    assert.match(source, /\/continuation\?/, "it reads the timeline endpoint");
    for (const forbidden of ["/api/chat", 'method: "POST"', "<textarea"]) {
        assert.ok(
            !source.includes(forbidden),
            `the source reader must not contain ${forbidden}`
        );
    }
});

test("a late read cannot land on the conversation that replaced it", () => {
    /*
      The workspace selects conversations in place, so this hook's mount
      outlives the conversation it was first asked about. "Did it unmount" is
      therefore the wrong question and a cleanup flag alone the wrong
      instrument -- the right question is whether the conversation that asked
      is still the one on screen.
    */
    const source = code(SOURCE_HOOK);
    assert.match(source, /generationRef\.current \+= 1/);
    assert.match(source, /generationRef\.current === generation/);
    assert.match(source, /new AbortController\(\)/);
    assert.match(source, /controller\.abort\(\)/);
    /*
      And staleness is a *derivation*, not a clear.

      The obvious shape -- one `timeline` wiped at the top of the effect --
      sets state synchronously during an effect and costs a cascading render on
      every conversation switch. Holding the owner beside the value makes "this
      belongs to a conversation that is no longer open" unreadable instead of
      merely cleared, which is the stronger property: nothing stale exists to
      be read in the window before the clear would have run.
    */
    assert.match(
        source,
        /const timeline =\s*\n?\s*loaded && loaded\.conversationId === conversationId \? loaded\.timeline : null;/
    );
    assert.ok(
        !source.includes("setTimeline("),
        "no state is cleared inside the effect"
    );
});

test("the imported half is a view model, never a stored message", () => {
    // docs/policy/external-conversation-continuation.md §8.2: what crosses
    // into the timeline is a rendering array. Nothing writes, and the
    // difference between the two halves is a field rather than a class.
    const source = code(MAPPER);
    assert.match(source, /imported: \{/);
    assert.match(source, /IMPORTED_MESSAGE_ID_PREFIX/);
    for (const forbidden of ["fetch(", "POST", "prisma"]) {
        assert.ok(
            !source.includes(forbidden),
            `the mapper must not contain ${forbidden}`
        );
    }
});

test("the timeline states provenance, provider, deletion and lock", () => {
    const source = read(MESSAGE_LIST);
    for (const testId of [
        "continuation-provenance",
        "continuation-source-tombstone",
        "continuation-source-locked",
        "continuation-divider",
        "imported-message-header",
        "imported-load-older",
    ]) {
        assert.match(source, new RegExp(`data-testid="${testId}"`), testId);
    }
});

test("read-only is said, not only drawn", () => {
    /*
      The dashed edge is the visible half and is not enough on its own: a
      border style carries no meaning to a screen reader and none at all to a
      reader who cannot tell 1px of dash from 1px of solid.
    */
    const source = code(MESSAGE_LIST);
    assert.match(source, /aria-description=\{/);
    assert.match(source, /continuation\.importedMessageDescription/);
    assert.match(source, /border-dashed/);
});

test("a gone or locked source is in the timeline, and keeps the divider", () => {
    // Both change what the next turn carries, so both are stated where the
    // transcript would have been -- and §9 keeps the boundary in place in
    // exactly those states.
    const source = code(MESSAGE_LIST);
    assert.match(
        source,
        /importedTranscript\?\.status === "deleted"/,
        "the tombstone is driven by the snapshot's state"
    );
    assert.match(source, /importedTranscript\?\.status === "locked"/);
    assert.match(
        source,
        /importedTranscript && !messages\.some\(\(message\) => message\.imported\)/,
        "the divider still renders when nothing was imported onto the screen"
    );
});

/* ------------------------------- one read, handed to every panel's timeline */

test("both shells hand the imported half to every panel", () => {
    /*
      Inside `ChatApp`, not above it. The panel already owns the one scroll
      container the chat has, so the transcript belongs in its message list --
      anything above the panel row is a second scroll area and a second
      conversation on the page, which is what this replaced.
    */
    for (const path of [
        "components/chat/DesktopChatShell.tsx",
        "components/chat/MobileChatShell.tsx",
    ]) {
        const source = read(path);
        assert.ok(
            !source.includes("{conversationPrelude}"),
            `${path} no longer renders a prelude slot`
        );
        const importedAt = source.indexOf("importedMessages={importedMessages}");
        const chatAppAt = source.indexOf("<ChatApp");
        assert.ok(importedAt > 0, `${path} passes the transcript down`);
        assert.ok(
            chatAppAt > 0 && importedAt > chatAppAt,
            `${path} passes it as a ChatApp prop`
        );
    }
});

test("the workspace reads the imported half once, for the open conversation", () => {
    const source = read(CLIENT);
    // One read however many models are selected: the alternative is the same
    // bridge fetched once per panel.
    assert.equal(
        (source.match(/useContinuationSource\(/g) ?? []).length,
        1,
        "asked once"
    );
    // And only for a conversation the server classified as a continuation, so
    // an ordinary conversation spends no request at all.
    assert.match(
        source,
        /useContinuationSource\(\s*\n?\s*hasConversationPrelude \? shellConversationId : null\s*\n?\s*\)/
    );
    assert.equal(
        (source.match(/importedMessages=\{importedMessages\}/g) ?? []).length,
        2,
        "desktop and mobile both receive it"
    );
});

/* ------------------------------------------------- navigation across surfaces */

test("selecting a conversation on another surface navigates instead of swapping", () => {
    /*
      The defect this guards is the mirror of the one that produced the
      continuation route in the first place. Opening an ordinary conversation
      from the sidebar of `/continuations/[id]` in place would leave that URL,
      and the imported prelude beside it, describing a different conversation.
    */
    const source = read(CLIENT);
    // The row's own path decides first -- a surface with a per-conversation
    // URL must be at it -- and only then whether the surface itself differs.
    assert.match(source, /const ownPath = conversationSurfaceHref\(targetSurface, id\)/);
    assert.match(source, /if \(pathname !== ownPath\) \{/);
    assert.match(source, /targetSurface !== mountedSurface/);
    // The clicked id travels with the navigation; dropping it is what let the
    // workspace's restore reopen the continuation the user had just left.
    assert.match(
        source,
        /conversationHandoffHref\(targetSurface, id, LEGACY_REVIEW_PATH\)/
    );
});

test("the URL's conversation is opened through the ordinary selection path", () => {
    // Not a bypass: the lock prompt, ownership and the surface check all still
    // run, and an id outside this account's list is ignored.
    const source = read(CLIENT);
    assert.match(source, /initialConversationAppliedRef/);
    assert.match(
        source,
        /void handleSelectConversation\(initialConversationId\)/
    );
    assert.match(
        source,
        /conversations\.some\(\s*\n?\s*\(conversation\) => conversation\.id === initialConversationId/
    );
});

/* --------------------------------------------------------- K-7's unit half */

test("per-model failure isolation is the shared chat path's, one request each", () => {
    /*
      The staging checklist's K-7 -- one model failing must not damage
      another's answer or its cost -- used to be answered by a continuation
      specific module. That module is gone because the property is no longer
      continuation-specific: a continuation is answered by the same `ChatApp`
      per model that every comparison is, so the isolation is the shell's.

      Asserted here rather than deleted with the module, because the checklist
      names this file and because "the shared path owns it" is exactly the
      claim that would stop being true if a continuation ever grew its own
      sending code again.
    */
    const desktop = read("components/chat/DesktopChatShell.tsx");
    const mobile = read("components/chat/MobileChatShell.tsx");
    for (const [name, source] of [
        ["desktop", desktop],
        ["mobile", mobile],
    ]) {
        assert.match(
            source,
            /<ChatApp/,
            `${name} answers each model with its own ChatApp`
        );
    }
    // And the continuation route adds no second sender.
    assert.doesNotMatch(code(ROUTE), /fetch\(/);
    assert.doesNotMatch(code(SOURCE_HOOK), /consumeChatStream/);
});
