import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError, DEFAULT_ENDPOINT, endpointMoveNote, resolveEndpoint } from "../src/config.js";

const noEnv = { TOMVERSE_ENDPOINT: "" } as NodeJS.ProcessEnv;

test("the default endpoint is the coding API", () => {
    assert.equal(DEFAULT_ENDPOINT, "https://tomverse.app/api/code/v1");
    assert.deepEqual(resolveEndpoint({}, noEnv), {
        base: "https://tomverse.app/api/code/v1",
        origin: "https://tomverse.app",
        basePath: "/api/code/v1",
    });
});

test("an endpoint saved at the general API root is read as the coding API on the same server", () => {
    assert.equal(resolveEndpoint({ endpoint: "https://tomverse.app/api/v1" }, noEnv).base, "https://tomverse.app/api/code/v1");
    assert.equal(resolveEndpoint({ endpoint: "https://dev.tomverse.app/api/v1/" }, noEnv).base, "https://dev.tomverse.app/api/code/v1");
    assert.equal(
        resolveEndpoint({ endpoint: "http://127.0.0.1:3000/api/v1", allowInsecureLocalhost: true }, noEnv).basePath,
        "/api/code/v1"
    );
    // The environment variable is read the same way.
    assert.equal(resolveEndpoint({}, { TOMVERSE_ENDPOINT: "https://tomverse.app/api/v1" } as NodeJS.ProcessEnv).base, "https://tomverse.app/api/code/v1");
});

test("a moved endpoint says so in one line; one already on the coding API says nothing", () => {
    const moved = resolveEndpoint({ endpoint: "https://tomverse.app/api/v1" }, noEnv);
    assert.equal(moved.movedFrom, "https://tomverse.app/api/v1");
    assert.match(endpointMoveNote(moved) ?? "", /general API.*coding API https:\/\/tomverse\.app\/api\/code\/v1/);
    assert.match(endpointMoveNote(moved) ?? "", /tomverse config set endpoint https:\/\/tomverse\.app\/api\/code\/v1/);
    assert.equal(endpointMoveNote(resolveEndpoint({ endpoint: "https://tomverse.app/api/code/v1" }, noEnv)), null);
    assert.equal(endpointMoveNote(resolveEndpoint({}, noEnv)), null);
    // From TOMVERSE_ENDPOINT, saving the config would not help: the note names the variable.
    const fromEnv = endpointMoveNote(resolveEndpoint({}, { TOMVERSE_ENDPOINT: "https://tomverse.app/api/v1" } as NodeJS.ProcessEnv)) ?? "";
    assert.match(fromEnv, /^TOMVERSE_ENDPOINT is https:\/\/tomverse\.app\/api\/v1/);
    assert.match(fromEnv, /set TOMVERSE_ENDPOINT=https:\/\/tomverse\.app\/api\/code\/v1/);
    assert.doesNotMatch(fromEnv, /config set endpoint/);
});

test("the coding API root is kept as given; anything else is refused", () => {
    assert.equal(resolveEndpoint({ endpoint: "https://tomverse.app/api/code/v1" }, noEnv).base, "https://tomverse.app/api/code/v1");
    for (const endpoint of ["https://tomverse.app", "https://tomverse.app/api", "https://tomverse.app/api/anthropic", "https://tomverse.app/api/code"]) {
        assert.throws(() => resolveEndpoint({ endpoint }, noEnv), (error: unknown) => error instanceof ConfigError && /\/api\/code\/v1/.test(error.message), endpoint);
    }
});
