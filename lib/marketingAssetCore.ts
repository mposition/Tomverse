/**
 * The media asset store's shapes and rules, pure (operator decision
 * 2026-10-31: images and videos are made by the media CLI on the AMUX box and
 * submitted to the app; the app keeps the Guard, a person's approval and the
 * publishing).
 *
 * An asset row says what the file is and where it came from, in the same terms
 * as the hand-kept registry (`lib/marketingAssets.ts`): provenance, the
 * channels it may appear on with each one's disclosure decision, alt text per
 * locale. The database repeats the rules
 * (prisma/migrations/20261031120000_marketing_asset_store); these let a route
 * refuse a bad request before it reaches a transaction. No local import, so an
 * Admin route may read its constants and its error class without reaching the
 * store (tests/marketingS2b1Store.test.mjs); the submission schema is in
 * lib/marketingAssetSubmission.ts.
 */

/** The audit actions an asset change is recorded under. */
export const MARKETING_ASSET_ACTIONS = {
  submitted: "marketing_asset.submitted",
  approved: "marketing_asset.approved",
  retired: "marketing_asset.retired",
} as const;

/** What a decision's audit row records as its predecessor when there is none. */
export const MARKETING_ASSET_NO_DECISION = ":none";

export const MARKETING_ASSET_KINDS = ["image", "video"] as const;
export type MarketingAssetKind = (typeof MARKETING_ASSET_KINDS)[number];

/**
 * Where an asset stands. `submitted` is a file announced and perhaps uploaded,
 * trusted for nothing; `approved` is one a person looked at, which the Guard and
 * the publisher may use; `retired` is withdrawn (or never approved), kept so
 * the posts that carried it still name a row.
 */
export const MARKETING_ASSET_STATUSES = ["submitted", "approved", "retired"] as const;
export type MarketingAssetStatus = (typeof MARKETING_ASSET_STATUSES)[number];

/** The file types each kind accepts, and the extension its object key takes. */
export const MARKETING_ASSET_CONTENT_TYPES: Readonly<Record<MarketingAssetKind, Readonly<Record<string, string>>>> = {
  image: { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" },
  video: { "video/mp4": "mp4", "video/quicktime": "mov" },
};

/** The largest file of each kind, in bytes. */
export const MARKETING_ASSET_MAX_BYTES: Readonly<Record<MarketingAssetKind, number>> = {
  image: 20 * 1024 * 1024,
  video: 1024 * 1024 * 1024,
};

/** The longest transcript per locale, in characters: an eight-minute video's narration and screen text. */
export const MARKETING_ASSET_MAX_TRANSCRIPT_CHARS = 20_000;

/** The longest video, in seconds: a YouTube long-form piece, not a stream. */
export const MARKETING_ASSET_MAX_VIDEO_SECONDS = 3_600;

/**
 * A stored asset's id. A registry id, with a prefix the hand-kept file never
 * uses, so the two lists cannot name one asset twice.
 */
export const MARKETING_ASSET_ID = /^media-[a-z0-9][a-z0-9-]{0,99}$/u;

/** The R2 prefix every stored asset lives under. */
export const MARKETING_ASSET_KEY_PREFIX = "marketing-assets/";

/** How long an Admin preview URL stays valid. */
export const MARKETING_ASSET_PREVIEW_URL_SECONDS = 300;

/**
 * The largest submission body, in bytes: metadata and the transcript, never the
 * file. Four locales of 20,000 characters, at three bytes a CJK character, with room.
 */
export const MARKETING_ASSET_MAX_BODY_BYTES = 512 * 1024;

/**
 * The one object key a stored asset is kept and served from. Only the server
 * writes it, by copying a verified upload: no upload URL is ever signed for it.
 */
export const marketingAssetR2Key = (id: string, kind: MarketingAssetKind, contentType: string): string =>
  `${MARKETING_ASSET_KEY_PREFIX}${id}/original.${MARKETING_ASSET_CONTENT_TYPES[kind][contentType]}`;

/**
 * Where the media CLI uploads a file before it is verified. An upload URL is
 * signed for this key only, so a URL still valid after the approval cannot
 * change the bytes a person approved.
 */
export const marketingAssetUploadKey = (id: string, kind: MarketingAssetKind, contentType: string): string =>
  `${MARKETING_ASSET_KEY_PREFIX}${id}/upload.${MARKETING_ASSET_CONTENT_TYPES[kind][contentType]}`;

/**
 * A store refusal, carrying the status a route answers it with. Its own class
 * for the competitor registry's reason: the route sweep lets a route's
 * `refusal` read an error but not call anything.
 */
export class MarketingAssetRefusedError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "MarketingAssetRefusedError";
    this.code = code;
    this.status = status;
  }
}
