import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  imageDownloadContentDisposition,
  imageDownloadExtension,
  imageDownloadFilename,
  imageDownloadSlug,
  UNKNOWN_IMAGE_EXTENSION,
} from "../lib/imageAssetDownload.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the extension comes from the recorded mime type, not from the R2 key", () => {
  // imageAssetR2Key() names every original `original.png`, and the providers
  // do not all return PNG: lib/imageProviderAdapter.ts parses whatever the
  // response declared. A JPEG saved as `.png` is the version of this bug that
  // survives a correct Content-Disposition.
  assert.equal(imageDownloadExtension("image/png"), "png");
  assert.equal(imageDownloadExtension("image/jpeg"), "jpg");
  assert.equal(imageDownloadExtension("image/jpg"), "jpg");
  assert.equal(imageDownloadExtension("image/webp"), "webp");
});

test("mime type parameters and casing do not change the extension", () => {
  assert.equal(imageDownloadExtension("IMAGE/PNG"), "png");
  assert.equal(imageDownloadExtension(" image/jpeg ; charset=binary "), "jpg");
});

test("an unrecognised image type keeps its own subtype rather than guessing PNG", () => {
  assert.equal(imageDownloadExtension("image/heic"), "heic");
  assert.equal(imageDownloadExtension("image/avif"), "avif");
});

test("anything that is not a plain image subtype yields a name that looks unsure", () => {
  for (const mimeType of [
    "image/svg+xml",
    "application/octet-stream",
    "text/plain",
    "image/",
    "",
    "nonsense",
  ]) {
    assert.equal(
      imageDownloadExtension(mimeType),
      UNKNOWN_IMAGE_EXTENSION,
      `${mimeType || "(empty)"} must not be named as though its format were known.`
    );
  }
});

test("a model id becomes a filename segment, not a path", () => {
  assert.equal(imageDownloadSlug("openai/gpt-image-1"), "openai-gpt-image-1");
  assert.equal(imageDownloadSlug("black-forest-labs/FLUX.1 [pro]"), "black-forest-labs-flux-1-pro");
  assert.equal(imageDownloadSlug("../../etc/passwd"), "etc-passwd");
  assert.equal(imageDownloadSlug(""), "");
});

test("the filename identifies which model made which image", () => {
  // A comparison downloads several images of one prompt at one size. Without
  // the id the browser resolves the collision with `(1)`, and without the
  // model nobody can tell the results apart afterwards.
  assert.equal(
    imageDownloadFilename({
      generationId: "cmsu7sd50003g02rzl9k1a2b3",
      modelId: "openai/gpt-image-1",
      mimeType: "image/png",
    }),
    "tomverse-openai-gpt-image-1-cmsu7sd50003g02rzl9k1a2b3.png"
  );
});

test("a filename survives a missing model id and an unusual generation id", () => {
  assert.equal(
    imageDownloadFilename({ generationId: "abc123", modelId: null, mimeType: "image/jpeg" }),
    "tomverse-abc123.jpg"
  );
  assert.equal(
    imageDownloadFilename({ generationId: "///", modelId: "", mimeType: "image/webp" }),
    "tomverse-image.webp"
  );
});

test("every filename this builds is safe in a quoted Content-Disposition", () => {
  const filename = imageDownloadFilename({
    generationId: '../"; rm -rf /',
    modelId: "프로바이더/모델 이름",
    mimeType: "image/png",
  });
  // Only `[a-z0-9-.]`: no quote to close the field early, no separator to
  // start a second one, and nothing non-ASCII that would need RFC 5987's
  // `filename*` to travel.
  assert.match(filename, /^[a-z0-9.-]+$/);
  assert.equal(
    imageDownloadContentDisposition(filename),
    `attachment; filename="${filename}"`
  );
});

test("the disposition asks for a download rather than describing the bytes", () => {
  // Content-Type says what it is; only this says what to do with it. The
  // original bug was a correct image/png with no disposition at all, which the
  // browser correctly rendered.
  assert.ok(
    imageDownloadContentDisposition("tomverse-x.png").startsWith("attachment;")
  );
});

test("the workspace saves through the application's own origin, never an `<a download>` on a signed URL", () => {
  const source = read("components/images/ImageGenerationWorkspace.tsx");
  // `download` is same-origin-only. The asset URLs are R2's, so the attribute
  // was ignored and the browser navigated to the image -- the reported bug.
  assert.ok(
    !/href=\{original\.url\}\s*\n\s*download/.test(source),
    "The download control must not be an `<a download>` pointing at a cross-origin signed URL."
  );
  assert.ok(
    source.includes("/download`"),
    "The download control must call the same-origin download route."
  );
  assert.ok(
    source.includes("saveResponseAsFile"),
    "The response must be saved from the page, so a refusal stays on the page (lib/browserDownload.ts)."
  );
});

test("the download route answers with an attachment disposition and refuses to sniff", () => {
  const source = read("app/api/images/generations/[generationId]/download/route.ts");
  assert.ok(source.includes("imageDownloadContentDisposition"));
  assert.ok(source.includes('"X-Content-Type-Options": "nosniff"'));
  assert.ok(source.includes('"Cache-Control": "private, no-store"'));
  // Ownership belongs in the lookup: a `findUnique` followed by a comparison
  // has a branch that can leak "exists but not yours".
  assert.ok(
    source.includes("where: { id: generationId, userId }"),
    "The generation lookup must be scoped by userId."
  );
  // readR2Object() deletes an object whose metadata disagrees with the
  // caller's claim. The user paid for this image.
  assert.ok(
    source.includes("readOwnR2ObjectBytes") && !source.includes("readR2Object("),
    "The download must read through the non-destructive path."
  );
});
