import assert from "node:assert/strict";
import { test } from "node:test";

import {
  IMAGE_ASSET_URL_EXPIRY_GUARD_MS,
  IMAGE_ASSET_URL_TTL_MINUTES,
  IMAGE_ASSET_URL_TTL_SECONDS,
  isImageAssetUrlExpired,
  serializeImageAssets,
} from "../lib/imageAssetPayload.ts";

const row = (role, r2Key) => ({ role, r2Key, mimeType: "image/png" });

// Deliberately opaque: a real signed URL does contain the key, so a minter
// that echoed it would make "the key does not appear in the payload"
// impossible to assert. The question here is whether the *row* is passed
// onward, and that has to be asked with a URL the key cannot hide inside.
const signatures = new Map([
  ["u/1/original.png", "https://signed.example/aaa"],
  ["u/1/thumb.png", "https://signed.example/bbb"],
]);
const EXPIRES_AT = "2026-08-25T12:05:00.000Z";
const fakeMint = async (r2Key) => ({
  url: signatures.get(r2Key) ?? "https://signed.example/zzz",
  expiresAt: EXPIRES_AT,
});

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
    assert.deepEqual(Object.keys(asset).sort(), [
      "mimeType",
      "role",
      "url",
      "urlExpiresAt",
    ]);
  }
  assert.ok(!JSON.stringify(assets).includes("u/1/original.png"));
  assert.ok(!JSON.stringify(assets).includes("r2Key"));
  assert.deepEqual(assets, [
    {
      role: "original",
      mimeType: "image/png",
      url: "https://signed.example/aaa",
      urlExpiresAt: EXPIRES_AT,
    },
    {
      role: "thumbnail",
      mimeType: "image/png",
      url: "https://signed.example/bbb",
      urlExpiresAt: EXPIRES_AT,
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
    return { url: "https://signed.example/x", expiresAt: EXPIRES_AT };
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
      return { url: `signed:${r2Key}`, expiresAt: EXPIRES_AT };
    }
  );
  assert.deepEqual(seen.sort(), ["a", "b", "c"]);
  assert.deepEqual(
    assets.map((asset) => asset.url),
    ["signed:a", "signed:b", "signed:c"]
  );
});

test("the expiry a client acts on is the one the minter reported", async () => {
  // Not recomputed here from a TTL constant: a URL and an expiry decided in
  // two places are two facts that can disagree, and the client would act on
  // the wrong one.
  const assets = await serializeImageAssets(
    "succeeded",
    [row("original", "u/1/original.png")],
    async () => ({ url: "https://signed.example/aaa", expiresAt: "2030-01-01T00:00:00.000Z" })
  );
  assert.equal(assets[0].urlExpiresAt, "2030-01-01T00:00:00.000Z");
});

test("a URL is dead a few seconds before its signature actually lapses", () => {
  // A click at T-1s can lose the race between the navigation and the
  // signature, and the two outcomes are an image and an S3 error document.
  const expiresAt = "2026-08-25T12:05:00.000Z";
  const expiryMs = Date.parse(expiresAt);
  assert.equal(isImageAssetUrlExpired(expiresAt, expiryMs - 60_000), false);
  assert.equal(
    isImageAssetUrlExpired(expiresAt, expiryMs - IMAGE_ASSET_URL_EXPIRY_GUARD_MS - 1),
    false
  );
  assert.equal(
    isImageAssetUrlExpired(expiresAt, expiryMs - IMAGE_ASSET_URL_EXPIRY_GUARD_MS),
    true
  );
  assert.equal(isImageAssetUrlExpired(expiresAt, expiryMs + 60_000), true);
});

test("an unknown expiry is not treated as an expired one", () => {
  // A payload from before the field existed -- a tab left open across the
  // deploy. Refusing the click on absence would break working links to guard
  // against a guess.
  for (const value of [undefined, null, "", "not a date"]) {
    assert.equal(isImageAssetUrlExpired(value, Date.parse("2030-01-01T00:00:00.000Z")), false);
  }
});

test("the minutes the copy quotes are the seconds the server signs with", () => {
  // The whole reason the constant lives in this module rather than in the
  // server-only read path: one number, signed and stated.
  assert.equal(IMAGE_ASSET_URL_TTL_MINUTES * 60, IMAGE_ASSET_URL_TTL_SECONDS);
});
