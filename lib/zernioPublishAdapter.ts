import "server-only";

import type { MarketingChannel } from "@/lib/marketingAutomationSchema";
import type {
  MarketingAdapterCapabilities,
  MarketingAdapterHealth,
  MarketingHealthCapability,
  MarketingPublishAdapter,
  MarketingPublishRequest,
  MarketingPublishResult,
} from "@/lib/marketingPublishAdapter";
import {
  ZERNIO_API_BASE_URL,
  httpsUrl,
  zernioCall,
  zernioPostId,
  zernioRequestUuid,
  zernioStatusQuery,
  type ZernioPost,
} from "@/lib/zernioStatusQuery";

export { ZERNIO_API_BASE_URL, zernioRequestUuid };

/**
 * The Zernio adapter (S2 plan, S2d2, under amendment 4).
 *
 * ## It holds no credential of its own
 *
 * Everything it needs to authenticate arrives in `ZernioAdapterPorts`, from the
 * service that constructs it. Nothing in `lib/` may hold a marketing platform
 * credential, and nothing here reads `process.env`. The same goes for the bucket:
 * an asset id is resolved to a public URL by an injected port, so this file never
 * learns an object-store credential either.
 *
 * ## There is no lookup by our own key, and that is the whole shape of this file
 *
 * S2c's contract called `publish` and `lookupByRequestKey` two halves of one
 * guarantee: a request whose answer never arrived is settled by asking about the
 * exact key we sent. **Zernio cannot be asked that question.** Its idempotency for
 * `POST /v1/posts` is the `x-request-id` header, good for about five minutes, and
 * `GET /v1/posts` has no `metadata` filter -- `metadata` comes back on read but
 * cannot be queried on. The S0 verification record had already classified the
 * consequence blocking, twice, as C6 and C7; C7 *is* this lookup.
 *
 * Amendment 4 (approved 2026-09-28) takes option A: **do not pretend to look up.**
 * `lookupByRequestKey` answers that it cannot answer. The publisher then records
 * `outcome_unknown` and pauses the autonomous channel, which is failure in the
 * safe direction, and a person resolves the row. A dropped connection pausing an
 * account is the accepted cost.
 *
 * ## Two response shapes the S0 record warns about, and both are handled here
 *
 * - **207 is a 2xx.** Zernio returns 207 for a partial publish, so reading
 *   `response.ok` would file a half-published post as a success. It is never a
 *   success here.
 * - **200 is ambiguous.** The spec says a matching `x-request-id` replays with 200,
 *   *and* says elsewhere that 200 is always a TikTok dry-run verdict. The S0 record
 *   flags the contradiction as part of C6. So a 200 is not read as "already
 *   published by us": it is an unknown outcome, because the two readings have
 *   opposite consequences and nothing in the response distinguishes them.
 *
 * ## It never retries
 *
 * Not on 429, not on a timeout, not on a 5xx. The policy says never blind retry,
 * and the five-minute `x-request-id` window is not a licence to: the run deadline
 * is four minutes and the cron period five, so a retry would land near the edge of
 * that window with no way to tell a replay from a second public post.
 */

/** What the constructing service supplies. Nothing here is read from the process. */

export type ZernioResolvedAsset = {
  readonly url: string;
  readonly kind: "image" | "video";
  readonly aiOrigin: boolean;
};

export type ZernioAdapterPorts = {
  /** `sk_` + 64 hex, or a restricted `zrk_` key. Never logged, never returned. */
  readonly apiKey: string;
  /** The API origin, so a test can point this at a fixture server. */
  readonly baseUrl: string;
  /**
   * An approved asset id to what a post needs from it: a public HTTPS URL, its
   * kind, and whether it is of AI origin (`ai_generated` or `ai_modified`,
   * which YouTube must be told). Null for an id that is not an approved asset.
   *
   * A port because resolving one needs the object store, and this file may not
   * hold that credential either. Zernio accepts a public HTTPS URL directly as
   * `mediaItems[].url`, so no upload happens here.
   */
  readonly resolveAsset: (assetId: string) => Promise<ZernioResolvedAsset | null>;
  /** Wall-clock budget for one call. The caller owns the number. */
  readonly callBudgetMs: number;
  readonly fetch?: typeof fetch;
};

