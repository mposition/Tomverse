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
  /**
   * When `url` stops working, as an ISO instant.
   *
   * Sent because the client has a decision to make with it. "Full size" is a
   * plain link to `url`, so once the signature lapses the click is a
   * navigation to an S3 error document -- the workspace gone, replaced by XML.
   * The card cannot tell that has happened by looking at the URL, and the
   * `<img>`'s own `onError` repair does not cover it: an image that loaded
   * while the URL was live keeps rendering from cache and never errors, so
   * nothing re-mints. Knowing the instant is what lets the workspace refuse
   * the click and say so instead.
   */
  urlExpiresAt: string;
};

/**
 * How long a minted asset URL lasts.
 *
 * Here rather than in lib/imageGenerationRead.ts, which is `server-only`, so
 * the workspace can state the same number it is actually being given. Two
 * copies of this -- one signing, one in a sentence on screen -- is a lie
 * waiting for the day somebody changes only the first.
 */
export const IMAGE_ASSET_URL_TTL_SECONDS = 300;

/** The TTL as the whole minutes the copy quotes. */
export const IMAGE_ASSET_URL_TTL_MINUTES = Math.round(
  IMAGE_ASSET_URL_TTL_SECONDS / 60
);

/**
 * Treat a URL as dead this long before it actually dies.
 *
 * A click at T-1s can still lose the race between the navigation and the
 * signature lapsing, and the two outcomes look nothing alike: one is the
 * image, the other is an error document where the workspace used to be.
 * Spending a needless refresh in the last few seconds of a five-minute window
 * is the cheaper mistake by a wide margin.
 */
export const IMAGE_ASSET_URL_EXPIRY_GUARD_MS = 5_000;

/**
 * Whether a minted URL should still be followed.
 *
 * A payload with no `urlExpiresAt` -- one held in a tab from before the field
 * existed -- reads as *not* expired. The field's job is to refuse a click that
 * is known to be dead; absence is not that knowledge, and refusing on absence
 * would break working links to protect against a guess.
 */
export const isImageAssetUrlExpired = (
  urlExpiresAt: string | null | undefined,
  nowMs: number
): boolean => {
  if (!urlExpiresAt) return false;
  const expiresAtMs = Date.parse(urlExpiresAt);
  if (!Number.isFinite(expiresAtMs)) return false;
  return nowMs + IMAGE_ASSET_URL_EXPIRY_GUARD_MS >= expiresAtMs;
};

/**
 * Assets for one generation, as the client sees them.
 *
 * `mintUrl` is injected rather than imported so this stays testable, and so
 * that the only way to produce a payload is to have gone through it: there is
 * no branch here that emits an asset without minting a URL for it.
 *
 * It returns the expiry alongside the URL rather than having this function
 * compute one, because only the minter knows what it signed. A URL and an
 * expiry that were decided in two different places are two facts that can
 * disagree, and the one the client would act on is the wrong one.
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
  mintUrl: (r2Key: string) => Promise<{ url: string; expiresAt: string }>
): Promise<ImageAssetPayload[]> => {
  if (status !== "succeeded") return [];
  return Promise.all(
    assets.map(async (asset) => {
      const minted = await mintUrl(asset.r2Key);
      return {
        role: asset.role,
        mimeType: asset.mimeType,
        url: minted.url,
        urlExpiresAt: minted.expiresAt,
      };
    })
  );
};
