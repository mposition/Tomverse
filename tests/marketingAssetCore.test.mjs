import assert from "node:assert/strict";
import test from "node:test";

import { MARKETING_ASSET_ID, marketingAssetR2Key } from "@/lib/marketingAssetCore";
import { marketingAssetSubmissionSchema } from "@/lib/marketingAssetSubmission";

const SHA = "a".repeat(64);

const submission = (overrides = {}, asset = {}) => ({
  asset: {
    id: "media-20261031-compare-three",
    provenance: "capture",
    allowedChannels: ["youtube", "instagram"],
    alt: { en: "Three answers side by side in Tomverse." },
    claimIds: [],
    validUntil: "2027-01-31",
    disclosure: { youtube: "none", instagram: "none" },
    depictsProductInterface: true,
    ...asset,
  },
  kind: "video",
  contentType: "video/mp4",
  bytes: 12_000_000,
  sha256: SHA,
  durationSeconds: 45,
  ...overrides,
});

const parses = (value) => marketingAssetSubmissionSchema.safeParse(value).success;

test("a capture video announced with its bytes, type and length is a submission", () => {
  assert.equal(parses(submission()), true);
  assert.equal(parses(submission({ kind: "image", contentType: "image/png", bytes: 400_000, durationSeconds: null })), true);
});

test("the registry's own rules hold for a stored asset: AI origin cannot show the product, and is never undisclosed", () => {
  // A model-made picture of a screen is not a picture of the product (policy 7.3).
  assert.equal(parses(submission({}, { provenance: "ai_generated" })), false);
  assert.equal(
    parses(submission({}, { provenance: "ai_generated", depictsProductInterface: false })),
    false,
    "an AI asset with a `none` disclosure",
  );
  assert.equal(
    parses(
      submission({}, {
        provenance: "ai_generated",
        depictsProductInterface: false,
        disclosure: { youtube: "platform_label", instagram: "platform_label" },
      }),
    ),
    true,
  );
  // Every allowed channel has a decision, and only those.
  assert.equal(parses(submission({}, { disclosure: { youtube: "none" } })), false);
});

test("the file is what its kind allows: type, size, and a length only for a video", () => {
  assert.equal(parses(submission({ contentType: "image/png" })), false);
  assert.equal(parses(submission({ bytes: 1024 * 1024 * 1024 + 1 })), false);
  assert.equal(parses(submission({ durationSeconds: null })), false);
  assert.equal(parses(submission({ durationSeconds: 3_601 })), false);
  assert.equal(parses(submission({ kind: "image", contentType: "image/png", bytes: 21 * 1024 * 1024, durationSeconds: null })), false);
  assert.equal(parses(submission({ kind: "image", contentType: "image/png", bytes: 1_000, durationSeconds: 3 })), false);
  assert.equal(parses(submission({ sha256: "A".repeat(64) })), false);
  assert.equal(parses({ ...submission(), extra: true }), false);
});

test("a stored asset's id cannot be one the hand-kept registry would use", () => {
  for (const id of ["asset.hero", "media-UPPER", "media-", "media_x", "hero-media-1"]) {
    assert.equal(MARKETING_ASSET_ID.test(id), false, id);
    assert.equal(parses(submission({}, { id })), false, id);
  }
  assert.equal(MARKETING_ASSET_ID.test("media-20261031-a"), true);
});

test("each asset has one object key, under its own prefix, with its type's extension", () => {
  assert.equal(marketingAssetR2Key("media-a", "video", "video/mp4"), "marketing-assets/media-a/original.mp4");
  assert.equal(marketingAssetR2Key("media-a", "video", "video/quicktime"), "marketing-assets/media-a/original.mov");
  assert.equal(marketingAssetR2Key("media-b", "image", "image/jpeg"), "marketing-assets/media-b/original.jpg");
});
