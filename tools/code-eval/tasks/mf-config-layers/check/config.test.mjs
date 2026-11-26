import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, DEFAULTS, createConfig, fromArgs, fromEnv } from "../src/index.js";

test("fromEnv nests, lower-cases and converts values", () => {
    const env = {
        APP_SERVER__PORT: "8080",
        APP_DEBUG: "true",
        APP_DB__POOL__MAX: "20",
        APP_RATIO: "-1.5",
        APP_TAGS: 'json:["a","b"]',
        APP_NAME: "my app",
        APP_EMPTY: "",
        APP_VERSION: "1.2.3",
        OTHER_THING: "ignored",
        PATH: "/bin",
    };
    assert.deepEqual(fromEnv(env), {
        server: { port: 8080 },
        debug: true,
        db: { pool: { max: 20 } },
        ratio: -1.5,
        tags: ["a", "b"],
        name: "my app",
        empty: "",
        version: "1.2.3",
    });
});

test("fromEnv with another prefix and bad JSON", () => {
    assert.deepEqual(fromEnv({ MY_A: "1", APP_A: "2" }, "MY_"), { a: 1 });
    assert.throws(() => fromEnv({ APP_X: "json:{oops" }), (e) => e instanceof ConfigError && e.message === "invalid JSON in APP_X");
});

test("fromArgs", () => {
    assert.deepEqual(fromArgs(["--server.port=9090", "--no-debug", "--db.pool.min=2", "build", "-x", "--verbose", "--name=a=b", "--tags=json:[1,2]", "--ratio=0.5"]), {
        server: { port: 9090 },
        debug: false,
        db: { pool: { min: 2 } },
        verbose: true,
        name: "a=b",
        tags: [1, 2],
        ratio: 0.5,
    });
    assert.deepEqual(fromArgs(["--flag", "--empty="]), { flag: true, empty: "" });
    assert.deepEqual(fromArgs([]), {});
    assert.throws(() => fromArgs(["--x=json:nope"]), ConfigError);
});

test("precedence: defaults < file < env < cli", () => {
    const config = createConfig({
        fileText: '{"server":{"port":8000,"host":"file-host"},"debug":true,"db":{"url":"file-db"}}',
        env: { APP_SERVER__PORT: "9000", APP_DB__URL: "env-db" },
        argv: ["--server.port=9999", "--no-debug"],
    });
    assert.equal(config.get("server.port"), 9999);
    assert.equal(config.get("server.host"), "file-host");
    assert.equal(config.get("debug"), false);
    assert.equal(config.get("db.url"), "env-db");
    assert.equal(config.get("db.pool.max"), 5);
});

test("env beats the file but not the command line", () => {
    const config = createConfig({ fileText: '{"server":{"port":1}}', env: { APP_SERVER__PORT: "2" } });
    assert.equal(config.get("server.port"), 2);
    assert.equal(createConfig({ fileText: '{"server":{"port":1}}', env: { APP_SERVER__PORT: "2" }, argv: ["--server.port=3"] }).get("server.port"), 3);
});

test("arrays are replaced, not merged; other types replace objects", () => {
    const config = createConfig({ fileText: '{"tags":["a","b"]}', env: { APP_TAGS: 'json:["z"]', APP_DB: "none" } });
    assert.deepEqual(config.get("tags"), ["z"]);
    assert.equal(config.get("db"), "none");
    assert.equal(config.get("db.pool.max", "gone"), "gone");
});

test("get returns real falsy values and the fallback only for unset paths", () => {
    const config = createConfig({ argv: ["--zero=0", "--off=false", "--blank="] });
    assert.equal(config.get("zero", 5), 0);
    assert.equal(config.get("off", true), false);
    assert.equal(config.get("blank", "x"), "");
    assert.equal(config.get("unset", "x"), "x");
});

test("explain names the winning layer", () => {
    const config = createConfig({
        fileText: '{"server":{"host":"h"},"extra":1}',
        env: { APP_SERVER__PORT: "9000", APP_EXTRA: "2" },
        argv: ["--extra=3"],
    });
    assert.deepEqual(config.explain("server.host"), { value: "h", source: "file" });
    assert.deepEqual(config.explain("server.port"), { value: 9000, source: "env" });
    assert.deepEqual(config.explain("extra"), { value: 3, source: "cli" });
    assert.deepEqual(config.explain("db.pool.max"), { value: 5, source: "default" });
    assert.deepEqual(config.explain("server"), { value: { host: "h", port: 9000 }, source: "env" });
    assert.deepEqual(config.explain("nope.at.all"), { value: undefined, source: null });
});

test("inputs are never modified", () => {
    const env = { APP_DB__POOL__MAX: "50" };
    const config = createConfig({ env, argv: ["--db.pool.min=7"] });
    config.value.db.pool.max = 1;
    config.value.tags.push("x");
    assert.equal(DEFAULTS.db.pool.max, 5);
    assert.equal(DEFAULTS.db.pool.min, 1);
    assert.deepEqual(DEFAULTS.tags, []);
    assert.deepEqual(env, { APP_DB__POOL__MAX: "50" });
    assert.equal(createConfig({}).get("db.pool.max"), 5);
});

test("file errors still throw ConfigError", () => {
    assert.throws(() => createConfig({ fileText: "{", env: {} }), ConfigError);
    assert.throws(() => createConfig({ fileText: "[1]" }), ConfigError);
});
