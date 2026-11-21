import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError, DEFAULT_ENDPOINT, resolveEndpoint } from "../src/config.js";

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

test("the coding API root is kept as given; anything else is refused", () => {
    assert.equal(resolveEndpoint({ endpoint: "https://tomverse.app/api/code/v1" }, noEnv).base, "https://tomverse.app/api/code/v1");
    for (const endpoint of ["https://tomverse.app", "https://tomverse.app/api", "https://tomverse.app/api/anthropic", "https://tomverse.app/api/code"]) {
        assert.throws(() => resolveEndpoint({ endpoint }, noEnv), (error: unknown) => error instanceof ConfigError && /\/api\/code\/v1/.test(error.message), endpoint);
    }
});
