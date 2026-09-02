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
const PRELUDE = "components/continuations/ContinuationSourcePrelude.tsx";
const CLIENT = "app/(site)/(application)/chat/ChatPageClient.tsx";

/* ------------------------------------------- the route is the shared shell */

test("the continuation route renders the workspace every other chat route renders", () => {
    const source = code(ROUTE);
    assert.match(source, /ReviewWorkspaceShell/);
    assert.match(source, /mountedSurface="continuation"/);
    assert.match(source, /ContinuationSourcePrelude/);
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
    ]) {
        assert.equal(existsSync(path), false, `${path} must be deleted`);
    }
});

/* ------------------------------------------------ the prelude cannot send */

test("the prelude reads the imported half and can do nothing else", () => {
    // §5.1: the excerpt reaches the model as a server-built system block. A
    // component with no way to post cannot put imported text in a request
    // body, which is the strongest form of that guarantee available here.
    const source = code(PRELUDE);
    assert.match(source, /\/continuation\?/, "it reads the timeline endpoint");
    for (const forbidden of ["/api/chat", "method: \"POST\"", "<textarea"]) {
        assert.ok(
            !source.includes(forbidden),
            `the prelude must not contain ${forbidden}`
        );
    }
});

test("the prelude states provenance, provider and truncation", () => {
    const source = read(PRELUDE);
    for (const testId of [
        "continuation-source-section",
        "continuation-provenance",
        "continuation-seed-summary",
        "continuation-external-badge",
        "continuation-source-tombstone",
        "continuation-source-locked",
        "continuation-divider",
    ]) {
        assert.match(source, new RegExp(`data-testid="${testId}"`), testId);
    }
    assert.match(source, /viewerTruncatedNotice/);
});

test("a gone or locked source is on screen rather than behind the disclosure", () => {
    // Both change what the next turn carries, so neither may need a click to
    // be discovered. Only an available transcript has a disclosure at all,
    // and it starts open: the imported conversation is why the screen exists.
    const source = read(PRELUDE);
    assert.match(source, /const canDisclose = source\.status === "available"/);
    assert.match(source, /const \[expanded, setExpanded\] = useState\(true\)/);
    assert.match(
        source,
        /\{canDisclose \? \(\s*<button[\s\S]*?data-testid="continuation-source-toggle"/,
        "the toggle only exists for an available transcript"
    );

    const panelAt = source.indexOf("id={panelId}");
    assert.ok(panelAt > 0, "the collapsible panel is identified");
    for (const testId of [
        "continuation-source-tombstone",
        "continuation-source-locked",
    ]) {
        const at = source.indexOf(`data-testid="${testId}"`);
        assert.ok(at > 0, testId);
        assert.ok(at < panelAt, `${testId} is outside the collapsible panel`);
    }
    assert.match(
        source,
        /hidden=\{!canDisclose \|\| !expanded\}/,
        "only the transcript panel is what the toggle hides"
    );
});

/* ------------------------------------------- one prelude, never per panel */

test("both shells take the prelude, and above the panels", () => {
    // §5.1: the source is drawn once for the conversation. `ChatApp` is
    // mounted once per selected model, so the slot has to be in the shell.
    for (const path of [
        "components/chat/DesktopChatShell.tsx",
        "components/chat/MobileChatShell.tsx",
    ]) {
        const source = read(path);
        assert.equal(
            (source.match(/\{conversationPrelude\}/g) ?? []).length,
            1,
            `${path} renders it exactly once`
        );
        const preludeAt = source.indexOf("{conversationPrelude}");
        const chatAppAt = source.indexOf("<ChatApp");
        assert.ok(preludeAt > 0);
        assert.ok(
            chatAppAt === -1 || preludeAt < chatAppAt,
            `${path} renders it above the panel row`
        );
    }
});

test("the workspace hands the prelude to whichever shell is mounted", () => {
    const source = read(CLIENT);
    assert.equal(
        (source.match(/conversationPrelude=\{conversationPrelude\}/g) ?? [])
            .length,
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
    assert.match(
        source,
        /if \(targetSurface && targetSurface !== mountedSurface\) \{/
    );
    // An unclassified row is left on the in-place path rather than guessed at.
    assert.doesNotMatch(source, /targetSurface !== mountedSurface \|\|/);
    assert.match(source, /LEGACY_REVIEW_PATH/);
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
    assert.doesNotMatch(code(PRELUDE), /consumeChatStream/);
});
