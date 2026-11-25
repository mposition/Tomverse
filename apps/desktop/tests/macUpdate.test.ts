import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareMacUpdate } from "../src/host/mac-update";

const origin = "https://updates.example.test";
const feed = new URL("/desktop/updates/darwin/arm64/0.1.0", origin);
const update = {
  version: "0.1.1", url: origin + "/releases/Tomverse-Desktop-0.1.1-darwin-arm64.zip",
  sha256: "0123456789abcdef".repeat(4), size: 42,
};
const entry = { version: update.version, updateTo: update };
const manifest = { channel: "stable", platform: "darwin", arch: "arm64", currentRelease: update.version, releases: [entry] };

test("macOS gives Squirrel a local manifest with one integrity-checked release entry", async () => {
  const temp = await mkdtemp(join(tmpdir(), "tomverse-mac-feed-"));
  try {
    let requests = 0;
    const prepared = await prepareMacUpdate(async (url, options) => {
      requests++;
      assert.equal(url, feed.href);
      assert.equal(options.redirect, "error");
      assert.equal(options.credentials, "omit");
      return Response.json({ ...manifest, releases: [{ ...entry, updateTo: { ...update, delta: { url: "https://example.test" } } }] });
    }, feed, "0.1.0", "arm64", temp);
    assert.ok(prepared);
    try {
      assert.deepEqual(JSON.parse(await readFile(fileURLToPath(prepared.url), "utf8")),
        { currentRelease: update.version, releases: [entry] });
      assert.equal(requests, 1);
    } finally { await prepared.remove(); }
    assert.deepEqual(await readdir(temp), []);
  } finally { await rmdir(temp); }
});

test("macOS rejects wrong channels, architectures, versions and ZIP metadata before staging", async () => {
  const temp = await mkdtemp(join(tmpdir(), "tomverse-mac-feed-"));
  try {
    for (const bad of [
      { channel: "preview" }, { arch: "x64" }, { platform: "win32" },
      { currentRelease: "0.0.9" }, { currentRelease: "0.1.1-preview" }, { releases: [entry, entry] },
      ...[{ version: "0.1.2" }, { size: 0 }, { sha256: "malformed" }, { sha256: undefined },
        { url: "https://different.example.test/update.zip" }, { url: origin + "/update.pkg" }]
        .map((changes) => ({ releases: [{ ...entry, updateTo: { ...update, ...changes } }] })),
    ]) {
      await assert.rejects(prepareMacUpdate(async () => Response.json({ ...manifest, ...bad }), feed, "0.1.0", "arm64", temp));
    }
    await assert.rejects(prepareMacUpdate(async () => new Response(" ".repeat(16_385)), feed, "0.1.0", "arm64", temp),
      /size limit/);
    assert.deepEqual(await readdir(temp), []);
  } finally { await rmdir(temp); }
});

test("macOS skips a feed with no newer release", async () => {
  const temp = await mkdtemp(join(tmpdir(), "tomverse-mac-feed-"));
  try {
    for (const response of [new Response(null, { status: 204 }), Response.json(manifest)]) {
      assert.equal(await prepareMacUpdate(async () => response, feed, "0.1.1", "arm64", temp), null);
    }
    assert.deepEqual(await readdir(temp), []);
  } finally { await rmdir(temp); }
});
