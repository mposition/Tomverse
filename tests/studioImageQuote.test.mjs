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

test("a request answered by two tools hands over each result as it finishes and submits both quotes", async context => {
  const { createStudioImageRunner } = await import("../components/studio/studioGenerationClient.ts");
  const targets = [
    { modelId: "tool-a", model: "Tool A", credits: 20, pricingVersion: "a-1" },
    { modelId: "tool-b", model: "Tool B", credits: 26, pricingVersion: "b-1" },
  ];
  const twoToolQuote = { ...quote, modelId: "tool-a", pricingVersion: "a-1", credits: 46, quality: "medium", useCase: "transparent-png", targets };
  const group = statuses => Response.json({
    targets: [{ modelId: "tool-a", currentGenerationId: "gen-a" }, { modelId: "tool-b", currentGenerationId: "gen-b" }],
    generations: [{ generationId: "gen-a", status: statuses[0] }, { generationId: "gen-b", status: statuses[1] }],
  });
  const image = name => new Response(new Blob([name], { type: "image/png" }));
  const submitted = [];
  const run = async (statuses, onImage) => {
    context.mock.method(globalThis, "fetch", async (url, init) => {
      if (url === "/api/studio/images") { submitted.push(JSON.parse(init.body)); return Response.json({ groupId: "group-1" }); }
      if (url === "/api/images/groups/group-1") return group(statuses);
      return image(String(url).includes("gen-a") ? "a" : "b");
    });
    return createStudioImageRunner()({
      inputKey: "photo", prompt: "Remove the background from the photo.", size: "1024x1024", quote: twoToolQuote,
      onImage, signal: new AbortController().signal,
    });
  };

  const seen = [];
  const first = await run(["succeeded", "succeeded"], async ({ blob, modelId }) => { seen.push([modelId, await blob.text()]); });
  assert.deepEqual(seen, [["tool-a", "a"], ["tool-b", "b"]]);
  assert.equal(await first.text(), "a");
  assert.deepEqual(submitted[0].targets, targets.map(({ modelId, pricingVersion, credits }) => ({ modelId, pricingVersion, credits })));
  assert.deepEqual([submitted[0].modelId, submitted[0].credits], ["tool-a", 46]);

  // One tool failing leaves the other's result; both failing is a failure.
  seen.length = 0;
  const survivor = await run(["failed", "succeeded"], ({ modelId }) => { seen.push(modelId); });
  assert.deepEqual([seen, await survivor.text()], [["tool-b"], "b"]);
  await assert.rejects(run(["failed", "failed"], () => {}), error => error instanceof StudioGenerationError && error.status === 502);
});
