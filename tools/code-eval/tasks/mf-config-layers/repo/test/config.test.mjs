import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, DEFAULTS, createConfig } from "../src/index.js";

test("defaults and file", () => {
    const config = createConfig({ fileText: '{"server":{"port":8080},"tags":["a"]}' });
    assert.equal(config.get("server.port"), 8080);
    assert.equal(config.get("server.host"), "127.0.0.1");
    assert.deepEqual(config.get("tags"), ["a"]);
    assert.equal(config.get("nope", "dflt"), "dflt");
    assert.equal(config.get("debug"), false);
});

test("bad files", () => {
    assert.throws(() => createConfig({ fileText: "{" }), ConfigError);
    assert.throws(() => createConfig({ fileText: "[]" }), ConfigError);
    assert.equal(createConfig({ fileText: "  " }).get("server.port"), 3000);
});

test("defaults are not modified", () => {
    const config = createConfig({ fileText: '{"db":{"pool":{"max":50}}}' });
    config.value.db.pool.max = 99;
    assert.equal(DEFAULTS.db.pool.max, 5);
});
