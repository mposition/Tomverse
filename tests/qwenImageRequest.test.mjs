import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import { generateImageWithProvider } from "../lib/imageProviderAdapter.ts";
import {
  buildQwenImageRequest,
  isQwenAssetUrl,
  parseQwenImageResponse,
  QWEN_IMAGE_GENERATION_URL,
  qwenErrorEnvelope,
  qwenFailurePhase,
  qwenRequestId,
} from "../lib/qwenImageRequest.ts";

// Required, not imported: the adapter reaches the registry through tsx's
// CommonJS loader, and an ESM import is a second instance whose active
// catalogue the adapter never sees (tests/imageProviderAdapter.test.mjs).
const { resetActiveImageModelCatalog, setActiveImageModelCatalog } = createRequire(import.meta.url)(
  "../lib/imageModelRegistry.ts"
);

const ASSET_URL = "https://dashscope-result-sgp.oss-ap-southeast-1.aliyuncs.com/1d/out.png?Expires=1";

const success = (url = ASSET_URL, usage = { image_count: 1, width: 1024, height: 1024 }) => ({
  output: {
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: [{ image: url }] } }],
  },
  usage,
  request_id: "req-qwen-1",
});

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
const QWEN_MODEL = {
  id: "qwen-image-2.0",
  provider: "qwen",
  apiModelId: "qwen-image-2.0",
  name: "Qwen Image 2.0",
  lifecycle: "preview",
  disabledReason: null,
  sizes: ["1024x1024"],
  qualities: ["medium"],
  prices: [{ quality: "medium", size: "1024x1024", credits: 45, outputCostMicroUsd: 35_000 }],
  latencyClass: "balanced",
  provenance: [],
  outputMimeTypes: ["image/png"],
  pricingVersion: "qwen-image-2-0-test-v1",
  priceVerification: {
    verifiedAt: "2026-11-07",
    sources: ["https://www.alibabacloud.com/help/en/model-studio/model-pricing"],
    thinkingCapMicroUsd: 0,
  },
};

const withQwen = async (fake, run, { model = QWEN_MODEL, key = "test-dashscope-key" } = {}) => {
  const original = globalThis.fetch;
  const previous = process.env.DASHSCOPE_API_KEY;
  globalThis.fetch = fake;
  if (key === null) delete process.env.DASHSCOPE_API_KEY;
  else process.env.DASHSCOPE_API_KEY = key;
  setActiveImageModelCatalog([model]);
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
    resetActiveImageModelCatalog();
    if (previous === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = previous;
  }
};

const generate = (overrides = {}) =>
  generateImageWithProvider({
    prompt: "a single red apple",
    size: "1024x1024",
    quality: "medium",
    modelId: QWEN_MODEL.id,
    ...overrides,
  });

/** Answers the generation call with `generation` and the asset fetch with `asset`. */
const fakeFetch = (calls, { generation = () => Response.json(success()), asset } = {}) =>
  async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url) === QWEN_IMAGE_GENERATION_URL) return generation();
    const response =
      asset?.(String(url)) ??
      new Response(pngHeader(1024, 1024), { headers: { "content-type": "image/png", "content-length": "33" } });
    Object.defineProperty(response, "url", { value: String(url) });
    return response;
  };

test("the whole request body is pinned, and only the prompt is the user's", () => {
  assert.deepEqual(buildQwenImageRequest({ apiModelId: "qwen-image-2.0", prompt: "a red apple", size: "1024x1024" }), {
    model: "qwen-image-2.0",
    input: { messages: [{ role: "user", content: [{ text: "a red apple" }] }] },
    // 2.0 defaults to 2048 on a side; prompt_extend defaults to true.
    parameters: { size: "1024*1024", n: 1, watermark: false, prompt_extend: false },
  });
});

test("a size with no approved mapping is refused, not sent", () => {
  for (const size of ["1536x1024", "1024x1536"]) {
    assert.equal(buildQwenImageRequest({ apiModelId: "qwen-image-2.0", prompt: "x", size }), null, size);
  }
});

