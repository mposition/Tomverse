// `capture_with_ai_presenter` (owner decision 2026-11-07): a video whose
// product screens are real captures and whose only AI part is a human
// presenter. It is of AI origin, so it is disclosed everywhere and YouTube is
// told it contains synthetic media; it is the one AI origin that may depict the
// product interface; and it is a video's provenance only.
//
// Contract: docs/policy/marketing-automation.md §7.3. The database repeats
// these rules (prisma/migrations/20261107130000_marketing_asset_ai_presenter_provenance,
// tests/integration/marketing-asset-store.db.test.ts).

import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_ORIGIN_PROVENANCES,
  AI_PRESENTER_PROVENANCE,
  MARKETING_ASSET_PROVENANCES,
  isAiOriginProvenance,
  loadMarketingAssetRegistry,
  marketingAssetRegistrySchema,
  marketingAssetSchema,
  resolveMarketingAsset,
} from "../lib/marketingAssets.ts";
import { marketingAssetSubmissionSchema } from "../lib/marketingAssetSubmission.ts";
import { zernioPlatformFields } from "../lib/zernioPublishAdapter.ts";

const presenterAsset = (overrides = {}) => ({
  id: "media-20261107-review-manual",
  provenance: "capture_with_ai_presenter",
  allowedChannels: ["youtube"],
  alt: { en: "The Tomverse founder's AI avatar introduces a screen recording of Review." },
  claimIds: [],
  validUntil: "2099-01-31",
  disclosure: { youtube: "platform_label_and_caption" },
  depictsProductInterface: true,
  ...overrides,
});

const submission = (overrides = {}, asset = {}) => ({
  asset: presenterAsset(asset),
  kind: "video",
  contentType: "video/mp4",
  bytes: 240_000_000,
  sha256: "c".repeat(64),
  durationSeconds: 420,
  transcript: { en: "Hi, I am an AI avatar of the Tomverse founder. Here is how Review works." },
  ...overrides,
});

const parses = (schema, value) => schema.safeParse(value).success;
const anImage = { kind: "image", contentType: "image/png", bytes: 400_000, durationSeconds: null };

test("the presenter provenance is a provenance, and an AI origin", () => {
  assert.equal(AI_PRESENTER_PROVENANCE, "capture_with_ai_presenter");
  assert.ok(MARKETING_ASSET_PROVENANCES.includes(AI_PRESENTER_PROVENANCE));
  assert.ok(AI_ORIGIN_PROVENANCES.includes(AI_PRESENTER_PROVENANCE));
  assert.equal(isAiOriginProvenance(AI_PRESENTER_PROVENANCE), true);
  for (const provenance of ["ai_generated", "ai_modified"]) assert.equal(isAiOriginProvenance(provenance), true);
  for (const provenance of ["capture", "operator_upload", "not_a_provenance"]) {
    assert.equal(isAiOriginProvenance(provenance), false, provenance);
  }
});

test("a captured video with an AI presenter may show the product interface", () => {
  assert.equal(parses(marketingAssetSchema, presenterAsset()), true);
  assert.equal(parses(marketingAssetSubmissionSchema, submission()), true);
  // It need not show the product either.
  assert.equal(parses(marketingAssetSubmissionSchema, submission({}, { depictsProductInterface: false })), true);
});

test("AI-made screens are still refused: ai_generated and ai_modified may not show the product", () => {
  for (const provenance of ["ai_generated", "ai_modified"]) {
    assert.equal(
      parses(marketingAssetSchema, presenterAsset({ provenance })),
      false,
      `${provenance} must not claim to show the product`,
    );
    assert.equal(
      parses(marketingAssetSubmissionSchema, submission({}, { provenance })),
      false,
      `${provenance} video showing the product`,
    );
    // The same assets without the product interface are the ordinary AI case.
    assert.equal(parses(marketingAssetSchema, presenterAsset({ provenance, depictsProductInterface: false })), true);
  }
});

