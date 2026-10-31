import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

// The media CLI's upload confirmation (operator decision 2026-10-31), with R2
// and the store stood in for: the bytes are hashed against the announced
// SHA-256 at the upload key, and only the hashed version is copied to the key
// the asset is kept at.

const child = spawnSync(
  process.execPath,
  [
    "--experimental-test-module-mocks",
    "--conditions=react-server",
    "--import",
    "tsx",
    resolve("tests/support/marketingAssetUploadRouteHarness.mjs"),
  ],
  { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
);
assert.equal(child.status, 0, `harness failed\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
const line = child.stdout.split(/\r?\n/u).find((candidate) => candidate.startsWith("MARKETING_ASSET_UPLOAD_RESULTS="));
assert.ok(line, child.stdout);
const results = Object.fromEntries(
  JSON.parse(line.slice("MARKETING_ASSET_UPLOAD_RESULTS=".length)).map((result) => [result.scenario, result]),
);

const UPLOAD = "marketing-assets/media-a/upload.mp4";
const KEPT = "marketing-assets/media-a/original.mp4";

test("a verified upload is copied, only as the version hashed, to the kept key, then recorded", () => {
  const verified = results.verified;
  assert.equal(verified.status, 200);
  assert.deepEqual(verified.calls, [
    `validate ${UPLOAD}`,
    `hash ${UPLOAD}`,
    `copy ${UPLOAD} -> ${KEPT} if "v1"`,
    "confirm",
    `delete ${UPLOAD}`,
  ]);
});

test("bytes other than the announced hash are removed and nothing is copied or recorded", () => {
  const mismatch = results["hash mismatch"];
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.code, "upload_hash_mismatch");
  assert.deepEqual(mismatch.calls, [`validate ${UPLOAD}`, `hash ${UPLOAD}`, `delete ${UPLOAD}`]);
});

test("an upload replaced between the hash and the copy is refused, not kept", () => {
  const replaced = results["replaced while verified"];
  assert.equal(replaced.status, 409);
  assert.equal(replaced.code, "upload_changed_while_verified");
  assert.equal(replaced.calls.includes("confirm"), false);
});

test("a resent confirmation answers as the first did without reading the file again", () => {
  const again = results["already uploaded"];
  assert.equal(again.status, 200);
  assert.deepEqual(again.calls, ["confirm", `delete ${UPLOAD}`]);
});

test("only the media CLI's secret is accepted", () => {
  assert.equal(results["wrong secret"].status, 401);
  assert.deepEqual(results["wrong secret"].calls, []);
});
