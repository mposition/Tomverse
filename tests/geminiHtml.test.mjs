import assert from "node:assert/strict";
import { test } from "node:test";
import {
    GeminiMarkupError,
    countImages,
    geminiHtmlToMarkdown,
} from "../lib/externalImportAdapters/geminiHtml.ts";

// docs/policy/external-import-gemini-a2.md §4, §5.
//
// A Gemini answer arrives as rendered HTML. It is converted back to Markdown
// because the product renders message bodies as Markdown -- storing the HTML
// would show the user their own answer with the markup in it.

test("prose, emphasis and links round-trip", () => {
    assert.equal(
        geminiHtmlToMarkdown(
            "<p>Set <strong>three things</strong> first, in <em>this</em> order.</p>"
        ),
        "Set **three things** first, in *this* order."
    );
    assert.equal(
        geminiHtmlToMarkdown('<p>See <a href="https://example.test/docs">the docs</a>.</p>'),
        "See [the docs](https://example.test/docs)."
    );
});

test("a code block keeps its whitespace, and inline code does not become one", () => {
    // The distinction matters: `pre` is verbatim, everything else collapses
    // whitespace, and collapsing a code block would corrupt the code.
    assert.equal(
        geminiHtmlToMarkdown("<pre><code>const a = 1;\n  const b = 2;\n</code></pre>"),
        "```\nconst a = 1;\n  const b = 2;\n```"
    );
    assert.equal(
        geminiHtmlToMarkdown("<p>Call <code>reduce()</code> with a seed.</p>"),
        "Call `reduce()` with a seed."
    );
});

test("entities are decoded, including inside code", () => {
    // Gemini escapes the code it renders, so an un-decoded block would show
    // the user `=&gt;` where they wrote `=>`.
    assert.equal(
        geminiHtmlToMarkdown("<pre><code>items.map((x) =&gt; x + 1)</code></pre>"),
        "```\nitems.map((x) => x + 1)\n```"
    );
    assert.equal(geminiHtmlToMarkdown("<p>a &amp; b &lt; c &#39;d&#39;</p>"), "a & b < c 'd'");
});

test("lists keep their kind and their nesting", () => {
    assert.equal(
        geminiHtmlToMarkdown("<ul><li>one</li><li>two</li></ul>"),
        "- one\n- two"
    );
    assert.equal(
        geminiHtmlToMarkdown("<ol><li>first</li><li>second</li></ol>"),
        "1. first\n2. second"
    );
    assert.equal(
        geminiHtmlToMarkdown("<ul><li>outer<ul><li>inner</li></ul></li></ul>"),
        "- outer\n  - inner"
    );
});

test("a table becomes a table, not a run-on line", () => {
    const markdown = geminiHtmlToMarkdown(
        '<table><thead><tr><th align="left">Way</th><th align="left">Upside</th></tr></thead>' +
            '<tbody><tr><td align="left">A</td><td align="left">Simple</td></tr></tbody></table>'
    );
    assert.equal(markdown, "| Way | Upside |\n| --- | --- |\n| A | Simple |");
});

test("headings, rules and quotes survive", () => {
    assert.equal(geminiHtmlToMarkdown("<h3>Example</h3>"), "### Example");
    assert.equal(geminiHtmlToMarkdown("<hr/>"), "---");
    assert.equal(
        geminiHtmlToMarkdown("<blockquote><p>Both must be reversible.</p></blockquote>"),
        "> Both must be reversible."
    );
});

test("blocks are separated, and a line break inside one is kept", () => {
    assert.equal(
        geminiHtmlToMarkdown("<p>one</p><p>two</p>"),
        "one\n\ntwo"
    );
    assert.equal(geminiHtmlToMarkdown("<p>one<br/>two</p>"), "one\ntwo");
});

test("markup outside the vocabulary is refused, not guessed at", () => {
    // §5: the worst outcome is not a parse failure, it is a half-correct
    // parse. The caller drops the turn and counts it rather than storing an
    // answer whose meaning we cannot vouch for.
    assert.throws(
        () => geminiHtmlToMarkdown("<p>before</p><video src='x'></video>"),
        GeminiMarkupError
    );
    assert.throws(() => geminiHtmlToMarkdown("<script>alert(1)</script>"), GeminiMarkupError);
    assert.throws(() => geminiHtmlToMarkdown("<iframe></iframe>"), GeminiMarkupError);
});

test("an image is counted rather than rendered", () => {
    assert.equal(countImages('<p>a</p><img src="x.png" alt="y"><img src="z.png">'), 2);
    assert.equal(
        geminiHtmlToMarkdown('<p>See below.</p><img src="x.png" alt="chart">'),
        "See below."
    );
});

test("an unbalanced close tag does not eat the rest of the answer", () => {
    assert.equal(geminiHtmlToMarkdown("<p>kept</p></div><p>also kept</p>"), "kept\n\nalso kept");
});