test("the presenter provenance is a video's: an image is refused whether or not it shows the product", () => {
  assert.equal(parses(marketingAssetSubmissionSchema, submission(anImage)), false);
  assert.equal(
    parses(marketingAssetSubmissionSchema, submission(anImage, { depictsProductInterface: false })),
    false,
  );
  // The same image as a capture is an ordinary submission, so the kind is what refuses it.
  assert.equal(parses(marketingAssetSubmissionSchema, submission(anImage, { provenance: "capture" })), true);
});

test("an AI presenter is disclosed on every channel it may appear on", () => {
  assert.equal(
    parses(marketingAssetSchema, presenterAsset({ disclosure: { youtube: "none" } })),
    false,
    "`none` for an AI presenter is the platform's rule broken silently",
  );
  assert.equal(
    parses(
      marketingAssetSchema,
      presenterAsset({ allowedChannels: ["youtube", "linkedin"], disclosure: { youtube: "platform_label", linkedin: "none" } }),
    ),
    false,
  );
  assert.equal(
    parses(
      marketingAssetSchema,
      presenterAsset({
        allowedChannels: ["youtube", "linkedin"],
        disclosure: { youtube: "platform_label", linkedin: "caption_disclosure" },
      }),
    ),
    true,
  );
  assert.equal(parses(marketingAssetSubmissionSchema, submission({}, { disclosure: { youtube: "none" } })), false);
});

test("YouTube is told a presenter video contains synthetic media", () => {
  const fields = zernioPlatformFields(
    "youtube",
    "How Review works\nA walkthrough of Review in Tomverse.",
    [{ type: "video" }],
    isAiOriginProvenance(AI_PRESENTER_PROVENANCE),
  );
  assert.equal("refused" in fields, false);
  assert.equal(fields.data.containsSyntheticMedia, true);
  // And a plain capture is not.
  const capture = zernioPlatformFields(
    "youtube",
    "How Review works\nA walkthrough of Review in Tomverse.",
    [{ type: "video" }],
    isAiOriginProvenance("capture"),
  );
  assert.equal(capture.data.containsSyntheticMedia, false);
});

test("a loaded presenter asset cannot have its provenance or interface flag changed afterwards", () => {
  // The presenter value is the one AI origin allowed to show the product.
  // Setting a checked one to `ai_generated` after parsing would carry a
  // model-made interface past the rule that refuses one; setting it to
  // `capture` would make its presenter read as not of AI origin.
  const loaded = loadMarketingAssetRegistry({ version: 1, assets: [presenterAsset()] });
  const [asset] = loaded.assets;
  assert.equal(Object.isFrozen(asset), true);
  assert.equal(Object.isFrozen(asset.disclosure), true);

  for (const provenance of ["ai_generated", "ai_modified", "capture"]) {
    assert.throws(
      () => {
        "use strict";
        asset.provenance = provenance;
      },
      TypeError,
      provenance,
    );
  }
  assert.throws(
    () => {
      "use strict";
      asset.disclosure.youtube = "none";
    },
    TypeError,
  );
  assert.equal(asset.provenance, "capture_with_ai_presenter");
  assert.equal(asset.depictsProductInterface, true);

  const on = new Date("2026-11-07T00:00:00.000Z");
  assert.deepEqual(
    resolveMarketingAsset({ id: asset.id, channel: "youtube", locale: "en", on, registry: loaded }),
    { ok: true, asset, disclosure: "platform_label_and_caption" },
  );

  // A parsed but unloaded registry, and a copy of the loaded one carrying an
  // AI-made interface, are both refused before any rule is trusted.
  const parsed = marketingAssetRegistrySchema.parse({ version: 1, assets: [presenterAsset()] });
  const forged = Object.freeze({ ...loaded, assets: [{ ...presenterAsset(), provenance: "ai_generated" }] });
  for (const registry of [parsed, forged]) {
    assert.deepEqual(
      resolveMarketingAsset({ id: asset.id, channel: "youtube", locale: "en", on, registry }),
      { ok: false, refusal: "registry_not_loaded" },
    );
  }
});
