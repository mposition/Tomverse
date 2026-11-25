import assert from "node:assert/strict";
import test from "node:test";
import { resolveEndpoint } from "../src/config.js";
import { Gateway, type GenerationHooks } from "../src/gateway.js";
import { TEST_KEY } from "./fakeGateway.js";

test("the Code gateway checks continuation support and sends the approved ceiling on every generation", async () => {
    const endpoint = resolveEndpoint({}, {});
    const usedCaps: unknown[] = [];
    const efforts: unknown[] = [];
    let capability = "";
    let cap: number | null = 40;
    let remaining = 32;
    const transport: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.origin, endpoint.origin);
        assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TEST_KEY}`);
        assert.equal(init?.redirect, "manual");
        if (url.pathname.endsWith("/usage")) {
            assert.equal(init?.method, "GET");
            return Response.json({ key: { prefix: TEST_KEY.slice(0, 12), credit_cap: cap, remaining_cap_credits: remaining } }, {
                headers: { "x-tomverse-code-capped-continuation": capability },
            });
        }
        assert.equal(url.pathname, endpoint.basePath + "/chat/completions");
        const request = JSON.parse(String(init?.body));
        usedCaps.push(request.tomverse_max_key_credit_cap);
        efforts.push(request.tomverse_effort);
        return new Response(null);
    };
    const gateway = new Gateway(endpoint, TEST_KEY, transport, "desktop-test", 50);
    const signal = new AbortController().signal;
    await assert.rejects(gateway.verifyCappedContinuation(signal), /has not enabled/);
    capability = "key-cap-v2";
    await assert.rejects(gateway.verifyCappedContinuation(signal), /has not enabled/);
    capability = "key-cap-v1";
    assert.deepEqual(await gateway.verifyCappedContinuation(signal), { cap, remaining });
    cap = null;
    await assert.rejects(gateway.verifyCappedContinuation(signal), /needs available credits/);
    cap = 51;
    await assert.rejects(gateway.verifyCappedContinuation(signal), /needs available credits/);
    cap = 50;
    remaining = 0;
    await assert.rejects(gateway.verifyCappedContinuation(signal), /needs available credits/);
    assert.deepEqual(usedCaps, [], "the preflight sends no generation");

    let intents = 0;
    const hooks: GenerationHooks = {
        before: async () => ({ idempotencyKey: String(++intents) }),
        headers: async () => undefined,
        failed: async (_intent, error) => { throw error; },
        ended: async () => undefined,
    };
    cap = 40;
    remaining = 32;
    await gateway.verifyCappedContinuation(signal);
    const generation = { method: "POST", body: JSON.stringify({ model: "fixed-model" }) };
    await gateway.generationFetch(hooks, "default")(gateway.url("/chat/completions"), generation);
    await gateway.generationFetch(hooks, "high")(gateway.url("/chat/completions"), generation);
    await new Gateway(endpoint, TEST_KEY, transport).generationFetch(hooks)(gateway.url("/chat/completions"), generation);
    assert.deepEqual(usedCaps, [50, 50, undefined]);
    assert.deepEqual(efforts, [undefined, "high", undefined]);
    assert.equal(intents, 3);
});
