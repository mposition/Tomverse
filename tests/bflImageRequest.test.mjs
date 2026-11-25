import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import {
  BFL_API_KEY_HEADER,
  bflSubmitUrl,
  buildBflImageRequest,
  isBflFlux3ImageModel,
  isBflUrl,
  parseBflPollResponse,
  parseBflSubmitResponse,
} from "../lib/bflImageRequest.ts";
import { generateImageWithProvider } from "../lib/imageProviderAdapter.ts";
import { OFFICIAL_SOURCE_HOSTS, isOfficialSourceUrl } from "../lib/modelCatalogCore.ts";
import { isConnectedProvider } from "../lib/modelDiscoveryNewProviderResearchCore.ts";
import {
  RUNTIME_IMAGE_PROVIDERS,
  runtimeImageProfileTemplate,
  runtimeImageProviderFor,
} from "../lib/runtimeImageProviders.ts";

// Required, not imported: the adapter reaches the registry through tsx's
// CommonJS loader, and an ESM import is a second instance whose active
// catalogue the adapter never sees (tests/imageProviderAdapter.test.mjs).
const {
  IMAGE_MODEL_REGISTRY,
  imageThinkingBilling,
  imageThinkingCapMinimumMicroUsd,
  resetActiveImageModelCatalog,
  setActiveImageModelCatalog,
} = createRequire(import.meta.url)("../lib/imageModelRegistry.ts");

const POLLING_URL = "https://api.eu.bfl.ai/v1/get_result?id=task-1";
const SAMPLE_URL = "https://delivery-eu1.bfl.ai/results/ab/sample.jpeg?se=2026-11-16T04%3A10%3A00Z&sig=x";

/** A PNG header that says width x height: all readImageDimensions reads. */
const pngHeader = (width, height) => {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};

// A runtime catalogue row as the judge would admit it; prices are test figures.
const FLUX3_MODEL = {
  id: "flux-3-image",
  provider: "bfl",
  apiModelId: "flux-3-image",
  name: "FLUX 3 Image",
  lifecycle: "preview",
  disabledReason: null,
  sizes: ["1024x1024"],
  qualities: ["medium"],
  prices: [{ quality: "medium", size: "1024x1024", credits: 70, outputCostMicroUsd: 48_000 }],
  latencyClass: "balanced",
  provenance: [],
  outputMimeTypes: ["image/jpeg", "image/png"],
  pricingVersion: "bfl-flux-3-image-test-v1",
  priceVerification: {
    verifiedAt: "2026-11-16",
    sources: ["https://bfl.ai/pricing"],
    thinkingCapMicroUsd: 0,
  },
};

const withBfl = async (fake, run, { model = FLUX3_MODEL, key = "test-bfl-key" } = {}) => {
  const original = globalThis.fetch;
  const previous = process.env.BFL_API_KEY;
  globalThis.fetch = fake;
  if (key === null) delete process.env.BFL_API_KEY;
  else process.env.BFL_API_KEY = key;
  setActiveImageModelCatalog([model]);
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
    resetActiveImageModelCatalog();
    if (previous === undefined) delete process.env.BFL_API_KEY;
    else process.env.BFL_API_KEY = previous;
  }
};

const generate = (overrides = {}) =>
  generateImageWithProvider({
    prompt: "a single red apple",
    size: "1024x1024",
    quality: "medium",
    modelId: FLUX3_MODEL.id,
    ...overrides,
  });

const submitted = (overrides = {}) =>
  Response.json({ id: "task-1", polling_url: POLLING_URL, cost: 4.8, input_mp: 0, output_mp: 1.05, ...overrides });

const ready = (sample = SAMPLE_URL) =>
  Response.json({ id: "task-1", status: "Ready", result: { sample }, cost: 4.8 });

/**
 * Answers the submit with `submit`, each poll with the next entry of `polls`
 * (the last one repeats), and the download with `asset`.
 */
