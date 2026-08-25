// Naming and headers for "save this generated image as a file".
//
// ## Why this is a module and not two lines in the route
//
// The bug it exists to end is not a header that was missing; it is two
// separate assumptions that were only ever written down once each, in places
// that could not see one another.
//
// The first is the extension. `imageAssetR2Key()` names every original
// `original.png` regardless of what the provider actually returned, and the
// providers do not all return PNG -- `lib/imageProviderAdapter.ts` parses
// `image/jpeg` and `image/webp` too, and `lib/imageDimensions.ts` accepts all
// three. The key is a storage path and a fixed suffix there is harmless; the
// same string used as a *filename* tells the user's operating system a JPEG is
// a PNG. So the name is derived from the mime type the row recorded, never
// from the key.
//
// The second is the disposition. A generated image lives in R2 and used to be
// handed to the browser as a signed cross-origin URL behind an `<a download>`.
// The `download` attribute is same-origin-only, so the browser ignored it,
// followed the link, saw `Content-Type: image/png` and did the correct thing
// with a correct image: it rendered it. Nothing was misconfigured. Naming the
// file and asking for it as an attachment are the same decision, so they are
// made in the same place.
//
// Pure on purpose: the download route builds the real name here, and the
// workspace builds the fallback name here too, so the two cannot drift.

/**
 * Extensions this application is prepared to name.
 *
 * `image/jpeg` becomes `jpg` rather than `jpeg` because that is what the
 * platforms these files land on write themselves.
 */
const EXTENSION_BY_MIME_TYPE: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

/** Last resort when the recorded type says nothing usable about the bytes. */
export const UNKNOWN_IMAGE_EXTENSION = "bin";

const normalizeMimeType = (value: string) =>
  String(value ?? "")
    // Parameters (`; charset=...`) are not part of the type.
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();

/**
 * The extension for a stored asset's recorded mime type.
 *
 * An unrecognised `image/*` type falls back to its own subtype rather than to
 * PNG: guessing a format the bytes are not is how the current filename got
 * wrong, and `image/heic` named `heic` is right for the same reason
 * `image/jpeg` named `png` is wrong. A subtype that is not a plain word (a
 * structured suffix such as `svg+xml`, or anything with punctuation) yields
 * `bin`, because a name this function is not sure of should look unsure.
 */
export const imageDownloadExtension = (mimeType: string): string => {
  const normalized = normalizeMimeType(mimeType);
  const known = EXTENSION_BY_MIME_TYPE[normalized];
  if (known) return known;

  const [type, subtype] = normalized.split("/", 2);
  if (type !== "image" || !subtype) return UNKNOWN_IMAGE_EXTENSION;
  return /^[a-z0-9]{1,8}$/.test(subtype) ? subtype : UNKNOWN_IMAGE_EXTENSION;
};

/**
 * A model id reduced to something an operating system will accept verbatim.
 *
 * Model ids carry a provider segment (`openai/gpt-image-1`), and a `/` in a
 * filename is a path. Everything outside `[a-z0-9]` collapses to a single
 * hyphen so the result is ASCII, lowercase and free of the characters Windows
 * reserves -- no quoting, no percent-encoding, no `filename*` needed.
 */
export const imageDownloadSlug = (value: string, maxLength = 40): string =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");

/**
 * The name one generated image is saved under.
 *
 * The generation id is in the name because a comparison downloads several
 * images of the same prompt at the same size, and a browser resolving that
 * collision by appending `(1)` would leave the user with files that no longer
 * say which model made which. The model slug is there so they do not have to
 * open them to find out. The prompt is deliberately absent: it is arbitrary
 * user text of arbitrary length in arbitrary scripts, and every problem this
 * function avoids would come back with it.
 */
export const imageDownloadFilename = (input: {
  generationId: string;
  modelId?: string | null;
  mimeType: string;
}): string => {
  const slug = imageDownloadSlug(input.modelId ?? "");
  const id = imageDownloadSlug(input.generationId, 32) || "image";
  const extension = imageDownloadExtension(input.mimeType);
  return `tomverse-${slug ? `${slug}-` : ""}${id}.${extension}`;
};

/**
 * `Content-Disposition` for a generated image download.
 *
 * One field, not the two `artifactContentDisposition()` emits, because the
 * name here is generated rather than user-supplied: `imageDownloadSlug()`
 * leaves only `[a-z0-9-]`, so there is no non-ASCII for RFC 5987's `filename*`
 * to carry and no quote for the quoted form to trip over.
 */
export const imageDownloadContentDisposition = (filename: string): string =>
  `attachment; filename="${filename}"`;
