import assert from "node:assert/strict";
import test from "node:test";
import { runWebSearchBackendRequest, WEB_SEARCH_MAX_RESPONSE_BYTES } from "../lib/webSearchBackendAdapter.ts";
import { APP_MANAGED_SEARCH_LIMITS } from "../lib/webSearchBackends.ts";

const env = { BRAVE_SEARCH_API_KEY: "local-fixture-key", NODE_ENV: "test" };

test("caller cancellation consumes no hanging body after headers", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(new TextEncoder().encode('{"web":')); },
    cancel() { cancelled = true; },
  }));
  try {
    const pending = runWebSearchBackendRequest("brave", { query: "public question", signal: controller.signal }, env);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    assert.deepEqual(await pending, { ok: false, failure: "backend_timeout" });
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = originalFetch; }
});

test("the existing search deadline remains active through a stalled body", async (t) => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = runWebSearchBackendRequest("brave", { query: "public question" }, env);
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(APP_MANAGED_SEARCH_LIMITS.requestTimeoutMs);
    assert.deepEqual(await pending, { ok: false, failure: "backend_timeout" });
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = originalFetch; t.mock.timers.reset(); }
});

test("oversized streamed and declared bodies are cancelled before parsing", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const declared of [false, true]) {
      let cancelled = false;
      globalThis.fetch = async () => new Response(new ReadableStream({
        start(stream) { if (!declared) stream.enqueue(new Uint8Array(WEB_SEARCH_MAX_RESPONSE_BYTES + 1)); },
        cancel() { cancelled = true; },
      }), { headers: declared ? { "content-length": String(WEB_SEARCH_MAX_RESPONSE_BYTES + 1) } : {} });
      assert.deepEqual(await runWebSearchBackendRequest("brave", { query: "public question" }, env),
        { ok: false, failure: "backend_invalid_response" });
      assert.equal(cancelled, true);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("error bodies remain bounded and disclose only the fixed status", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("secret vendor message", { status: 429 });
    assert.deepEqual(await runWebSearchBackendRequest("brave", { query: "public question" }, env),
      { ok: false, failure: "backend_rate_limited" });
  } finally { globalThis.fetch = originalFetch; }
});

test("a remote cancellation handshake cannot defeat the byte ceiling", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(new Uint8Array(WEB_SEARCH_MAX_RESPONSE_BYTES + 1)); },
    cancel() { return new Promise(() => {}); },
  }));
  try {
    assert.deepEqual(await runWebSearchBackendRequest("brave", { query: "public question" }, env),
      { ok: false, failure: "backend_invalid_response" });
  } finally { globalThis.fetch = originalFetch; }
});

test("an already cancelled request dispatches nothing", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("must not dispatch"); };
  try {
    assert.deepEqual(await runWebSearchBackendRequest("brave", { query: "public question", signal: AbortSignal.abort() }, env),
      { ok: false, failure: "backend_timeout" });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});
