import assert from "node:assert/strict";
import test from "node:test";
import { loadStudioImageQuote, StudioGenerationError } from "../components/studio/studioGenerationClient.ts";

const quote = { modelId: "square-image-model", model: "Square image model", credits: 85, pricingVersion: "test-price" };
const unavailable = () => Response.json({ code: "STUDIO_GENERATION_UNAVAILABLE" }, { status: 503 });

test("a Studio image quote keeps the preferred size when it is available", async context => {
  const fetch = context.mock.method(globalThis, "fetch", async () => Response.json(quote));
  const result = await loadStudioImageQuote("1536x1024", true, new AbortController().signal, "1024x1024");

  assert.deepEqual(result, { ...quote, size: "1536x1024" });
  assert.equal(fetch.mock.callCount(), 1);
});

test("a Studio sticker pack can use a square edit quote when landscape is unavailable", async context => {
  const signal = new AbortController().signal;
  const preferred = unavailable();
  const fallback = Response.json(quote);
  const responses = [preferred, fallback];
  const fetch = context.mock.method(globalThis, "fetch", async () => responses.shift());

  const result = await loadStudioImageQuote("1536x1024", true, signal, "1024x1024");

  assert.deepEqual(result, { ...quote, size: "1024x1024" });
  assert.deepEqual(fetch.mock.calls.map(call => call.arguments), [
    ["/api/studio/images?size=1536x1024&edit=true", { signal, cache: "no-store" }],
    ["/api/studio/images?size=1024x1024&edit=true", { signal, cache: "no-store" }],
  ]);
  assert.ok(preferred.bodyUsed && fallback.bodyUsed);
});

test("Studio does not attempt a fallback after an authentication failure", async context => {
  const fetch = context.mock.method(globalThis, "fetch", async () => Response.json({ code: "AUTH_REQUIRED" }, { status: 401 }));
  await assert.rejects(
    loadStudioImageQuote("1536x1024", true, new AbortController().signal, "1024x1024"),
    error => error instanceof StudioGenerationError && error.status === 401,
  );
  assert.equal(fetch.mock.callCount(), 1);
});
