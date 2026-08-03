import assert from "node:assert/strict";
import { test } from "node:test";
import {
    ExternalImportJsonStreamError,
    JsonArrayStreamParser,
} from "../lib/externalImportJsonStream.ts";

// docs/policy/external-conversation-import-and-memory.md §5.1. The parser
// exists so a 250MB conversations.json never becomes one string plus one
// object graph in a browser tab.

const parseAll = (chunks, options) => {
    const parser = new JsonArrayStreamParser(options);
    const items = [];
    for (const chunk of chunks) items.push(...parser.push(chunk));
    parser.end();
    return items;
};

test("items are emitted across arbitrary chunk boundaries", () => {
    const source = JSON.stringify([
        { id: 1, title: "first" },
        { id: 2, title: "second" },
        { id: 3, title: "third" },
    ]);
    // Every possible split point must produce the same three items.
    for (let split = 0; split <= source.length; split += 1) {
        const items = parseAll([source.slice(0, split), source.slice(split)]);
        assert.equal(items.length, 3);
        assert.deepEqual(
            items.map((item) => item.id),
            [1, 2, 3]
        );
    }
});

test("one character at a time parses identically", () => {
    const source = JSON.stringify([{ a: [1, 2, { b: "c" }] }, { d: null }]);
    const items = parseAll([...source]);
    assert.deepEqual(items, [{ a: [1, 2, { b: "c" }] }, { d: null }]);
});

test("braces and brackets inside strings do not shift nesting", () => {
    const tricky = {
        text: 'a } b ] c { d [ e "quoted" f',
        escaped: 'back\\slash and \\" quote',
    };
    const items = parseAll([JSON.stringify([tricky, { after: true }])]);
    assert.deepEqual(items, [tricky, { after: true }]);
});

test("an escaped backslash before a quote still closes the string", () => {
    // "...\\" ends the string; a naive escape tracker reads it as an escaped
    // quote and swallows the rest of the file.
    const value = { path: "C:\\\\" };
    const items = parseAll([JSON.stringify([value, { next: 1 }])]);
    assert.deepEqual(items, [value, { next: 1 }]);
});

test("whitespace, empty arrays and nested empties are handled", () => {
    assert.deepEqual(parseAll(["  [ ]  "]), []);
    assert.deepEqual(parseAll(["[\n  {},\n  [],\n  {\"a\":{}}\n]"]), [
        {},
        [],
        { a: {} },
    ]);
});

test("scalar items are supported", () => {
    assert.deepEqual(parseAll(['[1, "two", true, null]']), [
        1,
        "two",
        true,
        null,
    ]);
});

test("Korean and emoji content survives chunking mid-value", () => {
    const source = JSON.stringify([{ text: "안녕하세요 👍 반갑습니다" }]);
    const half = Math.floor(source.length / 2);
    const items = parseAll([source.slice(0, half), source.slice(half)]);
    assert.equal(items[0].text, "안녕하세요 👍 반갑습니다");
});

test("a non-array top level is refused immediately", () => {
    assert.throws(
        () => parseAll(['{"conversations": []}']),
        (error) =>
            error instanceof ExternalImportJsonStreamError &&
            error.reason === "not_an_array"
    );
});

test("a truncated file is refused rather than silently short", () => {
    assert.throws(
        () => parseAll(['[{"id":1},{"id":2}']),
        (error) =>
            error instanceof ExternalImportJsonStreamError &&
            error.reason === "truncated"
    );
});

test("content after the array is refused", () => {
    assert.throws(
        () => parseAll(["[1] garbage"]),
        (error) =>
            error instanceof ExternalImportJsonStreamError &&
            error.reason === "trailing_content"
    );
});

test("an oversized single item is refused instead of buffered", () => {
    // Without this cap a file with no closing bracket would be accumulated in
    // full — the exact failure the streaming parser exists to avoid.
    assert.throws(
        () => parseAll([`[{"text":"${"x".repeat(500)}"}]`], {
            maxItemCharacters: 100,
        }),
        (error) =>
            error instanceof ExternalImportJsonStreamError &&
            error.reason === "item_too_large"
    );
});

test("malformed item JSON surfaces as a parse error", () => {
    assert.throws(() => parseAll(['[{"a":,}]']), SyntaxError);
});

test("peak retained text is one item, not the whole file", () => {
    // 200 items of ~1KB each: after each item is emitted the parser must be
    // holding nothing, so a caller that drops items keeps memory flat.
    const items = Array.from({ length: 200 }, (_, index) => ({
        id: index,
        body: "y".repeat(1_000),
    }));
    const parser = new JsonArrayStreamParser({ maxItemCharacters: 4_000 });
    let emitted = 0;
    const source = JSON.stringify(items);
    for (let index = 0; index < source.length; index += 997) {
        emitted += parser.push(source.slice(index, index + 997)).length;
    }
    parser.end();
    assert.equal(emitted, 200);
});

test("a truncated scalar item is not emitted as a complete one", () => {
    // "[1" must fail: emitting the 1 would turn an interrupted download into
    // a silently partial import.
    assert.throws(
        () => parseAll(["[1"]),
        (error) =>
            error instanceof ExternalImportJsonStreamError &&
            error.reason === "truncated"
    );
});
