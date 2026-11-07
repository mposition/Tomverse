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
  transcript: { en: "Ask three models at once and compare their answers side by side." },
  ...overrides,
});

const parses = (value) => marketingAssetSubmissionSchema.safeParse(value).success;

test("a capture video announced with its bytes, type and length is a submission", () => {
  assert.equal(parses(submission()), true);
  assert.equal(parses(submission({ kind: "image", contentType: "image/png", bytes: 400_000, durationSeconds: null })), true);
  // An image may say nothing.
  assert.equal(
    parses(submission({ kind: "image", contentType: "image/png", bytes: 400_000, durationSeconds: null, transcript: undefined })),
    true,
  );
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

test("a video says what it says in at least one locale, each at most 20,000 characters", () => {
  assert.equal(parses(submission({ transcript: undefined })), false);
  assert.equal(parses(submission({ transcript: {} })), false);
  assert.equal(parses(submission({ transcript: { en: "   " } })), false);
  assert.equal(parses(submission({ transcript: { fr: "Bonjour." } })), false);
  assert.equal(parses(submission({ transcript: { en: "a".repeat(20_000), ko: "가".repeat(20_000) } })), true);
  assert.equal(parses(submission({ transcript: { en: "a".repeat(20_001) } })), false);
});

test("a long video may carry YouTube chapters, checked against its length and its alt locales (owner decision 2026-11-07)", () => {
  const chapters = [
    { startSeconds: 0, title: { en: "What you will build" } },
    { startSeconds: 42, title: { en: "Ask three models" } },
    { startSeconds: 128, title: { en: "Compare the answers" } },
  ];
  const tutorial = (overrides = {}) => submission({ durationSeconds: 300, chapters, ...overrides });
  assert.equal(parses(tutorial()), true);
  // Absent is no chapters; the field is optional and an explicit null is not a list.
  assert.equal(parses(submission()), true);
  assert.equal(parses(tutorial({ chapters: null })), false);
  // The last section runs to the video's end and needs ten seconds too.
  assert.equal(parses(tutorial({ durationSeconds: 138 })), true);
  assert.equal(parses(tutorial({ durationSeconds: 137 })), false);
  // YouTube's rules: three or more, 0 first, ascending by ten seconds or more.
  assert.equal(parses(tutorial({ chapters: chapters.slice(0, 2) })), false);
  assert.equal(parses(tutorial({ chapters: [{ ...chapters[0], startSeconds: 5 }, ...chapters.slice(1)] })), false);
  assert.equal(parses(tutorial({ chapters: [chapters[0], { ...chapters[1], startSeconds: 9 }, chapters[2]] })), false);
  // A title per alt locale: this asset is posted in en only; a ko alt text needs ko titles.
  assert.equal(parses(tutorial({ asset: { ...submission().asset, alt: { en: "A tour.", ko: "둘러보기." } } })), false);
  // Known locales only, one line, with a length limit.
  assert.equal(parses(tutorial({ chapters: [{ ...chapters[0], title: { en: "Intro", fr: "Intro" } }, ...chapters.slice(1)] })), false);
  assert.equal(parses(tutorial({ chapters: [{ ...chapters[0], title: { en: "a".repeat(61) } }, ...chapters.slice(1)] })), false);
  assert.equal(parses(tutorial({ chapters: [{ ...chapters[0], title: { en: "Intro\n00:05 Fake" } }, ...chapters.slice(1)] })), false);
  // A field the chapter does not have is refused, not ignored.
  assert.equal(parses(tutorial({ chapters: [{ ...chapters[0], endSeconds: 42 }, ...chapters.slice(1)] })), false);
  // An image has no chapters.
  assert.equal(
    parses(submission({ kind: "image", contentType: "image/png", bytes: 400_000, durationSeconds: null, chapters })),
    false,
  );
});
