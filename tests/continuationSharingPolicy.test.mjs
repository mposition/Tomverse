import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    CONTINUATION_SHARE_REFUSAL_CODE,
    continuationShareRefusal,
} from "../lib/continuationSharingPolicy.ts";
import {
    conversationSurface,
    surfaceHasContinuationBridge,
} from "../lib/continuationRoutes.ts";

/**
 * The refusal, and the agreement the refusal depends on.
 *
 * `docs/policy/external-conversation-continuation.md` §9 refuses to publish a
 * conversation continued from an imported chat, and
 * `lib/continuationSharingPolicy.ts` says in its own header why one function
 * decides it: "The route and the UI must agree ... the drift shows up as a
 * control the screen offers and the server refuses. Both call this."
 *
 * On 2026-09-11 only the route called it. The screen offered share on a
 * continuation, the server answered 409, and the client had no branch for 409
 * -- so the reason arrived as `sidebar.shareFailed`, "Failed to create share
 * link", which describes a transient error rather than a permanent refusal. A
 * staging console carried three of them from one session, one per press.
 *
 * So the interesting assertions here are the static ones. The pure function was
 * never wrong; what was wrong is that a second caller did not exist, and
 * nothing failed when it didn't.
 */

const repoRoot = join(import.meta.dirname, "..");
const source = (path) => readFileSync(join(repoRoot, path), "utf8");

test("a conversation with an imported half is refused, and one without is not", () => {
    const refusal = continuationShareRefusal({ hasContinuationBridge: true });
    assert.ok(refusal, "a bridged conversation must be refused");
    assert.equal(refusal.code, CONTINUATION_SHARE_REFUSAL_CODE);
    assert.equal(
        refusal.status,
        409,
        "the refusal is a conflict with the conversation's own provenance, not a permission failure"
    );

    assert.equal(
        continuationShareRefusal({ hasContinuationBridge: false }),
        null,
        "an ordinary conversation must still be publishable"
    );
});

test("the surface a row carries and the fact the policy needs are one decision", () => {
    // The client is not told `hasContinuationBridge`; it is told where the row
    // opens. These two functions are why that is enough, and this is the
    // round trip that keeps them from drifting apart.
    for (const hasContinuationBridge of [true, false]) {
        assert.equal(
            surfaceHasContinuationBridge(
                conversationSurface({ hasContinuationBridge })
            ),
            hasContinuationBridge,
            `the surface must carry ${hasContinuationBridge} back out intact`
        );
    }

    // A guest conversation has no server row and so no surface. It can never
    // be a continuation, and reading absent as "no bridge" is what lets the
    // share control behave for it exactly as it did before continuations.
    assert.equal(surfaceHasContinuationBridge(undefined), false);
});

test("the route and the client both decide with the policy function", () => {
    const route = source(
        "app/api/conversations/[conversationId]/share/route.ts"
    );
    assert.match(
        route,
        /continuationShareRefusal\(/,
        "the route must decide with the policy function"
    );

    const client = source("app/(site)/(application)/chat/ChatPageClient.tsx");
    assert.match(
        client,
        /continuationShareRefusal\(/,
        "the share handler must decide with the same function, not with a condition of its own"
    );
    assert.match(
        client,
        /CONTINUATION_SHARE_REFUSAL_CODE/,
        "the handler must also recognise the refusal when it arrives from the server, for a row whose surface never did"
    );

    const sidebar = source("components/chat/ChatSidebar.tsx");
    assert.match(
        sidebar,
        /continuationShareRefusal\(/,
        "the dialog that offers share must ask whether this conversation may be shared"
    );
});

test("the refusal reaches the user as its own sentence, in every locale", () => {
    const client = source("app/(site)/(application)/chat/ChatPageClient.tsx");
    const sidebar = source("components/chat/ChatSidebar.tsx");

    for (const [label, text] of [
        ["the share handler", client],
        ["the share dialog", sidebar],
    ]) {
        assert.match(
            text,
            /sidebar\.shareContinuationUnavailable/,
            `${label} must name the refusal's own copy key, not the generic failure`
        );
    }

    // `tests/localeParity.test.mjs` holds the key present in all seven
    // locales. What it cannot say is that the copy makes no promise a retry
    // could keep, so that is asserted here: a refusal that says "try again"
    // sends the owner round a loop with no end, which is the mistake the
    // continuation launcher's own refusal copy already documents for its 403
    // and its 404.
    //
    // Named by what it is rather than by its path on purpose. This file is
    // cherry-picked to both release branches, and the launcher exists on only
    // one of them -- so a path here would be a broken reference on `main`
    // (`npm run check:doc-references` fails on exactly that, correctly).
    for (const locale of ["en", "ko", "de", "es", "fr", "pt", "zh"]) {
        const line = source(`locales/${locale}.ts`)
            .split("\n")
            .find((candidate) =>
                candidate.includes("shareContinuationUnavailable:")
            );
        assert.ok(line, `${locale} must carry the refusal copy`);
        assert.ok(
            !/try again|again later|재시도|다시 시도/i.test(line),
            `${locale} must not invite a retry of a permanent refusal`
        );
    }
});

test("the sidebar keeps the entry and removes only the confirm", () => {
    const sidebar = source("components/chat/ChatSidebar.tsx");

    // The dialog explains. Hiding the menu entry would answer "can this be
    // shared?" with silence, which is the state this change moved away from.
    assert.match(
        sidebar,
        /data-testid="share-continuation-refusal"/,
        "the refusal must be visible in the dialog, with its reason"
    );
    assert.match(
        sidebar,
        /\{!shareRefusal && \(/,
        "the confirm button is the one thing that goes: its request cannot succeed"
    );
});
