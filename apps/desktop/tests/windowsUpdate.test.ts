import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareWindowsUpdate } from "../src/host/windows-update";

const feed = new URL("https://updates.example.test/desktop/updates/win32/x64/0.1.0");
const payload = Buffer.from("verified package data");
const release = {
  channel: "stable", platform: "win32", arch: "x64", version: "0.1.1",
  url: "https://updates.example.test/releases/Tomverse-Desktop-0.1.1.0-x64.msix",
  size: payload.length, sha256: createHash("sha256").update(payload).digest("hex"),
};

function fixture(metadata: Response, content = payload) {
  const requests: string[] = [];
  const fetchUpdate: typeof fetch = async (input, options) => {
    const url = String(input);
    requests.push(url);
    assert.equal(options?.redirect, "error");
    assert.equal(options?.credentials, "omit");
    if (url === feed.href) return metadata;
    assert.equal(url, release.url);
    return new Response(new Uint8Array(content));
  };
  return { fetchUpdate, requests };
}

test("Windows stages locally verified update bytes and cleans the staged file", async () => {
  const profile = await mkdtemp(join(tmpdir(), "tomverse-update-"));
  const { fetchUpdate, requests } = fixture(Response.json(release));
  let downloads = 0;
  let signatureChecks = 0;
  try {
    const staged = await prepareWindowsUpdate(fetchUpdate, feed, "0.1.0", profile, () => downloads++, async (path, version) => {
      signatureChecks++;
      assert.equal(version, "0.1.1.0");
      assert.deepEqual(await readFile(path), payload);
    });
    assert.ok(staged);
    try {
      assert.deepEqual(await readFile(fileURLToPath(staged.url)), payload);
      assert.deepEqual(requests, [feed.href, release.url]);
      assert.equal(downloads, 1);
      assert.equal(signatureChecks, 1);
    } finally { await staged.remove(); }
    assert.deepEqual(await readdir(profile), []);
  } finally { await rmdir(profile); }
});

test("Windows declines wrong channels, targets and old versions before download", async () => {
  const profile = await mkdtemp(join(tmpdir(), "tomverse-update-"));
  try {
    for (const change of [
      { channel: "preview" }, { platform: "darwin" }, { arch: "arm64" },
      { version: "0.0.9" }, { version: "0.1.1-preview" }, { version: "0.1.65536" },
      { url: "https://elsewhere.example.test/other.msix" }, { size: 1024 * 1024 * 1024 },
    ]) {
      const { fetchUpdate, requests } = fixture(Response.json({ ...release, ...change }));
      await assert.rejects(prepareWindowsUpdate(fetchUpdate, feed, "0.1.0", profile, assert.fail, assert.fail));
      assert.deepEqual(requests, [feed.href]);
    }
    for (const response of [new Response(null, { status: 204 }), Response.json({ ...release, version: "0.1.0" })]) {
      const { fetchUpdate, requests } = fixture(response);
      assert.equal(await prepareWindowsUpdate(fetchUpdate, feed, "0.1.0", profile, assert.fail, assert.fail), null);
      assert.deepEqual(requests, [feed.href]);
    }
    assert.deepEqual(await readdir(profile), []);
  } finally { await rmdir(profile); }
});

test("Windows discards short, oversized, modified and signature-rejected packages", async () => {
  const profile = await mkdtemp(join(tmpdir(), "tomverse-update-"));
  try {
    for (const content of [payload.subarray(1), Buffer.concat([payload, payload]), Buffer.alloc(payload.length)]) {
      const { fetchUpdate } = fixture(Response.json(release), content);
      let signerChecked = false;
      await assert.rejects(prepareWindowsUpdate(fetchUpdate, feed, "0.1.0", profile, () => undefined,
        async () => { signerChecked = true; }), /size|hash/);
      assert.equal(signerChecked, false);
      assert.deepEqual(await readdir(profile), []);
    }
    const { fetchUpdate } = fixture(Response.json(release));
    await assert.rejects(prepareWindowsUpdate(fetchUpdate, feed, "0.1.0", profile, () => undefined,
      async () => { throw new Error("Untrusted update signature"); }), /Untrusted update signature/);
    assert.deepEqual(await readdir(profile), []);
  } finally { await rmdir(profile); }
});
