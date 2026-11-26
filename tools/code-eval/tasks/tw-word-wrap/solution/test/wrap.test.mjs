import { test } from "node:test";
import assert from "node:assert/strict";
import { wrap } from "../src/index.js";

test("fills lines greedily", () => {
    assert.equal(wrap("the quick brown fox", 10), "the quick\nbrown fox");
    assert.equal(wrap("aaa bbb ccc ddd", 7), "aaa bbb\nccc ddd");
});

test("a line of exactly width characters fits", () => {
    assert.equal(wrap("abc def", 7), "abc def");
    assert.equal(wrap("abc def", 6), "abc\ndef");
    assert.equal(wrap("abcdef", 6), "abcdef");
});

test("breaks words longer than the width", () => {
    assert.equal(wrap("abcdefghij", 4), "abcd\nefgh\nij");
    assert.equal(wrap("abcdefg hi", 4), "abcd\nefg\nhi");
    assert.equal(wrap("hi abcdefgh", 4), "hi\nabcd\nefgh");
});

test("the last piece of a broken word stays open for the next word", () => {
    assert.equal(wrap("abcdef g", 4), "abcd\nef g");
});

test("keeps line breaks and blank lines", () => {
    assert.equal(wrap("one two\nthree four five", 9), "one two\nthree\nfour five");
    assert.equal(wrap("a\n\nb", 5), "a\n\nb");
    assert.equal(wrap("a\n\n\nb", 5), "a\n\n\nb");
});

test("collapses whitespace, tabs included", () => {
    assert.equal(wrap("a   b\tc", 10), "a b c");
    assert.equal(wrap("a \t  b", 3), "a b");
});

test("no leading or trailing whitespace", () => {
    assert.equal(wrap("  hi  ", 5), "hi");
    assert.equal(wrap("hello world", 11), "hello world");
    assert.equal(wrap("hello world  \n  next", 20), "hello world\nnext");
});

test("empty input", () => {
    assert.equal(wrap("", 5), "");
    assert.equal(wrap("   ", 5), "");
});

test("width must be a positive integer", () => {
    for (const bad of [0, -1, 2.5, "5", NaN, undefined]) assert.throws(() => wrap("text", bad), RangeError, String(bad));
});

test("width 1 puts one character per line", () => {
    assert.equal(wrap("abc d", 1), "a\nb\nc\nd");
});