const fakeFetch = (calls, { submit = () => submitted(), polls = [() => ready()], asset } = {}) => {
  let poll = 0;
  return async (url, init) => {
    const href = String(url);
    calls.push({ url: href, init });
    let response;
    if (href === bflSubmitUrl("flux-3-image") || href === bflSubmitUrl("flux-3-image-klein")) {
      response = submit();
    } else if (href.startsWith("https://api.")) {
      response = polls[Math.min(poll, polls.length - 1)]();
      poll += 1;
    } else {
      response =
        asset?.(href) ??
        new Response(pngHeader(1024, 1024), { headers: { "content-type": "image/png", "content-length": "33" } });
    }
    Object.defineProperty(response, "url", { value: href });
    return response;
  };
};

test("the whole request body is pinned, and only the prompt is the user's", () => {
  assert.deepEqual(buildBflImageRequest({ apiModelId: "flux-3-image", prompt: "p", size: "1024x1024" }), {
    prompt: "p",
    aspect_ratio: "1:1",
    resolution: "1k",
    safety_tolerance: 2,
    // Its default sends the prompt to web and image search.
    grounding: false,
    version: "latest",
  });
  // Klein's schema has an output format and no grounding or version.
  assert.deepEqual(buildBflImageRequest({ apiModelId: "flux-3-image-klein", prompt: "p", size: "1024x1024" }), {
    prompt: "p",
    aspect_ratio: "1:1",
    resolution: "1k",
    safety_tolerance: 2,
    output_format: "png",
  });
});

test("an unpinned endpoint or size builds no request", () => {
  for (const apiModelId of ["flux-2-pro", "flux-kontext-pro", "../v1/flux-3-image", "flux-3-image?x=1", ""]) {
    assert.equal(isBflFlux3ImageModel(apiModelId), false, apiModelId);
    assert.equal(buildBflImageRequest({ apiModelId, prompt: "p", size: "1024x1024" }), null, apiModelId);
  }
  for (const size of ["1536x1024", "1024x1536"]) {
    assert.equal(buildBflImageRequest({ apiModelId: "flux-3-image", prompt: "p", size }), null, size);
  }
  assert.equal(bflSubmitUrl("flux-3-image"), "https://api.bfl.ai/v1/flux-3-image");
});

test("only https URLs on bfl.ai are followed", () => {
  for (const url of [POLLING_URL, "https://api.bfl.ai/v1/get_result?id=1", SAMPLE_URL]) {
    assert.equal(isBflUrl(url), true, url);
  }
  for (const url of [
    "http://api.bfl.ai/v1/get_result?id=1",
    "https://bfl.ai.evil.example/x",
    "https://evilbfl.ai/x",
    "https://api.bfl.ai:8443/v1/get_result",
    "https://user:pass@api.bfl.ai/v1/get_result",
    "https://169.254.169.254/latest",
    "not a url",
    42,
  ]) {
    assert.equal(isBflUrl(url), false, String(url));
  }
});

test("a submit answer is a task to poll on bfl.ai, with BFL's own cost kept", () => {
  assert.deepEqual(parseBflSubmitResponse({ id: "t", polling_url: POLLING_URL, cost: 4.8, output_mp: 1.05 }), {
    id: "t",
    pollingUrl: POLLING_URL,
    usage: { cost: 4.8, output_mp: 1.05 },
  });
  assert.equal(parseBflSubmitResponse({ id: "t", polling_url: "https://example.com/poll" }), null);
  assert.equal(parseBflSubmitResponse({ polling_url: POLLING_URL }), null);
  assert.equal(parseBflSubmitResponse(null), null);
});

test("poll statuses: working, moderated, ready, and everything else fails", () => {
  for (const status of ["Pending", "Reasoning", "Generating"]) {
    assert.deepEqual(parseBflPollResponse({ status }), { state: "pending" }, status);
  }
  for (const status of ["Request Moderated", "Content Moderated"]) {
    assert.deepEqual(parseBflPollResponse({ status }), { state: "moderated", status }, status);
  }
  assert.deepEqual(parseBflPollResponse({ status: "Ready", result: { sample: SAMPLE_URL }, cost: 4.8 }), {
    state: "ready",
    sampleUrl: SAMPLE_URL,
    usage: { settled_cost: 4.8 },
  });
  for (const payload of [
    { status: "Error" },
    { status: "Task not found" },
    { status: "No Card Generated" },
    { status: "Queued forever" },
    { status: "Ready", result: { sample: "https://example.com/x.png" } },
    { status: "Ready" },
    null,
  ]) {
    assert.equal(parseBflPollResponse(payload).state, "failed", JSON.stringify(payload));
  }
});

