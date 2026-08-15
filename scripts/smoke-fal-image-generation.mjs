// One real generation through fal, before the model is enabled.
//
//   npm run smoke:fal-image -- --out=<path> --i-accept-the-cost
//
// THIS SPENDS $0.08. One image, one call, no retry, no loop -- the amount is
// small and the reason for the ceremony is not the amount. Every paid call in
// this repository has been preceded by an approval and followed by an evidence
// file, and the first call on a new provider is the worst place to start making
// exceptions.
//
// Why it exists at all: `generateWithFal` has never made a successful request.
// The request shape, the platform headers, the CDN host, the delivered MIME and
// the image's actual dimensions are all things this repository currently
// *believes* rather than knows. Enabling the model would make the first real
// call a user's, and a user's first call is a poor place to discover that the
// asset host is not what the documentation's example implied.
//
// It goes through `buildFalImageRequest`, `falPlatformHeaders` and
// `parseFalImageResponse` -- the same code the adapter uses -- because a smoke
// test of a request the adapter does not make proves nothing about the adapter.
// That lesson is paid for: on 2026-08-06 the Google measurement script built its
// own request expression and kept reproducing an HTTP 400 the adapter had
// already been fixed for.
//
// It cannot enable anything, write to the registry or touch the database. It
// prints, it writes one evidence file, and a human reads the result.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  buildFalImageRequest,
  falAssetLengthRefused,
  falAuthorizationHeader,
  falPlatformHeaders,
  FAL_MAX_ASSET_BYTES,
  FAL_RUN_URL_BASE,
  isFalAssetUrl,
  parseFalImageResponse,
} from "../lib/falImageRequest.ts";
import { getImageModel } from "../lib/imageModelRegistry.ts";
import { readImageDimensions } from "../lib/imageDimensions.ts";

const MODEL_ID = "fal-ai/nano-banana-2";
const SIZE = "1024x1024";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const KNOWN = new Set(["out", "prompt"]);
const KNOWN_FLAGS = new Set(["i-accept-the-cost", "help"]);
const unknown = args.filter((arg) => {
  if (!arg.startsWith("--")) return true;
  const name = arg.slice(2).split("=")[0];
  return arg.includes("=") ? !KNOWN.has(name) : !KNOWN_FLAGS.has(name);
});
if (unknown.length > 0) {
  // Same rule as the Google measurement script, and for the same reason: a
  // single-hyphen typo there silently changed how many paid calls went out.
  console.error(
    `Unrecognised argument(s): ${unknown.join(" ")}\n` +
      "Refused rather than ignored -- this script spends money. Nothing was sent."
  );
  process.exit(1);
}

const model = getImageModel(MODEL_ID);
if (!model) {
  console.error(`${MODEL_ID} is not registered.`);
  process.exit(1);
}

// Deliberately dull. A smoke test is about the pipe, not the picture, and a
// prompt that provokes moderation would confuse a transport failure with a
// content one on the very first call.
const prompt = value("prompt") ?? "a plain ceramic mug on a wooden table";

const body = buildFalImageRequest({ prompt, size: SIZE, outputFormat: "png" });
if (!body) {
  console.error("The request builder refused these parameters.");
  process.exit(1);
}

const apiKey = process.env.FAL_KEY?.trim();
if (!apiKey) {
  console.error("FAL_KEY is not set.");
  process.exit(1);
}

if (!flag("i-accept-the-cost")) {
  console.error(
    [
      `Would send 1 paid generation to ${MODEL_ID} at ${SIZE}.`,
      "fal bills $0.08 on success; nothing is charged for server errors.",
      "",
      "Re-run with --i-accept-the-cost. Nothing was sent.",
    ].join("\n")
  );
  process.exit(1);
}

