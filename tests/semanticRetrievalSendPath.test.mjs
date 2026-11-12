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
 * covered where it lives (the database suites drive the modes directly) and
 * what can silently regress is how this one call site is wired.
 */

const callBlocks = (source, name) => {
    const blocks = [];
    let from = 0;
    for (;;) {
        const start = source.indexOf(name + "(", from);
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

test("the send route builds its context only through the verifying rebuild", () => {
    const source = readFileSync("app/api/chat/route.ts", "utf8");
    const rebuilds = callBlocks(source, "rebuildTurnContextForBundle");
    assert.ok(rebuilds.length > 0, "the send route rebuilds for the bundle it verifies");

    const builds = callBlocks(source, "buildChatTurnContext").filter((block) =>
        block.startsWith("buildChatTurnContext({")
    );
    assert.ok(builds.length > 0, "the send route builds a turn context");
    for (const build of builds) {
        // The mode comes from the rebuild, never from a literal here.
        assert.match(build, /\n\s*semantic,\n/);
        assert.ok(
            rebuilds.some((rebuild) => rebuild.includes(build)),
            "every context build on the send route is inside the verifying rebuild"
        );
    }
});

test("the verifying rebuild never uses the mode that may call the provider", () => {
    const source = readFileSync("lib/chatTurnContext.ts", "utf8");
    const start = source.indexOf("const VERIFYING_MODES");
    const end = source.indexOf("];", start);
    assert.ok(start >= 0 && end > start, "the verifying modes are declared");
    const modes = source.slice(start, end);
    assert.doesNotMatch(modes, /"allow"/);
    assert.match(modes, /"cached_only"/);
    assert.match(modes, /"off"/);
});

test("the routes that issue a bundle are the ones allowed to call the provider", () => {
    for (const route of ["app/api/chat/context/route.ts", "app/api/chat/preflight/route.ts"]) {
        const blocks = callBlocks(readFileSync(route, "utf8"), "buildChatTurnContext");
        assert.ok(blocks.length > 0, `${route} builds a turn context`);
        for (const block of blocks) {
            assert.doesNotMatch(block, /semantic/, `${route} issues the bundle`);
        }
    }
});
