// What a client is allowed to learn about a stored image asset.
//
// Pure and separate from lib/imageGenerationRead.ts, which is server-only and
// pulls in Prisma and the S3 client, so the one rule that matters here can be
// tested without either: the row carries an `r2Key` and the payload carries a
// signed `url`, and no edit may turn the first into the second by spreading the
// row. A raw key is a storage path into a bucket the user has no business
// naming; the contract calls leaking one a release blocker, and until now
// nothing checked it.
//
// The URLs this mints are short-lived on purpose (IMAGE_ASSET_URL_TTL_SECONDS)
// and must never be persisted client-side -- a stored URL is a broken image
// once it expires, and a stored *list* of them is a cache nobody invalidates.

export type StoredImageAssetRow = {
  role: string;
  r2Key: string;
  mimeType: string;
};

export type ImageAssetPayload = {
  role: string;
  mimeType: string;
  url: string;
};

/**
 * Assets for one generation, as the client sees them.
 *
 * `mintUrl` is injected rather than imported so this stays testable, and so
 * that the only way to produce a payload is to have gone through it: there is
 * no branch here that emits an asset without minting a URL for it.
 *
 * Anything other than a succeeded generation yields nothing. A failed run can
 * still have a partially written original behind it, and handing out a URL to
 * half an object is worse than admitting there is no image -- the user paid for
 * a picture, and a truncated one looks like the product misbehaving rather than
 * like the failure it is.
 */
export const serializeImageAssets = async (
  status: string,
  assets: readonly StoredImageAssetRow[],
  mintUrl: (r2Key: string) => Promise<string>
): Promise<ImageAssetPayload[]> => {
  if (status !== "succeeded") return [];
  return Promise.all(
    assets.map(async (asset) => ({
      role: asset.role,
      mimeType: asset.mimeType,
      url: await mintUrl(asset.r2Key),
    }))
  );
};
