import "server-only";

import type { MarketingChannel } from "@/lib/marketingAutomationSchema";
import type {
  MarketingAdapterCapabilities,
  MarketingAdapterHealth,
  MarketingHealthCapability,
  MarketingObjectStatus,
  MarketingPublishAdapter,
  MarketingPublishRequest,
  MarketingPublishResult,
} from "@/lib/marketingPublishAdapter";

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
/** Zernio's API origin, from the S0 record (OpenAPI `info.version` 1.5.0). */
export const ZERNIO_API_BASE_URL = "https://zernio.com/api";

export type ZernioAdapterPorts = {
  /** `sk_` + 64 hex, or a restricted `zrk_` key. Never logged, never returned. */
  readonly apiKey: string;
  /** The API origin, so a test can point this at a fixture server. */
  readonly baseUrl: string;
  /**
   * An asset id to a public HTTPS URL.
   *
   * A port because resolving one needs the object store, and this file may not
   * hold that credential either. Zernio accepts a public HTTPS URL directly as
   * `mediaItems[].url`, so no upload happens here.
   */
  readonly resolveAssetUrl: (assetId: string) => Promise<string | null>;
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

type ZernioPlatformResult = {
  platform?: string;
  status?: string;
  platformPostId?: string;
  platformPostUrl?: string;
  publishedUrl?: string;
  error?: unknown;
};

type ZernioPost = {
  id?: string;
  status?: string;
  platforms?: ZernioPlatformResult[];
};

const httpsUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
};

export const zernioPublishAdapter = (
  ports: ZernioAdapterPorts,
): MarketingPublishAdapter => {
  const call = async (
    path: string,
    init: { method: string; body?: unknown; requestKey?: string },
  ): Promise<
    | { readonly kind: "response"; readonly status: number; readonly body: unknown }
    | { readonly kind: "unreachable"; readonly code: ZernioErrorCode }
  > => {
    const doFetch = ports.fetch ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ports.callBudgetMs);
    try {
      const response = await doFetch(new URL(path, ports.baseUrl), {
        method: init.method,
        headers: {
          // The only place the key appears. It is not logged and not returned.
          Authorization: `Bearer ${ports.apiKey}`,
          "Content-Type": "application/json",
          // Zernio's idempotency for POST /v1/posts, and the reason the post's
          // own logicalKey is the request key end to end.
          ...(init.requestKey ? { "x-request-id": init.requestKey } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      return { kind: "response", status: response.status, body };
    } catch (error) {
      // A timeout and a dropped connection are the same fact to a caller: the
      // request may have been received. Neither is retried.
      const aborted =
        error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
      return { kind: "unreachable", code: aborted ? "provider_timeout" : "provider_unavailable" };
    } finally {
      clearTimeout(timer);
    }
  };

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
      // Cheap and frequent by contract, so it reads one account rather than
      // listing posts.
      const result = await call(
        `/v1/accounts/${encodeURIComponent(externalAccountRef)}`,
        { method: "GET" },
      );
      if (result.kind === "unreachable") {
        return { capability, healthy: false, reason: result.code };
      }
      if (result.status === 200) return { capability, healthy: true, reason: null };
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
      const mediaItems: Array<{ url: string }> = [];
      for (const assetId of request.assetIds) {
        const url = httpsUrl(await ports.resolveAssetUrl(assetId));
        if (!url) return { outcome: "failed", errorCode: "asset_unresolved" };
        mediaItems.push({ url });
      }

      const result = await call("/v1/posts", {
        method: "POST",
        requestKey: request.requestKey,
        body: {
          content: request.renderedText,
          platforms: [{ platform, accountId: request.externalAccountRef }],
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
      const externalPostId = entry?.platformPostId;
      const externalUrl = httpsUrl(entry?.platformPostUrl ?? entry?.publishedUrl);
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

    async lookupStatus(externalPostId: string): Promise<MarketingObjectStatus> {
      // A different question from the one above, and one Zernio *can* answer: we
      // know the object's own id, so we ask about it directly.
      const result = await call(`/v1/posts/${encodeURIComponent(externalPostId)}`, {
        method: "GET",
      });
      if (result.kind === "unreachable") return { state: "unknown" };
      // **Neither a 404 nor `cancelled` says the platform removed anything,**
      // and `removed` here is what the publisher records as
      // `poll_removed_by_platform`. The S0 record is specific about both:
      //
      //   - `cancelled` is what Zernio's own row becomes after
      //     `POST /v1/posts/{id}/unpublish` -- a retraction made through Zernio,
      //     by us or by an operator in its dashboard. Reporting it as removal by
      //     the platform would write our own act into the record as the
      //     platform's.
      //   - A 404 is Zernio no longer having its row, which says nothing about
      //     the platform's copy.
      //
      // The platform's own deletion reaches Zernio as the
      // `post.platform.deleted` webhook, on an hourly poll of its own -- the
      // webhook slices' evidence, not a status query's. So a status query
      // answers `live` or `unknown`, and never guesses the third.
      if (result.status !== 200) return { state: "unknown" };
      const post = (result.body as { post?: ZernioPost } | null)?.post ?? (result.body as ZernioPost | null);
      const status = post?.status;
      if (status !== "published") return { state: "unknown" };
      const entry = post?.platforms?.[0];
      const externalUrl = httpsUrl(entry?.platformPostUrl ?? entry?.publishedUrl);
      return externalUrl ? { state: "live", externalUrl } : { state: "unknown" };
    },

    async cancel(
      externalPostId: string,
      externalAccountRef: string,
    ): Promise<{ readonly cancelled: boolean; readonly errorCode: string | null }> {
      void externalAccountRef;
      // `DELETE /v1/posts/{id}` only removes drafts and scheduled posts -- the
      // record says "Published posts cannot be deleted" -- so retracting a live
      // post is `unpublish`, which leaves Zernio's own row as `cancelled`.
      const result = await call(`/v1/posts/${encodeURIComponent(externalPostId)}/unpublish`, {
        method: "POST",
        body: {},
      });
      if (result.kind === "unreachable") return { cancelled: false, errorCode: result.code };
      if (result.status === 200 || result.status === 204) {
        return { cancelled: true, errorCode: null };
      }
      return { cancelled: false, errorCode: rejectionCode(result.status) };
    },
  };
};