/** Closed codes. Provider prose never reaches a caller or a row. */
export const ZERNIO_ERROR_CODES = [
  "provider_unauthorized",
  "provider_rate_limited",
  "provider_rejected_content",
  "provider_duplicate_content",
  "provider_account_not_connected",
  "provider_bad_request",
  "provider_partial_publish",
  "provider_ambiguous_success",
  "provider_unavailable",
  "provider_timeout",
  "provider_unreadable_response",
  "no_lookup_by_request_key",
  "asset_unresolved",
  "youtube_needs_one_video",
  "youtube_title_invalid",
] as const;
export type ZernioErrorCode = (typeof ZERNIO_ERROR_CODES)[number];

/**
 * Our channels, as Zernio names them.
 *
 * `rednote` is absent because Zernio does not carry it -- that channel is posted
 * by hand, and an adapter that pretended otherwise would let the publisher claim
 * a slot it cannot fill.
 */
const PLATFORM_BY_CHANNEL: Partial<Record<MarketingChannel, string>> = {
  linkedin: "linkedin",
  threads: "threads",
  x: "twitter",
  facebook: "facebook",
  instagram: "instagram",
  youtube: "youtube",
  tiktok: "tiktok",
};

/**
 * The platforms `POST /v1/posts/{id}/unpublish` accepts, from the S0 record.
 *
 * **TikTok is not one of them**, and that is not a detail. Policy O15 lets a
 * channel reach autonomous mode only if a post can be retracted through the API,
 * and `capabilities().canRetract` is what the resolver reads to decide. Deriving
 * retraction from "can we publish here" would have reported TikTok as retractable
 * and opened autonomous posting to a channel whose mistakes cannot be taken back.
 *
 * So publishing and retracting are two lists, because they are two facts.
 */
const RETRACTABLE_PLATFORMS = new Set([
  "threads",
  "facebook",
  "twitter",
  "linkedin",
  "youtube",
  "pinterest",
  "reddit",
  "bluesky",
  "googlebusiness",
  "telegram",
]);




/** The longest title YouTube takes. */
const YOUTUBE_TITLE_MAX = 100;

/**
 * What each platform needs beyond the text and the media, in the fields the S0
 * probe sent and Zernio accepted (docs/ops/marketing-zernio-s0-plan.example.json).
 * Refused here, before anything leaves, when the post cannot be what was approved.
 *
 * - **YouTube** is one video with a title. The title is the post's first line
 *   and the description the rest, so the approved text is the whole of what is
 *   sent; a first line YouTube would refuse or cut is refused here instead.
 *   `madeForKids` is always false (the policy targets people 16 and over), and
 *   `containsSyntheticMedia` is true whenever an asset is of AI origin.
 * - **TikTok** takes the privacy and interaction choices, and the two
 *   attestations its posting rules ask for: the person who approved the post in
 *   Admin saw it and agreed to publish it.
 * - **Instagram** shares a video (a Reel) to the feed as well.
 */
export function zernioPlatformFields(
  platform: string,
  text: string,
  mediaItems: ReadonlyArray<{ readonly type: "image" | "video" }>,
  aiOrigin: boolean,
):
  | { readonly content: string; readonly data: Record<string, unknown> | null }
  | { readonly refused: ZernioErrorCode } {
  if (platform === "youtube") {
    if (mediaItems.length !== 1 || mediaItems[0]?.type !== "video") return { refused: "youtube_needs_one_video" };
    const [first, ...rest] = text.split("\n");
    const title = (first ?? "").trim();
    if (title === "" || title.length > YOUTUBE_TITLE_MAX || /[<>]/u.test(title)) {
      return { refused: "youtube_title_invalid" };
    }
    return {
      content: rest.join("\n").trim(),
      data: { title, visibility: "public", madeForKids: false, containsSyntheticMedia: aiOrigin },
    };
  }
  if (platform === "tiktok") {
    return {
      content: text,
      data: {
        privacyLevel: "PUBLIC_TO_EVERYONE",
        allowComment: true,
        allowDuet: false,
        allowStitch: false,
        contentPreviewConfirmed: true,
        expressConsentGiven: true,
      },
    };
  }
  if (platform === "instagram" && mediaItems.some((item) => item.type === "video")) {
    return { content: text, data: { shareToFeed: true } };
  }
  return { content: text, data: null };
}


