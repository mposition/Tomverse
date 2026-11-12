import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * The route that sends a chat message verifies a context bundle another route
 * issued (docs/policy/external-conversation-import-and-memory.md §9a). It must
 * rebuild that context without asking the retrieval provider: a call from here
 * is a paid call on the send path, and one whose answer can differ from the
 * signed selection.
 *
 * A structural check rather than a behavioural one, because the behaviour is
 * covered where it lives (the database suites drive "cached_only" directly)
 * and what can silently regress is this one argument at the call site.
 */

const callBlocks = (source) => {
    const blocks = [];
    let from = 0;
    for (;;) {
        const start = source.indexOf("buildChatTurnContext({", from);
        if (start < 0) return blocks;
        let depth = 0;
        let index = source.indexOf("(", start);
        do {
            const character = source[index];
            if (character === "(") depth += 1;
            if (character === ")") depth -= 1;
            index += 1;
        } while (depth > 0 && index < source.length);
        blocks.push(source.slice(start, index));
        from = index;
    }
};

test("the send route rebuilds its context from cached semantic results only", () => {
    const blocks = callBlocks(readFileSync("app/api/chat/route.ts", "utf8"));
    assert.ok(blocks.length > 0, "the send route builds a turn context");
    for (const block of blocks) {
        assert.match(block, /semantic:\s*"cached_only"/);
    }
});

test("the routes that issue a bundle are the ones allowed to call the provider", () => {
    for (const route of ["app/api/chat/context/route.ts", "app/api/chat/preflight/route.ts"]) {
        const blocks = callBlocks(readFileSync(route, "utf8"));
        assert.ok(blocks.length > 0, `${route} builds a turn context`);
        for (const block of blocks) {
            assert.doesNotMatch(block, /semantic:/, `${route} issues the bundle`);
        }
    }
});
