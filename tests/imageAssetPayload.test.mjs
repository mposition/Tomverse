import assert from "node:assert/strict";
import { test } from "node:test";

import { serializeImageAssets } from "../lib/imageAssetPayload.ts";

const row = (role, r2Key) => ({ role, r2Key, mimeType: "image/png" });

// Deliberately opaque: a real signed URL does contain the key, so a minter
// that echoed it would make "the key does not appear in the payload"
// impossible to assert. The question here is whether the *row* is passed
// onward, and that has to be asked with a URL the key cannot hide inside.
const signatures = new Map([
  ["u/1/original.png", "https://signed.example/aaa"],
  ["u/1/thumb.png", "https://signed.example/bbb"],
]);
const fakeMint = async (r2Key) => signatures.get(r2Key) ?? "https://signed.example/zzz";

test("a client learns the URL and never the storage key", async () => {
  const assets = await serializeImageAssets(
    "succeeded",
    [row("original", "u/1/original.png"), row("thumbnail", "u/1/thumb.png")],
    fakeMint
  );
  // Pinned as the exact key set, not as "contains url". The failure this
  // exists for is an edit that spreads the row -- `{...asset, url}` reads as
  // harmless and ships the R2 key with every poll.
  for (const asset of assets) {
    assert.deepEqual(Object.keys(asset).sort(), ["mimeType", "role", "url"]);
  }
  assert.ok(!JSON.stringify(assets).includes("u/1/original.png"));
  assert.ok(!JSON.stringify(assets).includes("r2Key"));
  assert.deepEqual(assets, [
    {
      role: "original",
      mimeType: "image/png",
      url: "https://signed.example/aaa",
    },
    {
      role: "thumbnail",
      mimeType: "image/png",
      url: "https://signed.example/bbb",
    },
  ]);
});

test("only a succeeded generation hands out anything at all", async () => {
  // A failed run can have a partially written original behind it. A URL to
  // half an object is worse than no image: it looks like the product
  // misbehaving rather than like the failure it is.
  const minted = [];
  const trackingMint = async (r2Key) => {
    minted.push(r2Key);
    return "https://signed.example/x";
  };
  for (const status of [
    "queued",
    "running",
    "settling",
    "failed",
    "settlement_failed",
    "cancelled",
  ]) {
    assert.deepEqual(
      await serializeImageAssets(status, [row("original", "u/1/o.png")], trackingMint),
      [],
      status
    );
  }
  // Not merely filtered afterwards -- no URL was minted for any of them, so a
  // signature for an unfinished object never exists to be logged or leaked.
  assert.deepEqual(minted, []);

  assert.deepEqual(await serializeImageAssets("succeeded", [], trackingMint), []);
});

test("every emitted asset went through the minter", async () => {
  // There is no branch that produces a payload without calling mintUrl, so a
  // future asset role cannot arrive with a URL from somewhere else.
  const seen = [];
  const assets = await serializeImageAssets(
    "succeeded",
    [row("original", "a"), row("thumbnail", "b"), row("preview", "c")],
    async (r2Key) => {
      seen.push(r2Key);
      return `signed:${r2Key}`;
    }
  );
  assert.deepEqual(seen.sort(), ["a", "b", "c"]);
  assert.deepEqual(
    assets.map((asset) => asset.url),
    ["signed:a", "signed:b", "signed:c"]
  );
});
