// Measures an xAI and a fal photo edit, built by the same request builders the
// adapter sends (lib/xaiImageRequest.ts, lib/falImageRequest.ts), so the edit
// pricing in lib/imageGenerationPricing.ts can be verified from evidence:
//
//   * xAI publishes only its output price. Each edit's usage.cost_in_usd_ticks
//     says what the request actually cost, and so what the photo adds.
//   * fal publishes the edit price. One edit proves the endpoint takes the
//     photo as a data URI and returns the 1024x1024 image that was priced.
//
// PAID: two xAI edits and one fal edit, about US$0.25 at the worst case. Runs
// only with --confirm-paid, and only with the owner's approval of that spend.
//
//   node --import tsx scripts/measure-image-edit-providers.mjs --confirm-paid
//
// Needs XAI_API_KEY and FAL_KEY in the environment. Prints what each provider
// reported; nothing is stored.

import sharp from "sharp";

import {
  buildFalImageEditRequest,
  falAuthorizationHeader,
  FAL_EDIT_ENDPOINT_SUFFIX,
  falPlatformHeaders,
  FAL_RUN_URL_BASE,
  isFalAssetUrl,
  parseFalImageResponse,
} from "../lib/falImageRequest.ts";
import {
  buildXaiImageEditRequest,
  parseXaiImageResponse,
  XAI_IMAGE_EDITS_URL,
  xaiReportedCostMicroUsd,
} from "../lib/xaiImageRequest.ts";

if (!process.argv.includes("--confirm-paid")) {
  console.error("Refusing to run: this makes paid xAI and fal edit calls. Pass --confirm-paid.");
  process.exit(2);
}
const xaiKey = process.env.XAI_API_KEY?.trim();
const falKey = process.env.FAL_KEY?.trim();
if (!xaiKey || !falKey) {
  console.error("XAI_API_KEY and FAL_KEY are required.");
  process.exit(2);
}

const PROMPT = "Make the image slightly brighter. Keep everything else the same.";

// Noise, not a flat fill, so the encoder sees photo-like detail. The shapes
// are the largest the executor sends after fitting inside 1024px.
const photo = async (width, height) => {
  const noise = Buffer.alloc(width * height * 3);
  for (let index = 0; index < noise.length; index += 1) noise[index] = Math.floor(Math.random() * 256);
  const bytes = await sharp(noise, { raw: { width, height, channels: 3 } }).png().toBuffer();
  return { bytes, mimeType: "image/png" };
};

const describe = async (base64) => {
  const meta = await sharp(Buffer.from(base64, "base64")).metadata();
  return `${meta.width}x${meta.height}`;
};

for (const [width, height] of [[1024, 1024], [1024, 768]]) {
  const body = buildXaiImageEditRequest({
    apiModelId: "grok-imagine-image-quality-20260403",
    prompt: PROMPT,
    size: "1024x1024",
    image: await photo(width, height),
  });
  const response = await fetch(XAI_IMAGE_EDITS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${xaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    console.error(`xai ${width}x${height}: HTTP ${response.status}`, JSON.stringify(payload));
    process.exitCode = 1;
    continue;
  }
  const parsed = parseXaiImageResponse(payload);
  console.log(JSON.stringify({
    provider: "xai",
    input: `${width}x${height}`,
    costMicroUsd: xaiReportedCostMicroUsd(payload),
    usage: payload?.usage ?? null,
    output: parsed ? { mimeType: parsed.mimeType, size: await describe(parsed.imageBase64) } : null,
  }));
}

{
  const body = buildFalImageEditRequest({
    prompt: PROMPT,
    size: "1024x1024",
    outputFormat: "png",
    image: await photo(1024, 768),
  });
  const response = await fetch(
    `${FAL_RUN_URL_BASE}/fal-ai/nano-banana-2${FAL_EDIT_ENDPOINT_SUFFIX}`,
    {
      method: "POST",
      headers: {
        Authorization: falAuthorizationHeader(falKey),
        "Content-Type": "application/json",
        // The adapter's own: no retry, no stored I/O, a 15-minute asset.
        ...falPlatformHeaders(),
      },
      body: JSON.stringify(body),
    }
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    console.error(`fal: HTTP ${response.status}`, JSON.stringify(payload));
    process.exitCode = 1;
  } else {
    const parsed = parseFalImageResponse(payload);
    let size = null;
    if (parsed && isFalAssetUrl(parsed.url)) {
      const asset = await fetch(parsed.url, { redirect: "manual" });
      if (asset.ok) size = await describe(Buffer.from(await asset.arrayBuffer()).toString("base64"));
    }
    console.log(JSON.stringify({
      provider: "fal",
      input: "1024x768",
      requestId: response.headers.get("x-fal-request-id"),
      output: parsed ? { mimeType: parsed.mimeType, onFalCdn: isFalAssetUrl(parsed.url), size } : null,
      keys: payload && typeof payload === "object" ? Object.keys(payload) : null,
    }));
  }
}
