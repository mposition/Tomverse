import { test } from "node:test";
import assert from "node:assert/strict";
import { Router } from "../src/index.js";

const h = (name) => () => name;

test("parameters are captured and decoded", () => {
    const router = new Router().add("GET", "/users/:id/posts/:post", h("p"));
    const m = router.match("GET", "/users/a%20b/posts/7");
    assert.deepEqual(m.params, { id: "a b", post: "7" });
    assert.equal(router.match("GET", "/users/1/posts"), null);
    assert.equal(router.match("GET", "/users/1/posts/2/extra"), null);
});

test("a malformed escape does not match", () => {
    const router = new Router().add("GET", "/f/:name", h("f"));
    assert.equal(router.match("GET", "/f/%E0%A4%A"), null);
});

test("wildcard takes the rest of the path, still encoded", () => {
    const router = new Router().add("GET", "/files/*", h("w"));
    assert.deepEqual(router.match("GET", "/files/a/b%20c.txt").params, { "*": "a/b%20c.txt" });
    assert.equal(router.match("GET", "/files"), null);
});

test("static beats parameter beats wildcard, whatever the order", () => {
    const router = new Router()
        .add("GET", "/a/*", h("wild"))
        .add("GET", "/a/:x", h("param"))
        .add("GET", "/a/b", h("static"));
    assert.equal(router.match("GET", "/a/b").handler(), "static");
    assert.equal(router.match("GET", "/a/c").handler(), "param");
    assert.equal(router.match("GET", "/a/c/d").handler(), "wild");
});

test("specificity is compared from the left", () => {
    const router = new Router().add("GET", "/:x/b", h("param-first")).add("GET", "/a/:y", h("static-first"));
    assert.equal(router.match("GET", "/a/b").handler(), "static-first");
});

test("exact ties go to the first registered route", () => {
    const router = new Router().add("GET", "/t/:a", h("first")).add("GET", "/t/:b", h("second"));
    assert.equal(router.match("GET", "/t/1").handler(), "first");
    assert.deepEqual(router.match("GET", "/t/1").params, { a: "1" });
});

test("ANY routes match every method but lose to an exact method", () => {
    const router = new Router().add("ANY", "/x", h("any")).add("post", "/x", h("post"));
    assert.equal(router.match("GET", "/x").handler(), "any");
    assert.equal(router.match("POST", "/x").handler(), "post");
});

test("query parsing", () => {
    const router = new Router().add("GET", "/s", h("s"));
    assert.deepEqual(router.match("GET", "/s").query, {});
    assert.deepEqual(router.match("GET", "/s?q=a+b&tag=x&tag=y&flag&e=%C3%A9#top").query, { q: "a b", tag: ["x", "y"], flag: "", e: "é" });
});

test("allowedMethods", () => {
    const router = new Router().add("post", "/u/:id", h("a")).add("GET", "/u/42", h("b")).add("ANY", "/other", h("c"));
    assert.deepEqual(router.allowedMethods("/u/42"), ["GET", "POST"]);
    assert.deepEqual(router.allowedMethods("/other"), ["ANY"]);
    assert.deepEqual(router.allowedMethods("/nothing"), []);
});

test("static routing is unchanged", () => {
    const router = new Router().add("get", "/health", h("ok"));
    assert.equal(router.match("GET", "//health/?x=1").handler(), "ok");
    assert.equal(router.match("POST", "/health"), null);
});
