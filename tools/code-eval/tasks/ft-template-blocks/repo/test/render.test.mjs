import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "../src/index.js";

test("substitutes and escapes", () => {
    assert.equal(render("Hi {{user.name}}!", { user: { name: "<b>Ann</b>" } }), "Hi &lt;b&gt;Ann&lt;/b&gt;!");
});

test("raw output is not escaped", () => {
    assert.equal(render("{{{html}}}", { html: "<i>x</i>" }), "<i>x</i>");
});

test("missing values are empty", () => {
    assert.equal(render("[{{nothing.here}}]", {}), "[]");
});
