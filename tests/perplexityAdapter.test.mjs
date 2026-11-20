import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
    perplexityAdapter,
    perplexityMarkdownEntry,
} from "../lib/externalImportAdapters/perplexity.ts";
import {
    detectExternalImportAdapter,
    EXTERNAL_IMPORT_ADAPTERS,
} from "../lib/externalImportAdapters/index.ts";
import { buildImportPreview, parseConversationItems } from "../lib/externalImportPipeline.ts";
import { EXTERNAL_IMPORT_PROVIDERS } from "../lib/externalImportProviders.ts";

// A Perplexity thread exported as Markdown. The fixture follows the structure
// of real exports (logo line, `# question`, turn-scoped `[^n_m]` footnotes,
// the hidden-citation span, the ⁂ divider in both its spellings, `---`
// between turns); every value in it is synthetic.

const THREAD = readFileSync(
    new URL("./fixtures/perplexityMarkdown/thread.md", import.meta.url),
    "utf8"
);
const items = (text) => [perplexityMarkdownEntry(text)];
const parse = (text) => perplexityAdapter.parseConversation(perplexityMarkdownEntry(text));

test("perplexity is a canonical provider with a registered adapter", () => {
    assert.ok(EXTERNAL_IMPORT_PROVIDERS.includes("perplexity"));
    assert.ok(EXTERNAL_IMPORT_ADAPTERS.some((a) => a.provider === "perplexity"));
});

test("a Perplexity Markdown export is detected, and nothing else claims it", () => {
    assert.equal(detectExternalImportAdapter(items(THREAD))?.provider, "perplexity");
    const withoutLogo = THREAD.split("\n").slice(1).join("\n");
    assert.equal(perplexityAdapter.detect(items(withoutLogo)), true, "footnotes alone identify it");
});

test("a plain Markdown file or another provider's export is not taken for Perplexity", () => {
    assert.equal(perplexityAdapter.detect(items("# My notes\n\nSome text.\n")), false);
    assert.equal(detectExternalImportAdapter(items("# My notes\n")), null);
    assert.equal(perplexityAdapter.detect([{ uuid: "x", chat_messages: [] }]), false);
    assert.equal(perplexityAdapter.detect([]), false);
    assert.equal(perplexityAdapter.detect("not an array"), false);
});

