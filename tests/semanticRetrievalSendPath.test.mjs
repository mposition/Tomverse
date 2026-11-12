import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { verifyingSemanticModes } from "../lib/semanticRetrievalCore.ts";

/**
 * The route that sends a chat message verifies a context bundle another route
 * issued (docs/policy/external-conversation-import-and-memory.md §9a). It must
 * rebuild that context without asking the retrieval provider -- a call from
 * here is a paid call on the send path, and one whose answer can differ from
 * the signed selection -- and it must rebuild it the way the bundle says it
 * was built.
 *
 * The behaviour is covered against a real database
 * (tests/integration/memory-semantic-retrieval.db.test.ts drives issue,
 * sign and verify end to end). What these check is the wiring that could
 * silently regress: the one argument at each call site, and the mapping.
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

test("the send route rebuilds from the steps its bundle signed", () => {
    const blocks = callBlocks(readFileSync("app/api/chat/route.ts", "utf8"), "buildChatTurnContext").filter(
        (block) => block.startsWith("buildChatTurnContext({")
    );
    assert.ok(blocks.length > 0, "the send route builds a turn context");
    for (const block of blocks) {
        assert.match(
            block,
            /semantic:\s*verifyingSemanticModes\(readChatContextBundleSemanticSteps\(token\)\)/
        );
    }
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

test("a used step is reproduced from the store, every other step is off, and nothing may call", () => {
    const all = { memoryRerank: true, knowledgeNeighbours: true, knowledgeRerank: true };
    assert.deepEqual(verifyingSemanticModes(all), {
        memoryRerank: "cached_only",
        knowledgeNeighbours: "cached_only",
        knowledgeRerank: "cached_only",
    });
    assert.deepEqual(
        verifyingSemanticModes({ memoryRerank: false, knowledgeNeighbours: true, knowledgeRerank: false }),
        { memoryRerank: "off", knowledgeNeighbours: "cached_only", knowledgeRerank: "off" }
    );
    // An unreadable bundle fails verification anyway; it is rebuilt with nothing on.
    assert.deepEqual(verifyingSemanticModes(null), {
        memoryRerank: "off",
        knowledgeNeighbours: "off",
        knowledgeRerank: "off",
    });
    for (const steps of [all, null]) {
        assert.ok(!Object.values(verifyingSemanticModes(steps)).includes("allow"));
    }
});