export const zernioPublishAdapter = (
  ports: ZernioAdapterPorts,
): MarketingPublishAdapter => {
  const status = zernioStatusQuery(ports);
  const call = (path: string, init: { method: string; body?: unknown; requestKey?: string }) =>
    zernioCall(ports, path, init);

  /** A 4xx to a closed code. Provider prose is discarded, not forwarded. */
  const rejectionCode = (status: number): ZernioErrorCode => {
    if (status === 401 || status === 403) return "provider_unauthorized";
    if (status === 409) return "provider_duplicate_content";
    if (status === 422) return "provider_rejected_content";
    if (status === 429) return "provider_rate_limited";
    return "provider_bad_request";
  };

  return {
    provider: "zernio",

    async capabilities(channel: MarketingChannel): Promise<MarketingAdapterCapabilities> {
      // Read from the S0 verification record rather than probed: the record is
      // what an operator signed, and a probe would report today's behaviour as
      // though it were the contract. `canRetract` is what O15 turns on.
      const platform = PLATFORM_BY_CHANNEL[channel];
      return {
        // Two lists, because they are two facts: TikTok can be published to and
        // cannot be unpublished. O15 reads this to decide whether a channel may
        // ever run autonomously, so deriving it from the publish map would open
        // autonomous posting to a channel whose mistakes cannot be taken back.
        canRetract: platform !== undefined && RETRACTABLE_PLATFORMS.has(platform),
        canMonitorComments: platform !== undefined,
        // **The one that is false, and the reason this file is shaped as it is.**
        canLookupByRequestKey: false,
      };
    },

    async observeHealth(
      externalAccountRef: string,
      capability: MarketingHealthCapability,
    ): Promise<MarketingAdapterHealth> {
      // `GET /v1/accounts/{accountId}/health`, not the account itself: an
      // account row answers 200 whether or not its token is still valid or its
      // posting scope still granted, and the health endpoint is the one that
      // says. The earlier version read the account and called every 200
      // healthy.
      const result = await call(
        `/v1/accounts/${encodeURIComponent(externalAccountRef)}/health`,
        { method: "GET" },
      );
      if (result.kind === "unreachable") {
        return { capability, healthy: false, reason: result.code };
      }
      if (result.status === 200) {
        // Only the publish capability has a field that answers it. Comments
        // have none in this response, so they are not reported healthy on the
        // strength of a post permission.
        if (capability !== "publish") {
          return { capability, healthy: false, reason: "capability_not_reported" };
        }
        const body = result.body as {
          status?: unknown;
          tokenStatus?: { valid?: unknown } | null;
          permissions?: { canPost?: unknown } | null;
        } | null;
        // All three, each exactly: a missing field is not a yes.
        const healthy =
          body?.status === "healthy" &&
          body.tokenStatus?.valid === true &&
          body.permissions?.canPost === true;
        return healthy
          ? { capability, healthy: true, reason: null }
          : { capability, healthy: false, reason: "provider_reports_unhealthy" };
      }
      // A closed code, never the provider's sentence: a 401 says the token is
      // wrong, and the token is not part of saying so.
      return { capability, healthy: false, reason: rejectionCode(result.status) };
    },

    async publish(request: MarketingPublishRequest): Promise<MarketingPublishResult> {
      const platform = PLATFORM_BY_CHANNEL[request.channel];
      if (!platform) {
        return { outcome: "failed", errorCode: "provider_account_not_connected" };
      }

      // Assets become public HTTPS URLs through the injected port. An id that
      // cannot be resolved is a refusal *before* anything leaves: a post missing
      // its image is not the post that was approved.
      const mediaItems: Array<{ type: "image" | "video"; url: string }> = [];
      let aiOrigin = false;
      for (const assetId of request.assetIds) {
        const asset = await ports.resolveAsset(assetId);
        const url = httpsUrl(asset?.url);
        if (!asset || !url) return { outcome: "failed", errorCode: "asset_unresolved" };
        mediaItems.push({ type: asset.kind, url });
        aiOrigin ||= asset.aiOrigin;
      }

      const platformFields = zernioPlatformFields(platform, request.renderedText, mediaItems, aiOrigin);
      if ("refused" in platformFields) return { outcome: "failed", errorCode: platformFields.refused };

      const result = await call("/v1/posts", {
        method: "POST",
        requestKey: request.requestKey,
        body: {
          content: platformFields.content,
          platforms: [
            {
              platform,
              accountId: request.externalAccountRef,
              ...(platformFields.data ? { platformSpecificData: platformFields.data } : {}),
            },
          ],
          // Without this, or a `scheduledFor`, Zernio creates a draft (S0
          // record, "예약"): a 201 that publishes nothing. With it, publishing
          // happens in this request and the response carries each platform's
          // result.
          publishNow: true,
          ...(mediaItems.length > 0 ? { mediaItems } : {}),
          // Stored and returned on read and webhook. Recorded so a person
          // reconciling by hand can find our key -- **not** so this adapter can
          // query it, because `GET /v1/posts` cannot filter on it.
          metadata: { requestKey: request.requestKey, locale: request.locale },
        },
      });

      if (result.kind === "unreachable") {
        // The request may have been received. This is the state the whole
        // design turns on, and it is never retried.
        return { outcome: "outcome_unknown", errorCode: result.code };
      }

      // **207 is a 2xx and is not a success.** Reading `response.ok` here would
      // file a half-published post as published.
      if (result.status === 207) {
        return { outcome: "outcome_unknown", errorCode: "provider_partial_publish" };
      }

      // **200 is ambiguous.** The spec calls it an `x-request-id` replay in one
      // place and always a TikTok dry-run verdict in another; the S0 record flags
      // the contradiction as part of C6. The two readings have opposite
      // consequences and nothing in the body separates them.
      if (result.status === 200) {
        return { outcome: "outcome_unknown", errorCode: "provider_ambiguous_success" };
      }

      if (result.status >= 500) {
        return { outcome: "outcome_unknown", errorCode: "provider_unavailable" };
      }

      if (result.status !== 201) {
        // A 409 is content-hash duplication: some post with the same content and
        // media exists on that account within 24 hours. That is **not** "we
        // already published this", so `details.existingPostId` is an observation
        // for the audit entry and never becomes `externalPostId`.
        return { outcome: "failed", errorCode: rejectionCode(result.status) };
      }

      const post = (result.body as { post?: ZernioPost } | null)?.post ?? (result.body as ZernioPost | null);
      const entry = post?.platforms?.find((candidate) => candidate.platform === platform);
      // Zernio's id, because that is what a later status query or unpublish
      // must name; the platform's own id is not one Zernio's API takes.
      const externalPostId = zernioPostId(post);
      const externalUrl = httpsUrl(entry?.platformPostUrl ?? entry?.publishedUrl);
      // **A 201 is a creation, and published is a status.** Both the post and
      // this platform's entry must say `published`; a 201 carrying any other
      // status is not proof, and not a confirmed failure either.
      if (post?.status !== "published" || entry?.status !== "published") {
        return { outcome: "outcome_unknown", errorCode: "provider_unreadable_response" };
      }
      if (!externalPostId || !externalUrl) {
        // Created, by the status code, and the object it created is not
        // identified. We cannot say published without an id and a URL, and we
        // cannot say failed either.
        return { outcome: "outcome_unknown", errorCode: "provider_unreadable_response" };
      }
      return { outcome: "published", externalPostId, externalUrl };
    },

    async lookupByRequestKey(): Promise<MarketingPublishResult> {
      // **The provider cannot be asked this.** No call is made, because there is
      // nothing to call: `GET /v1/posts` has no `metadata` filter, and the
      // `x-request-id` window is both short and, per C6, ambiguous when it hits.
      // Answering "unknown" is the honest answer, and amendment 4 is where it was
      // agreed that this is what the adapter does rather than page the list
      // endpoint and produce a guess that looks like proof.
      return { outcome: "outcome_unknown", errorCode: "no_lookup_by_request_key" };
    },

    lookupStatus: status.lookupStatus,

    async cancel(
      externalPostId: string,
      externalAccountRef: string,
      channel: MarketingChannel,
    ): Promise<{ readonly cancelled: boolean; readonly errorCode: string | null }> {
      // `DELETE /v1/posts/{id}` only removes drafts and scheduled posts -- the
      // record says "Published posts cannot be deleted" -- so retracting a live
      // post is `unpublish`, which leaves Zernio's own row as `cancelled`.
      //
      // **`platform` is required, and `accountId` names which copy.** The first
      // version sent an empty body, which the provider answers 400 -- so every
      // channel this adapter reported as retractable could not in fact be
      // retracted, which is the premise O15 rests autonomy on. A platform the
      // unpublish enum does not list is refused here, without a call.
      const platform = PLATFORM_BY_CHANNEL[channel];
      if (!platform || !RETRACTABLE_PLATFORMS.has(platform)) {
        return { cancelled: false, errorCode: "provider_cannot_retract" };
      }
      const result = await call(`/v1/posts/${encodeURIComponent(externalPostId)}/unpublish`, {
        method: "POST",
        body: { platform, accountId: externalAccountRef },
      });
      if (result.kind === "unreachable") return { cancelled: false, errorCode: result.code };
      // 200 is the documented success; anything else is not one.
      if (result.status === 200) return { cancelled: true, errorCode: null };
      return { cancelled: false, errorCode: rejectionCode(result.status) };
    },
  };
};
