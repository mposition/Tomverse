import { test } from "node:test";
import assert from "node:assert/strict";
import { Router } from "../src/index.js";

test("matches static routes and ignores slashes and query strings", () => {
    const router = new Router();
    const handler = () => "ok";
    router.add("get", "/health", handler);
    assert.equal(router.match("GET", "//health/?x=1").handler, handler);
    assert.equal(router.match("POST", "/health"), null);
    assert.equal(router.match("GET", "/other"), null);
});
