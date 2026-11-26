import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "../src/index.js";

test("each repeats the body and falls back to outer data", () => {
    const out = render("{{#each people}}{{name}} of {{team}}; {{/each}}", { team: "T", people: [{ name: "A" }, { name: "B" }] });
    assert.equal(out, "A of T; B of T; ");
});

test("this and @index", () => {
    assert.equal(render("{{#each xs}}{{@index}}={{this}} {{/each}}", { xs: ["a", "b", "c"] }), "0=a 1=b 2=c ");
});

test("each over a missing value or a non-array renders nothing", () => {
    assert.equal(render("[{{#each nope}}x{{/each}}]", {}), "[]");
    assert.equal(render("[{{#each s}}x{{/each}}]", { s: "text" }), "[]");
});

test("if and else", () => {
    const t = "{{#if admin}}A{{else}}U{{/if}}";
    assert.equal(render(t, { admin: true }), "A");
    assert.equal(render(t, { admin: false }), "U");
    assert.equal(render("{{#if x}}shown{{/if}}", { x: 1 }), "shown");
    assert.equal(render("{{#if x}}shown{{/if}}", {}), "");
});

test("falsy values", () => {
    for (const value of [false, null, 0, "", []]) {
        assert.equal(render("{{#if v}}yes{{else}}no{{/if}}", { v: value }), "no", JSON.stringify(value));
    }
    assert.equal(render("{{#if v}}yes{{else}}no{{/if}}", { v: [0] }), "yes");
    assert.equal(render("{{#if v.deep}}yes{{else}}no{{/if}}", { v: { deep: "x" } }), "yes");
});

test("nesting: if inside each, each inside each", () => {
    const out = render("{{#each items}}{{#if done}}[x]{{else}}[ ]{{/if}}{{title}} {{/each}}", {
        items: [{ done: true, title: "a" }, { done: false, title: "b" }],
    });
    assert.equal(out, "[x]a [ ]b ");
    const grid = render("{{#each rows}}{{#each this}}{{this}}{{/each}}/{{/each}}", { rows: [[1, 2], [3]] });
    assert.equal(grid, "12/3/");
    const idx = render("{{#each a}}{{#each b}}{{@index}}{{/each}}-{{@index}};{{/each}}", { a: [1, 2], b: ["x", "y"] });
    assert.equal(idx, "01-0;01-1;");
});

test("escaping still applies inside blocks", () => {
    assert.equal(render("{{#each xs}}{{this}}|{{{this}}}{{/each}}", { xs: ["<"] }), "&lt;|<");
});

test("unbalanced blocks throw", () => {
    assert.throws(() => render("{{#each a}}x", { a: [] }), /unclosed/i);
    assert.throws(() => render("{{#if a}}x", {}), /unclosed/i);
    assert.throws(() => render("x{{/each}}", {}), /unexpected/i);
    assert.throws(() => render("{{#each a}}x{{/if}}", { a: [] }), /unexpected/i);
});

test("plain templates still work", () => {
    assert.equal(render("Hi {{user.name}}!", { user: { name: "<b>" } }), "Hi &lt;b&gt;!");
    assert.equal(render("{{{h}}}", { h: "<i>" }), "<i>");
});