test("turns split at a level-one heading after ---, not at an answer's own rule or a fenced block", () => {
    const conversation = parse(THREAD);
    assert.ok(conversation);
    assert.deepEqual(
        conversation.messages.map((m) => m.role),
        ["user", "assistant", "user", "assistant", "user", "assistant"]
    );
    assert.deepEqual(
        conversation.messages.map((m) => m.ordinal),
        [0, 1, 2, 3, 4, 5]
    );
    assert.equal(
        conversation.messages[0].content,
        "How do I keep a sourdough starter alive while travelling?"
    );
    // A quoted selection reads as a quotation, not as raw markup.
    assert.equal(
        conversation.messages[2].content,
        "“a stiff ratio such as 1:5:5” what does that mean?"
    );
    const second = conversation.messages[3].content;
    assert.match(second, /## Worked example/);
    assert.match(second, /# not a question: a comment inside a fenced block/);
    assert.match(second, /That is all there is to it\./);
    assert.equal(conversation.messages[4].content, "thanks");
    assert.equal(conversation.messages[5].content, "You are welcome.");
});

test("citations survive as numbered marks and a Sources list, hidden ones included", () => {
    const answer = parse(THREAD).messages[1].content;
    assert.match(answer, /once a week\.\[1\]\[2\]/);
    assert.match(answer, /1:5:5\.\[3\]/);
    assert.ok(answer.endsWith(
        "Sources:\n" +
            "[1] https://example.com/starter-care\n" +
            "[2] https://example.org/cold-fermentation\n" +
            "[3] https://example.net/stiff-starter\n" +
            "[4] https://example.com/hidden-one\n" +
            "[5] https://example.com/hidden-two"
    ));
    for (const leftover of ["[^1_", "⁂", "<span", "<div", "<img", "\n---"]) {
        assert.ok(!answer.includes(leftover), `${leftover} must not reach the stored answer`);
    }
    const second = parse(THREAD).messages[3].content;
    assert.ok(second.endsWith("Sources:\n[1] https://example.com/ratios"));
    assert.ok(!second.includes("<div"), "the align=center divider is removed too");
});

test("the conversation carries a title, a stable lineage id and no invented provenance", () => {
    const conversation = parse(THREAD);
    assert.equal(conversation.title, "How do I keep a sourdough starter alive while travelling?");
    assert.match(conversation.rawExternalConversationId, /^perplexity-md-[0-9a-f]{16}$/);
    assert.ok(
        !conversation.rawExternalConversationId.includes("sourdough"),
        "the question text is not used as an identifier"
    );
    // A re-export with one more turn is the same lineage (docs/policy/external-conversation-import-and-memory.md §4.2).
    const longer = parse(`${THREAD}\n---\n\n# one more\n\nSure.\n`);
    assert.equal(longer.rawExternalConversationId, conversation.rawExternalConversationId);
    assert.equal(longer.messages.length, 8);
    assert.equal(conversation.sourceCreatedAt, null);
    assert.deepEqual(conversation.sourceModelLabels, []);
    for (const message of conversation.messages) {
        assert.equal(message.sourceModelLabel, null);
        assert.equal(message.sourceTimestamp, null);
    }
});

const LOGO = '<img src="https://r2cdn.perplexity.ai/pplx-full-logo-primary-dark%402x.png"/>';

test("an answer's own rule and level-one heading stay in the answer when its citations say so", () => {
    const conversation = parse(
        [
            LOGO,
            "",
            "# Compare the two plans",
            "",
            "Plan A is cheaper.[^1_1]",
            "",
            "---",
            "",
            "# Summary",
            "",
            "Pick A unless you need B's support.[^1_2]",
            "",
            '<div align="center">⁂</div>',
            "",
            "[^1_1]: https://example.com/a",
            "",
            "[^1_2]: https://example.com/b",
            "",
            "---",
            "",
            "# And for a team?",
            "",
            "Then B.[^2_1]",
            "",
            "[^2_1]: https://example.com/team",
            "",
        ].join("\n")
    );
    assert.deepEqual(
        conversation.messages.map((m) => [m.role, m.content.split("\n")[0]]),
        [
            ["user", "Compare the two plans"],
            ["assistant", "Plan A is cheaper.[1]"],
            ["user", "And for a team?"],
            ["assistant", "Then B.[1]"],
        ]
    );
    const answer = conversation.messages[1].content;
    assert.match(answer, /---\n\n# Summary\n\nPick A unless you need B's support\.\[2\]/);
    assert.ok(answer.endsWith("Sources:\n[1] https://example.com/a\n[2] https://example.com/b"));
});

test("a cited answer split twice by rules and headings of its own comes back whole", () => {
    const conversation = parse(
        [
            LOGO, "", "# plan a trip", "",
            "Day one.[^1_1]", "", "---", "", "# Day two", "", "Museums.", "", "---", "", "# Day three", "",
            "Beach.[^1_2]", "", "[^1_1]: https://example.com/1", "", "[^1_2]: https://example.com/2", "",
            "---", "", "# budget?", "", "Modest.[^2_1]", "", "[^2_1]: https://example.com/b", "",
        ].join("\n")
    );
    assert.deepEqual(
        conversation.messages.map((m) => [m.role, m.content.split("\n")[0]]),
        [["user", "plan a trip"], ["assistant", "Day one.[1]"], ["user", "budget?"], ["assistant", "Modest.[1]"]]
    );
    assert.match(conversation.messages[1].content, /# Day two\n\nMuseums\.\n\n---\n\n# Day three/);
});

test("a follow-up quoting the previous answer's marks stays its own turn", () => {
    const conversation = parse(
        `${LOGO}\n\n# first\n\nOne.[^1_1]\n\n[^1_1]: https://example.com/1\n\n---\n\n# why does [^1_1] say that?\n\nIt is a guess.\n`
    );
    assert.deepEqual(conversation.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
    assert.equal(conversation.messages[3].content, "It is a guess.");
});

test("an uncited turn followed by a cited one keeps both questions", () => {
    const conversation = parse(
        `${LOGO}\n\n# first\n\nNo sources here.\n\n---\n\n# second\n\nCited.[^2_1]\n\n[^2_1]: https://example.com/2\n`
    );
    assert.deepEqual(
        conversation.messages.map((m) => m.content.split("\n")[0]),
        ["first", "No sources here.", "second", "Cited.[1]"]
    );
});

test("blank lines inside a code block are kept as they are", () => {
    const answer = parse(
        `${LOGO}\n\n# q\n\n\`\`\`python\nx = 1\n\n\n\ny = 2\n\`\`\`\n\n\n\nAfter.\n`
    ).messages[1].content;
    assert.equal(answer, "```python\nx = 1\n\n\n\ny = 2\n```\n\nAfter.");
});

test("a longer fence that shows a shorter one stays code to its own close", () => {
    const conversation = parse(
        [
            LOGO, "", "# show me a fenced block", "",
            "````markdown", "```", "---", "", "# not a question", "[^1_9]: https://example.com/code", "```", "````",
            "", "Done.[^1_1]", "", "[^1_1]: https://example.com/real", "",
            "---", "", "# next", "", "Yes.", "",
        ].join("\n")
    );
    assert.deepEqual(conversation.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
    const answer = conversation.messages[1].content;
    assert.match(answer, /````markdown\n```\n---\n\n# not a question\n\[\^1_9\]: https:\/\/example\.com\/code\n```\n````/);
    assert.ok(answer.endsWith("Sources:\n[1] https://example.com/real"), "a definition inside code is code");
    assert.equal(conversation.messages[2].content, "next");
});

test("threads that open with the same question but differ are separate lineages", () => {
    const thread = (answer) => parse(`${LOGO}\n\n# What should I cook tonight?\n\n${answer}\n`);
    const one = thread("Try a risotto.");
    const two = thread("Try a curry.");
    assert.notEqual(one.rawExternalConversationId, two.rawExternalConversationId);
    assert.notEqual(one.messages[0].rawExternalMessageId, two.messages[0].rawExternalMessageId);
});

test("hidden citation spans are recognised in other attribute spellings", () => {
    const answer = parse(
        `${LOGO}\n\n# q\n\nA.[^1_1]\n<span class="hidden" style="display: none;">[^1_2] [^1_3]</span>\n\n[^1_1]: https://example.com/1\n\n[^1_2]: https://example.com/2\n\n[^1_3]: https://example.com/3\n`
    ).messages[1].content;
    assert.ok(!answer.includes("<span"));
    assert.ok(answer.endsWith("[3] https://example.com/3"));
});

test("an answer ending on a rule of its own does not keep it", () => {
    const conversation = parse(`${LOGO}\n\n# q\n\nAnswer.\n\n---\n\n---\n\n# next\n\nMore.\n`);
    assert.equal(conversation.messages[1].content, "Answer.");
});

test("Windows line endings parse the same", () => {
    const lf = parse(THREAD);
    const crlf = parse(THREAD.replace(/\n/g, "\r\n"));
    assert.deepEqual(crlf.messages, lf.messages);
});

test("a long first question is shortened for the title only", () => {
    const question = "q".repeat(120);
    const conversation = parse(
        `<img src="https://r2cdn.perplexity.ai/pplx-full-logo-primary-dark%402x.png"/>\n\n# ${question}\n\nanswer\n`
    );
    assert.equal(Array.from(conversation.title).length, 81);
    assert.ok(conversation.title.endsWith("…"));
    assert.equal(conversation.messages[0].content, question);
});

test("an unanswered last question is kept and the empty answer counted", () => {
    const conversation = parse(
        `<img src="https://r2cdn.perplexity.ai/pplx-full-logo-primary-dark%402x.png"/>\n\n# first\n\nanswer\n\n---\n\n# second\n`
    );
    assert.deepEqual(conversation.messages.map((m) => m.content), ["first", "answer", "second"]);
    assert.equal(conversation.warnings.skippedEmptyMessages, 1);
});

test("a file with no question heading is unparsable, not an empty conversation", () => {
    assert.equal(
        parse('<img src="https://r2cdn.perplexity.ai/pplx-full-logo-primary-dark%402x.png"/>\n\njust text\n'),
        null
    );
    assert.equal(perplexityAdapter.parseConversation({ other: "shape" }), null);
});

test("the pipeline previews one importable conversation for the file", () => {
    const { conversations, unparsableCount } = parseConversationItems("perplexity", items(THREAD));
    assert.equal(unparsableCount, 0);
    assert.equal(conversations.length, 1);
    const preview = buildImportPreview("perplexity", conversations);
    assert.equal(preview.provider, "perplexity");
    assert.equal(preview.totals.conversations, 1);
    assert.equal(preview.totals.importableConversations, 1);
    assert.equal(preview.totals.messages, 6);
});

// The account data export: a ZIP whose conversations-<timestamp>.json wraps
// the thread list in an object. The fixture follows a real export's keys;
// every value in it is synthetic.

const ACCOUNT = readFileSync(
    new URL("./fixtures/perplexityAccount/conversations.json", import.meta.url),
    "utf8"
);

test("the account export's wrapped list is found in the archive and detected", async () => {
    const { readArchiveEntryItems, classifyArchiveEntry } = await import(
        "../lib/externalImportArchive.ts"
    );
    const decision = classifyArchiveEntry({
        name: "conversations-20261118_091203-0b7f3c2e.json",
        uncompressedBytes: ACCOUNT.length,
        compressedBytes: ACCOUNT.length,
    });
    assert.deepEqual(decision, { kind: "parse", role: "candidate" });
    // The spreadsheet beside it is never opened.
    assert.equal(
        classifyArchiveEntry({ name: "user-data-20261118.xlsx", uncompressedBytes: 10, compressedBytes: 10 }).kind,
        "skip"
    );
    const read = readArchiveEntryItems(ACCOUNT, "candidate");
    assert.equal(read.items.length, 3);
    assert.equal(detectExternalImportAdapter(read.items)?.provider, "perplexity");
});

test("each account-export entry is one question and one answer, with the export's ids and times", () => {
    const items = JSON.parse(ACCOUNT).conversations;
    const { conversations, unparsableCount } = parseConversationItems("perplexity", items);
    // The empty thread has nothing to import.
    assert.equal(unparsableCount, 1);
    assert.equal(conversations.length, 2);

    const [first, second] = conversations;
    assert.equal(first.rawExternalConversationId, "0b7f3c2e-5d41-4a8e-9c6b-1f2e3d4c5b6a");
    assert.equal(first.title, "How long does a sourdough starter keep in the fridge?");
    assert.equal(first.sourceCreatedAt, "2026-11-18T09:12:03.104Z");
    assert.deepEqual(first.messages.map((m) => [m.role, m.ordinal]), [
        ["user", 0],
        ["assistant", 1],
        ["user", 2],
        ["assistant", 3],
    ]);
    assert.equal(first.messages[0].rawExternalMessageId, "7a1c9e40-2b3d-4f5e-8a6b-0c1d2e3f4a5b-query");
    assert.equal(first.messages[3].rawExternalMessageId, "9d2e8f71-3c4b-4a6d-9e7f-1a2b3c4d5e6f-answer");
    assert.equal(first.messages[2].sourceTimestamp, "2026-11-18T09:15:20.007Z");
    // The answer is kept as written; the export has no source list for [n].
    assert.match(first.messages[1].content, /## Before you travel/);
    assert.match(first.messages[1].content, /\[2\]$/);
    assert.deepEqual(first.sourceModelLabels, []);
    assert.equal(first.messages[1].sourceModelLabel, null);

    // No title falls back to the first question; an unanswered entry keeps
    // its question and counts the missing answer.
    assert.equal(second.title, "Which flour makes the most active starter?");
    assert.deepEqual(second.messages.map((m) => m.role), ["user", "assistant", "user"]);
    assert.equal(second.warnings.skippedEmptyMessages, 1);
});

test("only Markdown conversations carry the split-uncertainty id", async () => {
    const { isPerplexityMarkdownConversation } = await import(
        "../lib/externalImportAdapters/perplexity.ts"
    );
    const markdown = parse(THREAD);
    assert.ok(isPerplexityMarkdownConversation(markdown.rawExternalConversationId));
    const [account] = parseConversationItems("perplexity", JSON.parse(ACCOUNT).conversations).conversations;
    assert.equal(isPerplexityMarkdownConversation(account.rawExternalConversationId), false);
});

test("another provider's list is not mistaken for the account export", () => {
    assert.equal(perplexityAdapter.detect([{ uuid: "x", chat_messages: [] }]), false);
    assert.equal(perplexityAdapter.detect([{ context_uuid: "x", entries: [] }]), false);
    assert.equal(perplexityAdapter.detect([{ context_uuid: "x", entries: [{ query: "q" }] }]), false);
});
