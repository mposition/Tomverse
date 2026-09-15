import assert from "node:assert/strict";
import test from "node:test";

import { searchSnippet } from "../lib/searchSnippet.ts";

/** CONT-SEARCH-01: the excerpt shows why a long message matched. */

const highlighted = ({ text, highlight }) =>
    highlight ? text.slice(highlight.start, highlight.end) : null;

test("a short message is returned whole with the match highlighted", () => {
    const snippet = searchSnippet("배포 일정은 금요일입니다", "금요일");
    assert.equal(snippet.text, "배포 일정은 금요일입니다");
    assert.equal(highlighted(snippet), "금요일");
});

test("a match deep inside a long message is centred, with ellipses on both sides", () => {
    const content = `${"가".repeat(500)}Needle${"나".repeat(500)}`;
    const snippet = searchSnippet(content, "needle", 10);
    assert.equal(snippet.text, `…${"가".repeat(10)}Needle${"나".repeat(10)}…`);
    // Case-insensitive like ILIKE, but the original casing is what is shown.
    assert.equal(highlighted(snippet), "Needle");
});

test("a cut never splits a surrogate pair", () => {
    const content = `${"😀".repeat(100)}match${"😀".repeat(100)}`;
    const snippet = searchSnippet(content, "match", 3);
    assert.equal(snippet.text, "…😀😀😀match😀😀😀…");
    assert.doesNotThrow(() => encodeURIComponent(snippet.text));
    assert.equal(highlighted(snippet), "match");
});

test("no locatable match falls back to the opening without a highlight", () => {
    const content = "x".repeat(300);
    const snippet = searchSnippet(content, "absent");
    assert.equal(snippet.text, `${"x".repeat(180)}…`);
    assert.equal(snippet.highlight, null);
    assert.equal(searchSnippet("short", "absent").text, "short");
});

test("the first match wins and the needle is trimmed", () => {
    const snippet = searchSnippet("alpha beta alpha", "  alpha ");
    assert.deepEqual(snippet.highlight, { start: 0, end: 5 });
});