test("a result is fetched only from Singapore's public OSS endpoint", () => {
  assert.equal(isQwenAssetUrl(ASSET_URL), true);
  // The API reference's own example host: a mainland (Shenzhen) bucket.
  assert.equal(isQwenAssetUrl("https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/xxx.png?Expires=xxx"), false);
  assert.equal(isQwenAssetUrl("https://dashscope-result-hk.oss-cn-hongkong.aliyuncs.com/a.png"), false);
  // Review finding 2026-11-07: the same domain names Alibaba's intranet endpoints.
  assert.equal(isQwenAssetUrl("https://bucket.oss-ap-southeast-1-internal.aliyuncs.com/a.png"), false);
  assert.equal(isQwenAssetUrl("https://bucket.oss-us-east-1.aliyuncs.com/a.png"), false);
  assert.equal(isQwenAssetUrl("https://bucket.oss-accelerate.aliyuncs.com/a.png"), false);
  assert.equal(isQwenAssetUrl("https://dashscope-intl.aliyuncs.com/a.png"), false);
  assert.equal(isQwenAssetUrl("https://a.b.oss-ap-southeast-1.aliyuncs.com/a.png"), false);
  assert.equal(isQwenAssetUrl("https://oss-ap-southeast-1.aliyuncs.com/a.png"), false);
  assert.equal(isQwenAssetUrl("http://dashscope-result-sgp.oss-ap-southeast-1.aliyuncs.com/a.png"), false);
  assert.equal(isQwenAssetUrl("https://dashscope-result-sgp.oss-ap-southeast-1.aliyuncs.com:8443/a.png"), false);
  assert.equal(isQwenAssetUrl("https://user@dashscope-result-sgp.oss-ap-southeast-1.aliyuncs.com/a.png"), false);
  assert.equal(isQwenAssetUrl("https://aliyuncs.com.example.org/a.png"), false);
  assert.equal(isQwenAssetUrl("https://169.254.169.254/latest/meta-data"), false);
  assert.equal(isQwenAssetUrl("not a url"), false);
});

test("exactly one image, and usage that agrees with one", () => {
  assert.deepEqual(parseQwenImageResponse(success()), { url: ASSET_URL });
  assert.deepEqual(parseQwenImageResponse(success(ASSET_URL, undefined)), { url: ASSET_URL });
  assert.deepEqual(parseQwenImageResponse(success(ASSET_URL, { output_image_count: 1, input_image_count: 0 })), {
    url: ASSET_URL,
  });
  const two = success();
  two.output.choices[0].message.content.push({ image: ASSET_URL });
  assert.equal(parseQwenImageResponse(two), null);
  const twoChoices = success();
  twoChoices.output.choices.push(twoChoices.output.choices[0]);
  assert.equal(parseQwenImageResponse(twoChoices), null);
  assert.equal(parseQwenImageResponse(success(ASSET_URL, { image_count: 2 })), null);
  assert.equal(parseQwenImageResponse(success(ASSET_URL, { output_image_count: 2 })), null);
  // 3.0 bills each input image; a text-only request priced without one is refused.
  assert.equal(parseQwenImageResponse(success(ASSET_URL, { output_image_count: 1, input_image_count: 1 })), null);
  assert.equal(parseQwenImageResponse(success("https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/x.png")), null);
  assert.equal(parseQwenImageResponse({ output: { choices: [{ message: { content: [{ text: "no" }] } }] } }), null);
  assert.equal(parseQwenImageResponse(null), null);
});

test("error bodies: moderation and arrears are named by code, the rest by status", () => {
  assert.equal(qwenFailurePhase({ code: "DataInspectionFailed", message: "Input or output data may contain inappropriate content." }), "provider_moderation_rejected");
  assert.equal(qwenFailurePhase({ code: "data_inspection_failed" }), "provider_moderation_rejected");
  assert.equal(qwenFailurePhase({ code: "IPInfringementSuspect" }), "provider_moderation_rejected");
  assert.equal(qwenFailurePhase({ code: "Arrearage" }), "provider_failed");
  assert.equal(qwenFailurePhase({ code: "InvalidParameter" }), null);
  assert.equal(qwenFailurePhase(null), null);
  assert.deepEqual(qwenErrorEnvelope({ code: "InvalidApiKey", message: "Invalid API-key provided.", request_id: "r" }), {
    error: { code: "InvalidApiKey", message: "Invalid API-key provided." },
  });
  assert.equal(qwenRequestId({ request_id: "31f808fd" }), "31f808fd");
  assert.equal(qwenRequestId({}), null);
});

test("a Qwen generation is one bearer call, then the file is fetched without following redirects", async () => {
  const calls = [];
  const result = await withQwen(fakeFetch(calls), () => generate());
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, QWEN_IMAGE_GENERATION_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-dashscope-key");
  assert.deepEqual(JSON.parse(calls[0].init.body), buildQwenImageRequest({
    apiModelId: "qwen-image-2.0",
    prompt: "a single red apple",
    size: "1024x1024",
  }));
  assert.equal(calls[1].url, ASSET_URL);
  assert.equal(calls[1].init.redirect, "manual");

  assert.equal(result.mimeType, "image/png");
  assert.equal(result.outputWidth, 1024);
  assert.equal(result.outputHeight, 1024);
  assert.equal(result.providerRequestId, "req-qwen-1");
  assert.equal(result.inputTokens, 0);
  assert.equal(result.thinkingTokens, 0);
  // The audit view keeps the model and parameters and drops the prompt.
  assert.deepEqual(result.requestParams, {
    model: "qwen-image-2.0",
    parameters: { size: "1024*1024", n: 1, watermark: false, prompt_extend: false },
  });
  assert.equal(JSON.stringify(result.requestParams).includes("red apple"), false);
});