test("a generation is one keyed submit, keyed polls on bfl.ai, then an unkeyed download", async () => {
  const calls = [];
  const result = await withBfl(
    fakeFetch(calls, { polls: [() => Response.json({ id: "task-1", status: "Generating" }), () => ready()] }),
    () => generate()
  );
  assert.equal(calls.length, 4);
  const [submit, firstPoll, secondPoll, download] = calls;
  assert.equal(submit.url, "https://api.bfl.ai/v1/flux-3-image");
  assert.equal(submit.init.method, "POST");
  assert.equal(submit.init.headers[BFL_API_KEY_HEADER], "test-bfl-key");
  assert.equal(submit.init.redirect, "manual");
  assert.deepEqual(
    JSON.parse(submit.init.body),
    buildBflImageRequest({ apiModelId: "flux-3-image", prompt: "a single red apple", size: "1024x1024" })
  );
  for (const poll of [firstPoll, secondPoll]) {
    assert.equal(poll.url, POLLING_URL);
    assert.equal(poll.init.headers[BFL_API_KEY_HEADER], "test-bfl-key");
    assert.equal(poll.init.redirect, "manual");
  }
  assert.equal(download.url, SAMPLE_URL);
  assert.equal(download.init.redirect, "manual");
  assert.equal(download.init.headers, undefined, "the signed link is fetched without the key");

  assert.equal(result.mimeType, "image/png");
  assert.equal(result.outputWidth, 1024);
  assert.equal(result.outputHeight, 1024);
  assert.equal(result.providerRequestId, "task-1");
  assert.deepEqual(result.providerUsage, { cost: 4.8, input_mp: 0, output_mp: 1.05, settled_cost: 4.8 });
  assert.equal(JSON.stringify(result.requestParams).includes("red apple"), false);
  assert.equal(result.requestParams.grounding, false);
});

test("a poll whose body is cut off is asked again, not taken as the task failing", async () => {
  const calls = [];
  const cutOff = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":"task-1","sta'));
          controller.error(new TypeError("terminated"));
        },
      }),
      { headers: { "content-type": "application/json" } }
    );
  const result = await withBfl(fakeFetch(calls, { polls: [cutOff, () => ready()] }), () => generate());
  assert.equal(result.outputWidth, 1024);
  assert.equal(calls.filter((call) => call.url === POLLING_URL).length, 2);
  assert.equal(calls.filter((call) => call.url.endsWith("/v1/flux-3-image")).length, 1, "never a second submit");
});

test("a refused submit is never sent again, and 402 is our balance, not the user's error", async () => {
  for (const [status, phase] of [
    [402, "provider_failed"],
    [429, "provider_rate_limited"],
    [500, "provider_failed"],
    [422, "provider_user_error"],
    [403, "provider_failed"],
  ]) {
    const calls = [];
    await assert.rejects(
      withBfl(fakeFetch(calls, { submit: () => Response.json({ detail: "x" }, { status }) }), () => generate()),
      (error) => error.name === "ImageProviderError" && error.failurePhase === phase && error.afterGeneration === false,
      String(status)
    );
    assert.equal(calls.length, 1, `HTTP ${status} retried`);
  }
});

test("moderation is a moderation rejection; a failed task is a failure after generation", async () => {
  await assert.rejects(
    withBfl(fakeFetch([], { polls: [() => Response.json({ id: "task-1", status: "Content Moderated" })] }), () =>
      generate()
    ),
    (error) => error.failurePhase === "provider_moderation_rejected" && error.afterGeneration === false
  );
  await assert.rejects(
    withBfl(fakeFetch([], { polls: [() => Response.json({ id: "task-1", status: "Error" })] }), () => generate()),
    (error) => error.failurePhase === "provider_failed" && error.afterGeneration === true
  );
});