const outPath = value("out");
const digest = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const redact = (text) =>
  String(text)
    .replace(new RegExp(apiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "[redacted-api-key]");

const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` -- ${detail}` : ""}`);
};

const report = {
  ranAt: new Date().toISOString(),
  modelId: model.id,
  provider: model.provider,
  size: SIZE,
  promptSha256: `sha256:${digest(prompt)}`,
  // The body as sent, with the prompt digested. Policy §10 keeps prompt text
  // out of anything stored; everything else is the request under test.
  requestBody: { ...body, prompt: `sha256:${digest(prompt)}` },
  platformHeaders: falPlatformHeaders(),
};

const write = () => {
  if (!outPath) return;
  writeFileSync(outPath, `${redact(JSON.stringify(report, null, 2))}\n`, "utf8");
};
// Before the request, so an unwritable path costs nothing.
try {
  write();
} catch (error) {
  console.error(`--out cannot be written: ${outPath}\n${redact(String(error))}`);
  process.exit(1);
}

console.log(`fal smoke: ${MODEL_ID} at ${SIZE}, one paid generation\n`);

const started = Date.now();
let response;
try {
  response = await fetch(`${FAL_RUN_URL_BASE}/${model.apiModelId}`, {
    method: "POST",
    headers: {
      Authorization: falAuthorizationHeader(apiKey),
      "Content-Type": "application/json",
      ...falPlatformHeaders(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
} catch (error) {
  report.outcome = "request_failed";
  report.detail = redact(error instanceof Error ? error.message : String(error));
  write();
  console.error(`\nRequest failed: ${report.detail}`);
  process.exit(1);
}

report.elapsedMs = Date.now() - started;
report.httpStatus = response.status;
// The headers fal documents as informational, kept because two of them are the
// only runtime evidence of what was billed and which request to quote to
// support.
report.responseHeaders = {
  "x-fal-request-id": response.headers.get("x-fal-request-id"),
  "x-fal-billable-units": response.headers.get("x-fal-billable-units"),
  "x-fal-served-from": response.headers.get("x-fal-served-from"),
  "x-fal-error-type": response.headers.get("x-fal-error-type"),
};

if (!response.ok) {
  report.outcome = "http_error";
  report.detail = redact(await response.text().catch(() => "")).slice(0, 400);
  write();
  console.error(`\nHTTP ${response.status}: ${report.detail}`);
  process.exit(1);
}

const payload = await response.json().catch(() => null);
// Structure only. The image is a URL here, so nothing large is being kept, but
// a response is still provider-shaped data and only the shape is evidence.
report.responseShape = {
  keys: Object.keys(payload ?? {}),
  imageCount: Array.isArray(payload?.images) ? payload.images.length : null,
  description: typeof payload?.description === "string" ? payload.description.length : null,
};

const parsed = parseFalImageResponse(payload);
record("response parses as exactly one image", Boolean(parsed));
if (!parsed) {
  report.outcome = "unparseable";
  write();
  process.exit(1);
}

// The URL is recorded by host and path shape, never whole: it is a live,
// publicly readable link to a generated image until it expires.
const assetUrl = new URL(parsed.url);
report.asset = {
  host: assetUrl.hostname,
  pathSegments: assetUrl.pathname.split("/").filter(Boolean).length,
  mimeType: parsed.mimeType,
  reportedWidth: parsed.width,
  reportedHeight: parsed.height,
};
record("asset host is on fal's CDN", isFalAssetUrl(parsed.url), assetUrl.hostname);
record(
  "delivered MIME is one we may store",
  ["image/png", "image/jpeg", "image/webp"].includes(parsed.mimeType),
  parsed.mimeType
);

let asset;
try {
  asset = await fetch(parsed.url, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
} catch (error) {
  report.outcome = "asset_unreachable";
  report.detail = redact(error instanceof Error ? error.message : String(error));
  write();
  console.error(`\nAsset download failed: ${report.detail}`);
  process.exit(1);
}
record(
  "asset is served without a redirect off the allowed host",
  asset.ok && isFalAssetUrl(asset.url),
  `HTTP ${asset.status} from ${new URL(asset.url).hostname}`
);
record(
  "declared length is within the ceiling",
  !falAssetLengthRefused(asset.headers.get("content-length")),
  `${asset.headers.get("content-length") ?? "not declared"} of ${FAL_MAX_ASSET_BYTES}`
);

const bytes = Buffer.from(await asset.arrayBuffer());
report.asset.byteLength = bytes.byteLength;
report.asset.sha256 = `sha256:${digest(bytes.toString("base64"))}`;
record(
  "downloaded size is within the ceiling",
  bytes.byteLength > 0 && bytes.byteLength <= FAL_MAX_ASSET_BYTES,
  `${bytes.byteLength} bytes`
);

const dimensions = readImageDimensions(bytes, parsed.mimeType);
report.asset.measuredWidth = dimensions?.width ?? null;
report.asset.measuredHeight = dimensions?.height ?? null;
const [wantWidth, wantHeight] = SIZE.split("x").map(Number);
record(
  "delivered image is the size that was priced",
  dimensions?.width === wantWidth && dimensions?.height === wantHeight,
  `${dimensions?.width ?? "?"}x${dimensions?.height ?? "?"} vs ${SIZE}`
);

report.checks = checks;
report.outcome = checks.every((check) => check.ok) ? "passed" : "failed";
write();

console.log(`\nBillable units: ${report.responseHeaders["x-fal-billable-units"] ?? "not reported"}`);
console.log(`Request id:     ${report.responseHeaders["x-fal-request-id"] ?? "not reported"}`);
console.log(`Elapsed:        ${report.elapsedMs} ms`);
console.log(`\n${report.outcome}`);
if (outPath) console.log(`Evidence written to ${outPath}`);

process.exit(report.outcome === "passed" ? 0 : 1);
