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

test("each tool of a several-tool feature is submitted with its own price, never the total", async () => {
  const { studioToolQuote } = await import("../components/studio/studioGenerationClient.ts");
  const targets = [
    { modelId: "tool-a", model: "Tool A", credits: 20, pricingVersion: "a-1" },
    { modelId: "tool-b", model: "Tool B", credits: 26, pricingVersion: "b-1" },
  ];
  const total = { ...quote, modelId: "tool-a", pricingVersion: "a-1", credits: 46, quality: "medium", useCase: "transparent-png", size: "1024x1024", targets };
  assert.deepEqual(studioToolQuote(total, targets[1]), {
    ...total, modelId: "tool-b", model: "Tool B", credits: 26, pricingVersion: "b-1", targets: undefined,
  });
  assert.equal(studioToolQuote(total, targets[0]).credits, 20);
});

test("a tool sent after another waits out a busy slot twice, and nothing else", async () => {
  const { runStudioTool } = await import("../components/studio/studioGenerationClient.ts");
  const signal = new AbortController().signal;
  const busy = () => new StudioGenerationError(429, "IMAGE_CONCURRENCY_EXCEEDED");
  let calls = 0;
  const flaky = failures => async () => { calls++; if (calls <= failures) throw busy(); return "cut-out"; };
  assert.equal(await runStudioTool(flaky(2), signal, 0), "cut-out");
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(runStudioTool(flaky(3), signal, 0), error => error.status === 429);
  assert.equal(calls, 3);
  // A rate limit, a credit shortfall or a changed quote is not a busy slot: one attempt.
  for (const error of [new StudioGenerationError(429, "RATE_LIMITED"), new StudioGenerationError(402, "CREDITS_REQUIRED"), new StudioGenerationError(409, "STUDIO_QUOTE_CHANGED")]) {
    calls = 0;
    await assert.rejects(runStudioTool(async () => { calls++; throw error; }, signal, 0), thrown => thrown === error);
    assert.equal(calls, 1);
  }
});

test("a press requests only what is owed, and every tool only when all are held and on screen", async () => {
  const { studioToolsToRequest, studioToolFailure } = await import("../components/studio/studioGenerationClient.ts");
  const targets = [{ modelId: "tool-a" }, { modelId: "tool-b" }];
  const ids = (held, shown = held) => studioToolsToRequest(targets, id => held.includes(id), id => shown.includes(id)).map(target => target.modelId);
  assert.deepEqual(ids([]), ["tool-a", "tool-b"]);
  // The paid result is never requested again while the other is still owed.
  assert.deepEqual(ids(["tool-a"]), ["tool-b"]);
  assert.deepEqual(ids(["tool-b"]), ["tool-a"]);
  // Both held and both on screen: the press means make them again.
  assert.deepEqual(ids(["tool-a", "tool-b"]), ["tool-a", "tool-b"]);
  // Both returned but one never reached the screen (its cropping failed, or a draft was restored): nothing is bought.
  assert.deepEqual(ids(["tool-a", "tool-b"], ["tool-a"]), []);
  assert.deepEqual(ids(["tool-a", "tool-b"], []), []);

  // The failure that decides: a shortfall from either tool, then a changed quote, then the first.
  const plain = new StudioGenerationError(502), shortfall = new StudioGenerationError(402, "CREDITS_REQUIRED"), changed = new StudioGenerationError(409);
  const isShortfall = error => error === shortfall;
  assert.equal(studioToolFailure([plain, shortfall], isShortfall), shortfall);
  assert.equal(studioToolFailure([changed, shortfall], isShortfall), shortfall);
  assert.equal(studioToolFailure([plain, changed], isShortfall), changed);
  assert.equal(studioToolFailure([plain, new Error("crop")], isShortfall), plain);
});