test("the key never leaves bfl.ai, and a file that is not the priced one is refused", async () => {
  const offDomain = [];
  await assert.rejects(
    withBfl(fakeFetch(offDomain, { submit: () => submitted({ polling_url: "https://collector.example/poll" }) }), () =>
      generate()
    ),
    (error) => error.failurePhase === "provider_failed"
  );
  assert.equal(offDomain.length, 1, "an off-domain polling URL is never called");

  for (const asset of [
    () => new Response(pngHeader(1024, 1024), { status: 302, headers: { location: "https://example.com/x" } }),
    () => new Response(pngHeader(1024, 1024), { headers: { "content-type": "image/webp" } }),
    () => new Response(pngHeader(1536, 1024), { headers: { "content-type": "image/png" } }),
    () => new Response(new Uint8Array(0), { headers: { "content-type": "image/png" } }),
  ]) {
    await assert.rejects(
      withBfl(fakeFetch([], { asset }), () => generate()),
      (error) => error.failurePhase === "provider_failed" && error.afterGeneration === true
    );
  }
});

test("BFL is never reached without its key, for an edit, or for an unpinned endpoint", async () => {
  const calls = [];
  const record = fakeFetch(calls);
  await assert.rejects(withBfl(record, () => generate(), { key: null }), (error) => error.failurePhase === "provider_failed");
  await assert.rejects(
    withBfl(record, () =>
      generate({ editImage: { bytes: pngHeader(1024, 1024), mimeType: "image/png", width: 1024, height: 1024 } })
    ),
    (error) => error.failurePhase === "provider_failed"
  );
  await assert.rejects(
    withBfl(record, () => generate(), { model: { ...FLUX3_MODEL, apiModelId: "flux-2-pro" } }),
    (error) => error.failurePhase === "provider_failed"
  );
  assert.equal(calls.length, 0);
});

test("only the FLUX 3 image family carries the per-image bound, and both are seeded on", () => {
  assert.equal(imageThinkingBilling("bfl", "flux-3-image"), "not_billed");
  assert.equal(imageThinkingCapMinimumMicroUsd("bfl", "flux-3-image"), 0);
  assert.equal(imageThinkingCapMinimumMicroUsd("bfl", "flux-3-image-klein"), 0);
  // FLUX.2 is billed per megapixel and its body is not pinned.
  assert.equal(imageThinkingCapMinimumMicroUsd("bfl", "flux-2-pro"), null);
  // Enabled by default (owner 2026-11-16) at the approved 75 and 20 credits.
  const seeded = IMAGE_MODEL_REGISTRY.filter((model) => model.provider === "bfl");
  assert.deepEqual(
    seeded.map((model) => [model.id, model.disabledReason, model.prices.map((price) => price.credits)]),
    [
      ["flux-3-image", null, [75]],
      ["flux-3-image-klein", null, [20]],
    ]
  );
  // Every seeded body is one the request builder can send.
  for (const model of seeded) {
    for (const size of model.sizes) {
      assert.ok(buildBflImageRequest({ apiModelId: model.apiModelId, prompt: "p", size }), model.id);
    }
  }
});

test("discovery's Black Forest Labs slug reaches the bfl catalogue draft", () => {
  assert.equal(RUNTIME_IMAGE_PROVIDERS.includes("bfl"), true);
  assert.equal(runtimeImageProviderFor("black-forest-labs"), "bfl");
  assert.equal(runtimeImageProviderFor("bfl"), "bfl");
  assert.equal(runtimeImageProviderFor("unknown"), null);
  // New provider research stops proposing a provider Tomverse is now connected to.
  assert.equal(isConnectedProvider("Black Forest Labs", ["bfl"]), true);
  const template = runtimeImageProfileTemplate("bfl", "flux-3-image", { qualities: ["low", "medium", "high"] });
  assert.deepEqual(template.sizes, ["1024x1024"]);
  assert.deepEqual(template.qualities, ["medium"]);
  assert.deepEqual(template.outputMimeTypes, ["image/jpeg", "image/png"]);
});

test("a BFL price source is the price page or the docs, not the playground", () => {
  assert.deepEqual(OFFICIAL_SOURCE_HOSTS.bfl, ["docs.bfl.ai", "bfl.ai/pricing"]);
  assert.equal(isOfficialSourceUrl("bfl", "https://bfl.ai/pricing"), true);
  assert.equal(isOfficialSourceUrl("bfl", "https://docs.bfl.ai/quick_start/pricing"), true);
  assert.equal(isOfficialSourceUrl("bfl", "https://bfl.ai/play"), false);
  assert.equal(isOfficialSourceUrl("bfl", "https://playground.bfl.ai/pricing"), false);
});
