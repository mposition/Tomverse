import assert from "node:assert/strict";
import test from "node:test";

import { generatorAssetProjection } from "@/lib/marketingGeneratorContext";

const asset = (overrides = {}) => ({
  id: "asset_hero",
  provenance: "capture",
  allowedChannels: ["linkedin", "x"],
  alt: { en: "The comparison view with three answers.", ko: "세 답변을 나란히 보여 주는 화면." },
  claimIds: ["claim_compare"],
  validUntil: "2027-01-31",
  disclosure: { linkedin: "none", x: "none" },
  depictsProductInterface: true,
  ...overrides,
});

test("no registry is no assets", () => {
  assert.deepEqual(generatorAssetProjection(null, ["linkedin"]), []);
});

test("an asset is listed by what a draft may name and what it shows, without its provenance or disclosure", () => {
  const [listed] = generatorAssetProjection({ version: 3, assets: [asset()] }, ["linkedin"]);
  const { alt, ...named } = listed;
  assert.deepEqual(named, {
    id: "asset_hero",
    allowedChannels: ["linkedin"],
    altLocales: ["en", "ko"],
    claimIds: ["claim_compare"],
    validUntil: "2027-01-31",
    // A hand-kept asset names no kind.
    kind: null,
  });
  // The approved alt text is the description a post is written about (owner direction 2026-10-31).
  assert.deepEqual(Object.keys(alt).sort(), ["en", "ko"]);
  const text = JSON.stringify(listed);
  for (const withheld of ["provenance", "disclosure", "depictsProductInterface"]) {
    assert.equal(text.includes(withheld), false, withheld);
  }
});

test("a stored asset carries the kind the store records", () => {
  const [listed] = generatorAssetProjection({ version: 3, assets: [asset()] }, ["linkedin"], new Map([["asset_hero", "video"]]));
  assert.equal(listed.kind, "video");
  assert.equal("longForm" in listed, false);
});

test("a long-form stored video is marked so, and nothing else is (owner decision 2026-11-07)", () => {
  const [listed] = generatorAssetProjection(
    { version: 3, assets: [asset()] },
    ["linkedin"],
    new Map([["asset_hero", "video"]]),
    new Set(["asset_hero"]),
  );
  assert.equal(listed.longForm, true);
  // The chapters themselves stay with the asset; the intake writes them.
  assert.equal(JSON.stringify(listed).includes("chapters"), false);
});

test("only assets one of the accounts' platforms may carry, in id order", () => {
  const listed = generatorAssetProjection(
    {
      version: 3,
      assets: [
        asset({ id: "asset_z", allowedChannels: ["linkedin"], disclosure: { linkedin: "none" } }),
        asset({ id: "asset_tiktok", allowedChannels: ["tiktok"], disclosure: { tiktok: "none" } }),
        asset({ id: "asset_a" }),
      ],
    },
    ["linkedin", "linkedin"],
  );
  assert.deepEqual(listed.map((entry) => entry.id), ["asset_a", "asset_z"]);
});

test("only assets some account could still post stay in the answer (2026-11-14: used cards grew it past the cap)", async () => {
  const { marketingAssetsSomeAccountCanUse } = await import("@/lib/marketingGeneratorContext");
  const listed = (id, overrides = {}) => ({
    id,
    allowedChannels: ["instagram"],
    altLocales: ["ko"],
    claimIds: [],
    validUntil: "2027-01-31",
    kind: "video",
    alt: { ko: "화면" },
    ...overrides,
  });
  const assets = [
    listed("used-by-both"),
    listed("used-by-one"),
    listed("fresh"),
    listed("no-file", { kind: null }),
    listed("english-only", { altLocales: ["en"], alt: { en: "screen" } }),
    listed("x-only", { allowedChannels: ["x"] }),
  ];
  const accounts = [
    { channel: "instagram", allowedLocales: ["ko"], usedAssetIds: ["used-by-both", "used-by-one"] },
    { channel: "instagram", allowedLocales: ["ko"], usedAssetIds: ["used-by-both"] },
    { channel: "threads", allowedLocales: ["en"], usedAssetIds: [] },
  ];
  assert.deepEqual(
    marketingAssetsSomeAccountCanUse(assets, accounts).map((asset) => asset.id),
    ["used-by-one", "fresh"],
  );
  // No account, nothing to offer.
  assert.deepEqual(marketingAssetsSomeAccountCanUse(assets, []), []);
});

test("each asset's earlier texts are bounded per locale, cut short and capped in all (owner decision 2026-11-06)", async () => {
  const {
    marketingPublishedCopies,
    MARKETING_PUBLISHED_COPIES_MAX_BYTES,
    MARKETING_PUBLISHED_COPY_MAX_CHARS,
  } = await import("@/lib/marketingGeneratorContext");
  const post = (assetIds, locale, renderedText) => ({ assetIds, locale, envelope: { renderedText } });
  const copies = marketingPublishedCopies([
    post(["card"], "en", "newest en"),
    post(["card"], "en", "second en"),
    post(["card"], "en", "third en is dropped"),
    post(["card"], "ko", "x".repeat(MARKETING_PUBLISHED_COPY_MAX_CHARS + 50)),
    post(["card"], "en", "   "),
    { assetIds: ["short"], locale: "en", envelope: null },
  ]);
  assert.deepEqual(copies.get("card"), [
    { locale: "en", text: "newest en" },
    { locale: "en", text: "second en" },
    { locale: "ko", text: "x".repeat(MARKETING_PUBLISHED_COPY_MAX_CHARS) },
  ]);
  assert.equal(copies.has("short"), false);

  // Korean is three bytes a character: the byte budget, not a count, bounds the answer.
  const many = marketingPublishedCopies(
    Array.from({ length: 200 }, (_, index) => post([`asset-${index}`], "ko", "가".repeat(MARKETING_PUBLISHED_COPY_MAX_CHARS))),
  );
  const kept = [...many.values()].flat();
  const keptBytes = kept.reduce((sum, copy) => sum + Buffer.byteLength(copy.text, "utf8"), 0);
  assert.ok(keptBytes <= MARKETING_PUBLISHED_COPIES_MAX_BYTES);
  assert.equal(kept.length, Math.floor(MARKETING_PUBLISHED_COPIES_MAX_BYTES / (MARKETING_PUBLISHED_COPY_MAX_CHARS * 3)));
});
