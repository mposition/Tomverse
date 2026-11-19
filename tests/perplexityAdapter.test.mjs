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
    // A re-export with one more turn is the same lineage (§4.2).
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