test("a failed Qwen call is never retried, whatever the status", async () => {
  for (const [status, body, phase] of [
    [429, { code: "Throttling.RateQuota", message: "Requests rate limit exceeded, please try again later." }, "provider_rate_limited"],
    [500, { code: "InternalError", message: "x" }, "provider_failed"],
    [400, { code: "DataInspectionFailed", message: "Input or output data may contain inappropriate content." }, "provider_moderation_rejected"],
    [400, { code: "InvalidParameter", message: "bad" }, "provider_user_error"],
    [401, { code: "InvalidApiKey", message: "Invalid API-key provided." }, "provider_failed"],
  ]) {
    const calls = [];
    await assert.rejects(
      withQwen(fakeFetch(calls, { generation: () => Response.json({ ...body, request_id: "req-err" }, { status }) }), () =>
        generate()
      ),
      (error) => error.name === "ImageProviderError" && error.failurePhase === phase && error.providerRequestId === "req-err",
      String(status)
    );
    assert.equal(calls.length, 1, `HTTP ${status} retried`);
  }

  const calls = [];
  await assert.rejects(
    withQwen(
      async (url) => {
        calls.push(String(url));
        throw new TypeError("fetch failed");
      },
      () => generate()
    ),
    (error) => error.failurePhase === "provider_failed"
  );
  assert.equal(calls.length, 1);
});

test("a result that is not the priced file is refused before it is stored", async () => {
  const refuse = async (asset, pattern) => {
    await assert.rejects(
      withQwen(fakeFetch([], { asset }), () => generate()),
      (error) => error.name === "ImageProviderError" && error.failurePhase === "provider_failed" && pattern.test(error.message)
    );
  };
  // A redirect is not followed, even to an allowed host.
  await refuse(() => new Response(null, { status: 302, headers: { location: ASSET_URL } }), /expected location/);
  await refuse(
    () => new Response(pngHeader(1024, 1024), { headers: { "content-type": "image/jpeg" } }),
    /not a type this model may store/
  );
  await refuse(
    () => new Response(pngHeader(1024, 1024), { headers: { "content-type": "image/png", "content-length": String(64 * 1024 * 1024) } }),
    /larger than the accepted limit/
  );
  // Review finding 2026-11-07: a body that declares no length is capped while
  // it is read, and the stream is cancelled rather than drained.
  let pulled = 0;
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  await refuse(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulled += 1;
            controller.enqueue(chunk);
            if (pulled > 64) controller.close();
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "image/png" } }
      ),
    /larger than the accepted limit/
  );
  assert.equal(cancelled, true);
  assert.ok(pulled <= 20, `read ${pulled} MiB before refusing`);
  await refuse(() => new Response(new Uint8Array(0), { headers: { "content-type": "image/png" } }), /empty/);
  await refuse(() => new Response(pngHeader(2048, 2048), { headers: { "content-type": "image/png" } }), /different size/);
  await refuse(() => new Response(Buffer.from("not a png"), { headers: { "content-type": "image/png" } }), /different size/);

  // A mainland-hosted result is not downloaded at all.
  const calls = [];
  await assert.rejects(
    withQwen(
      fakeFetch(calls, {
        generation: () => Response.json(success("https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/x.png")),
      }),
      () => generate()
    ),
    (error) => /no usable image payload/.test(error.message)
  );
  assert.equal(calls.length, 1);
});

test("Qwen is never reached without its key, for an edit, or while held", async () => {
  const calls = [];
  const fetcher = fakeFetch(calls);
  await assert.rejects(
    withQwen(fetcher, () => generate(), { key: null }),
    (error) => /not configured/.test(error.message)
  );
  await assert.rejects(
    withQwen(fetcher, () =>
      generate({
        editImage: { bytes: Buffer.from("png"), mimeType: "image/png", width: 1024, height: 1024, sha256: "a".repeat(64) },
      })
    ),
    (error) => /cannot edit an image/.test(error.message)
  );
  await assert.rejects(
    withQwen(fetcher, () => generate(), { model: { ...QWEN_MODEL, disabledReason: "price_unverified" } }),
    (error) => /not available for requests/.test(error.message)
  );
  await assert.rejects(
    withQwen(fetcher, () => generate({ size: "1536x1024" })),
    (error) => /no Qwen request mapping/.test(error.message)
  );
  assert.equal(calls.length, 0);
});
