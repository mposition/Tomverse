// `capture_with_ai_media` (owner decision 2026-11-09): a video whose product
// screens are real captures, unchanged, cut with model-made shots that show no
// product screen, a model-made voice and music -- the creative short job's
// films (tools/marketing-video/run-creative-short.mjs). Like the presenter
// provenance it is of AI origin, so it is disclosed everywhere and YouTube is
// told it contains synthetic media; it may depict the product interface; and
// it is a video's provenance only.
//
// Contract: docs/policy/marketing-automation.md §7.3. The database repeats
// these rules (prisma/migrations/20261109160000_marketing_asset_ai_media_provenance,
// tests/integration/marketing-asset-store.db.test.ts).

import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_CAPTURE_VIDEO_PROVENANCES,
  AI_MEDIA_PROVENANCE,
  AI_ORIGIN_PROVENANCES,
  AI_PRESENTER_PROVENANCE,
  MARKETING_ASSET_PROVENANCES,
  isAiCaptureVideoProvenance,
  isAiOriginProvenance,
  marketingAssetSchema,
} from "../lib/marketingAssets.ts";
import { marketingAssetSubmissionSchema } from "../lib/marketingAssetSubmission.ts";
import { zernioPlatformFields } from "../lib/zernioPublishAdapter.ts";

const mediaAsset = (overrides = {}) => ({
  id: "media-20261109-creative-review-en",
  provenance: "capture_with_ai_media",
  allowedChannels: ["youtube", "instagram"],
  alt: { en: "Real Tomverse Review screens cut with AI-made shots, an AI voice and music." },
  claimIds: [],
  validUntil: "2099-01-31",
  disclosure: { youtube: "platform_label_and_caption", instagram: "platform_label_and_caption" },
  depictsProductInterface: true,
  ...overrides,
});

const submission = (overrides = {}, asset = {}) => ({
  asset: mediaAsset(asset),
  kind: "video",
  contentType: "video/mp4",
  bytes: 30_000_000,
  sha256: "d".repeat(64),
  durationSeconds: 24,
  transcript: { en: "Three answers, one bill.\n\nscreen: Tomverse Review\n\nanswer words" },
  ...overrides,
});

const parses = (schema, value) => schema.safeParse(value).success;
const anImage = { kind: "image", contentType: "image/png", bytes: 400_000, durationSeconds: null };

test("the AI media provenance is a provenance, an AI origin, and one of the two that may show captures", () => {
  assert.equal(AI_MEDIA_PROVENANCE, "capture_with_ai_media");
  assert.ok(MARKETING_ASSET_PROVENANCES.includes(AI_MEDIA_PROVENANCE));
  assert.ok(AI_ORIGIN_PROVENANCES.includes(AI_MEDIA_PROVENANCE));
  assert.equal(isAiOriginProvenance(AI_MEDIA_PROVENANCE), true);
  assert.deepEqual([...AI_CAPTURE_VIDEO_PROVENANCES], [AI_PRESENTER_PROVENANCE, AI_MEDIA_PROVENANCE]);
  for (const provenance of AI_CAPTURE_VIDEO_PROVENANCES) assert.equal(isAiCaptureVideoProvenance(provenance), true);
  for (const provenance of ["capture", "operator_upload", "ai_generated", "ai_modified", "not_a_provenance"]) {
    assert.equal(isAiCaptureVideoProvenance(provenance), false, provenance);
  }
});

test("a captured video cut with AI media may show the product interface", () => {
  assert.equal(parses(marketingAssetSchema, mediaAsset()), true);
  assert.equal(parses(marketingAssetSubmissionSchema, submission()), true);
  assert.equal(parses(marketingAssetSubmissionSchema, submission({}, { depictsProductInterface: false })), true);
  // AI-made screens stay refused: ai_modified still may not show the product.
  assert.equal(parses(marketingAssetSubmissionSchema, submission({}, { provenance: "ai_modified" })), false);
});

test("the AI media provenance is a video's: an image is refused whether or not it shows the product", () => {
  assert.equal(parses(marketingAssetSubmissionSchema, submission(anImage)), false);
  assert.equal(parses(marketingAssetSubmissionSchema, submission(anImage, { depictsProductInterface: false })), false);
  assert.equal(parses(marketingAssetSubmissionSchema, submission(anImage, { provenance: "capture" })), true);
});

test("AI media is disclosed on every channel it may appear on", () => {
  assert.equal(
    parses(marketingAssetSchema, mediaAsset({ disclosure: { youtube: "platform_label", instagram: "none" } })),
    false,
  );
  assert.equal(parses(marketingAssetSubmissionSchema, submission({}, { disclosure: { youtube: "none", instagram: "none" } })), false);
});

test("YouTube is told an AI media video contains synthetic media", () => {
  const fields = zernioPlatformFields(
    "youtube",
    "Three answers, one bill\nReal Review screens with AI shots.",
    [{ type: "video" }],
    isAiOriginProvenance(AI_MEDIA_PROVENANCE),
  );
  assert.equal("refused" in fields, false);
  assert.equal(fields.data.containsSyntheticMedia, true);
});
