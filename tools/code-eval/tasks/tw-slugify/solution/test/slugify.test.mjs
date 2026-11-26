import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/index.js";

test("lower-cases and joins words with a dash", () => {
    assert.equal(slugify("Hello, World!"), "hello-world");
    assert.equal(slugify("ALL CAPS"), "all-caps");
});

test("removes accents", () => {
    assert.equal(slugify("Crème Brûlée à l'été"), "creme-brulee-a-l-ete");
    assert.equal(slugify("Über Ärger"), "uber-arger");
});

test("keeps digits", () => {
    assert.equal(slugify("Top 10 tips for 2024"), "top-10-tips-for-2024");
    assert.equal(slugify(123), "123");
});

test("collapses runs of other characters and trims the ends", () => {
    assert.equal(slugify("  --Hello   ___ world--  "), "hello-world");
    assert.equal(slugify("a!!!b???c"), "a-b-c");
    assert.equal(slugify("!!!"), "");
    assert.equal(slugify(""), "");
});

test("custom separator", () => {
    assert.equal(slugify("Hello World again", { separator: "_" }), "hello_world_again");
    assert.equal(slugify("a b", { separator: "--" }), "a--b");
});

test("cuts to exactly maxLength", () => {
    assert.equal(slugify("abcdefghij", { maxLength: 5 }), "abcde");
    assert.equal(slugify("abcde", { maxLength: 5 }), "abcde");
    assert.equal(slugify("abcdef", { maxLength: 5 }).length, 5);
});

test("separators left at the end by the cut are removed", () => {
    assert.equal(slugify("aaaa bbbb", { maxLength: 5 }), "aaaa");
    assert.equal(slugify("aa__bb", { maxLength: 4, separator: "__" }), "aa");
});

test("the default maximum is 80", () => {
    const slug = slugify("word ".repeat(40));
    assert.equal(slug.length, 79);
    assert.ok(slug.endsWith("word"));
    assert.equal(slugify("x".repeat(100)).length, 80);
});

test("invalid options throw RangeError", () => {
    for (const maxLength of [0, -3, 1.5, "10", NaN]) assert.throws(() => slugify("abc", { maxLength }), RangeError, String(maxLength));
    for (const separator of ["", 5, null]) assert.throws(() => slugify("abc", { separator }), RangeError, String(separator));
});
