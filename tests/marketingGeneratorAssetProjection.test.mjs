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

test("an asset is listed by what a draft may name, without its prose, provenance or disclosure", () => {
  const [listed] = generatorAssetProjection({ version: 3, assets: [asset()] }, ["linkedin"]);
  assert.deepEqual(listed, {
    id: "asset_hero",
    allowedChannels: ["linkedin"],
    altLocales: ["en", "ko"],
    claimIds: ["claim_compare"],
    validUntil: "2027-01-31",
  });
  assert.equal(JSON.stringify(listed).includes("comparison view"), false, "no alt text");
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
