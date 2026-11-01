// Submits one rendered file as a marketing asset:
//   node submit-asset.mjs <file> <asset.json>
// asset.json is the registry entry and transcript (see JOB.md). The file is
// hashed and measured here, announced to the app (which runs the Guard over the
// transcript), uploaded to the URL the app returns, and confirmed. Nothing is
// published: a person approves the asset in Admin.
//
// Exit codes: 0 submitted, 3 the Guard refused the transcript (its codes are
// printed; rewrite and submit again), 1 anything else.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [file, metaPath] = process.argv.slice(2);
if (!file || !metaPath) {
  console.error("usage: node submit-asset.mjs <file> <asset.json>");
  process.exit(1);
}
const appUrl = process.env.MARKETING_APP_URL;
const secret = process.env.MARKETING_MEDIA_SUBMIT_SECRET;
if (!appUrl || !secret) {
  console.error("MARKETING_APP_URL and MARKETING_MEDIA_SUBMIT_SECRET must be set");
  process.exit(1);
}

const CONTENT_TYPES = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };
const extension = path.extname(file).toLowerCase();
const contentType = CONTENT_TYPES[extension];
if (!contentType) {
  console.error(`unsupported file type ${extension}`);
  process.exit(1);
}
const kind = contentType.startsWith("video/") ? "video" : "image";
const bytes = readFileSync(file);
const sha256 = createHash("sha256").update(bytes).digest("hex");

/** Whole seconds, from the ffprobe Remotion ships (or one on the PATH). */
function durationSeconds() {
  if (kind !== "video") return null;
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "node_modules", "@remotion");
  const compositor = existsSync(dir) ? readdirSync(dir).find((name) => name.startsWith("compositor-")) : undefined;
  const probe = compositor
    ? path.join(dir, compositor, process.platform === "win32" ? "ffprobe.exe" : "ffprobe")
    : "ffprobe";
  const out = execFileSync(probe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], {
    encoding: "utf8",
  });
  return Math.max(1, Math.ceil(Number(out.trim())));
}

const meta = JSON.parse(readFileSync(metaPath, "utf8"));
const submission = {
  asset: meta.asset,
  kind,
  contentType,
  bytes: bytes.length,
  sha256,
  durationSeconds: durationSeconds(),
  ...(meta.transcript ? { transcript: meta.transcript } : {}),
};

const post = async (route, body) => {
  const response = await fetch(new URL(route, appUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

const requested = await post("/api/internal/marketing-assets", submission);
if (requested.status === 422 && requested.body.code === "transcript_guard_rejected") {
  console.log(JSON.stringify({ refused: "transcript_guard_rejected", guardCodes: requested.body.guardCodes }));
  process.exit(3);
}
if (requested.status !== 200) {
  console.error(JSON.stringify({ step: "request", status: requested.status, body: requested.body }));
  process.exit(1);
}
const { assetId, upload } = requested.body.result;

const put = await fetch(upload.url, { method: "PUT", headers: { "content-type": upload.contentType }, body: bytes });
if (!put.ok) {
  console.error(JSON.stringify({ step: "upload", status: put.status }));
  process.exit(1);
}

const confirmed = await post(`/api/internal/marketing-assets/${encodeURIComponent(assetId)}/uploaded`, {});
if (confirmed.status !== 200) {
  console.error(JSON.stringify({ step: "confirm", status: confirmed.status, body: confirmed.body }));
  process.exit(1);
}
console.log(JSON.stringify({ submitted: assetId, kind, bytes: bytes.length, sha256 }));
