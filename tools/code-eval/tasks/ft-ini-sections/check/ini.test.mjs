import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, stringify } from "../src/index.js";

test("sections and dotted sections", () => {
    const text = "top = 1\n[server]\nhost = example.org\n[server.tls]\nenabled = true\n[server]\nport = 8080\n";
    assert.deepEqual(parse(text), { top: 1, server: { host: "example.org", port: 8080, tls: { enabled: true } } });
});

test("typed values", () => {
    const text = "a = true\nb = false\nc = True\nd = -12\ne = 3.5\nf = 1.\ng = hello world\nh =\ni = 007";
    assert.deepEqual(parse(text), { a: true, b: false, c: "True", d: -12, e: 3.5, f: "1.", g: "hello world", h: "", i: 7 });
});

test("inline comments need whitespace before the marker", () => {
    assert.deepEqual(parse("port = 80 ; http\nname = x # y\ncolor = #fff\nurl = a;b"), { port: 80, name: "x", color: "#fff", url: "a;b" });
});

test("quoted strings keep content and escapes", () => {
    const text = 'a = "true"\nb = " padded "\nc = "x ; y"\nd = "say \\"hi\\""\ne = "line\\nbreak"\nf = "back\\\\slash"\ng = "42"\nh = "q" ; trailing note';
    assert.deepEqual(parse(text), { a: "true", b: " padded ", c: "x ; y", d: 'say "hi"', e: "line\nbreak", f: "back\\slash", g: "42", h: "q" });
});

test("arrays", () => {
    assert.deepEqual(parse("tag[] = a\ntag[] = 2\nother = x\ntag[] = true\n[s]\nlist[] = z"), { tag: ["a", 2, true], other: "x", s: { list: ["z"] } });
});

test("flat parsing is unchanged", () => {
    assert.deepEqual(parse("; c\nname = Ann\n\n# d\nmode=fast"), { name: "Ann", mode: "fast" });
});

test("stringify layout", () => {
    const text = stringify({ name: "x", n: 5, on: true, list: ["a", 1], server: { host: "h", tls: { on: false } }, gone: null });
    assert.equal(text, "name = x\nn = 5\non = true\nlist[] = a\nlist[] = 1\n[server]\nhost = h\n[server.tls]\non = false\n");
});

test("stringify quotes strings that would not read back", () => {
    const text = stringify({ a: "", b: " x ", c: "true", d: "12", e: 'q"q', f: "a ; b", g: "#top", h: "[x]", i: "plain text", j: "a\nb", k: "back\\slash", l: "color#fff" });
    assert.equal(
        text,
        'a = ""\nb = " x "\nc = "true"\nd = "12"\ne = "q\\"q"\nf = "a ; b"\ng = "#top"\nh = "[x]"\ni = plain text\nj = "a\\nb"\nk = "back\\\\slash"\nl = color#fff\n',
    );
});

test("parse(stringify(x)) equals x", () => {
    const value = {
        title: "A ; B",
        count: 3,
        ratio: 0.25,
        flag: false,
        empty: "",
        numeric: "123",
        tags: ["x", "1", 2, true, " y "],
        db: { host: "localhost", port: 5432, opts: { ssl: true, note: 'He said "go"\nnow' }, users: ["a", "b"] },
    };
    assert.deepEqual(parse(stringify(value)), value);
});

test("an empty object is an empty document", () => {
    assert.equal(stringify({}), "");
    assert.deepEqual(parse(""), {});
});
