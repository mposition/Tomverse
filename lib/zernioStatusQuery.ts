import "server-only";

import { createHash } from "node:crypto";

import type { MarketingObjectStatus } from "@/lib/marketingPublishAdapter";

/**
 * Zernio's transport and its status query, apart from the publish adapter.
 *
 * The webhook receiver asks Zernio one thing -- the status of a post it already
 * knows -- and its pipeline fingerprint (docs/policy/marketing-automation.md
 * §8.1.1) hashes the code that path loads. While the receiver built the whole
 * publish adapter, every change to what a post sends (media, the fields each
 * platform takes) moved that fingerprint and staled a signed verification
 * record. The receiver now loads this module only; `lib/zernioPublishAdapter.ts`
 * builds on it, and a change to publishing leaves the webhook path as it was.
 *
 * Moved, not rewritten: the request, the UUID, the URL join and the status
 * reading are the adapter's own, with their reasons.
 */

/** Zernio's API origin, from the S0 record (OpenAPI `info.version` 1.5.0). */
export const ZERNIO_API_BASE_URL = "https://zernio.com/api";

/** What a call needs. The key is never logged and never returned. */
export type ZernioTransportPorts = {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly callBudgetMs: number;
  readonly fetch?: typeof fetch;
};

const ZERNIO_REQUEST_NAMESPACE = Buffer.from("8f0d3a52b1c64e7a9d2f5c7e1a4b6d90", "hex");

/**
 * A post's logical key as the UUID Zernio's request headers take.
 *
 * `x-request-id` is documented as `format: uuid` and `Idempotency-Key` as "a
 * UUID per logical post"; the logical key has slashes in it. So the key is
 * mapped to a UUID the way RFC 4122 version 5 does -- SHA-1 over a fixed
 * namespace and the name -- which is deterministic: the same post always gets
 * the same id, which is the property idempotency needs. The logical key itself
 * still goes in `metadata` for a person reconciling by hand.
 */

export const zernioRequestUuid = (requestKey: string): string => {
  const hash = createHash("sha1")
    .update(ZERNIO_REQUEST_NAMESPACE)
    .update(requestKey, "utf8")
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};


export type ZernioPlatformResult = {
  platform?: string;
  /** The target account, as a string or an object carrying one (as the S0 probe reads it). */
  accountId?: string | { _id?: string; id?: string };
  status?: string;
  platformPostId?: string;
  platformPostUrl?: string;
  publishedUrl?: string;
  error?: unknown;
};

export type ZernioPost = {
  _id?: string;
  id?: string;
  status?: string;
  platforms?: ZernioPlatformResult[];
};

/**
 * Zernio's own id for a post, which is what its API is asked about.
 *
 * `_id` first, then `id` -- the order the S0 probe reads them in. This, and not
 * the platform's `platformPostId`, is what `GET /v1/posts/{postId}` and
 * `POST /v1/posts/{postId}/unpublish` take. The adapter used to return the
 * platform's id as `externalPostId`, and every later status query then asked
 * Zernio about an id it had never issued.
 */
export const zernioPostId = (post: ZernioPost | null | undefined): string | null => {
  const value = post?._id ?? post?.id;
  return typeof value === "string" && value.trim() !== "" ? value : null;
};

/**
 * Join the API origin and a path without losing the origin's path.
 *
 * `new URL("/v1/posts", "https://zernio.com/api")` is
 * `https://zernio.com/v1/posts`: an absolute path replaces the base's path, so
 * the `/api` prefix vanished and every call went to the wrong place. The test
 * fixture had no prefix to lose, which is how it hid.
 */
export const joinUrl = (baseUrl: string, path: string): URL => {
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/+$/, "");
  return new URL(`${prefix}${path}`, base.origin);
};

export const httpsUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
};

/** One request to Zernio, within the caller's budget. A timeout and a dropped connection are both unreachable. */
export const zernioCall = async (
  ports: ZernioTransportPorts,
  path: string,
  init: { method: string; body?: unknown; requestKey?: string },
): Promise<
  | { readonly kind: "response"; readonly status: number; readonly body: unknown }
  | { readonly kind: "unreachable"; readonly code: "provider_timeout" | "provider_unavailable" }
> => {
  const doFetch = ports.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ports.callBudgetMs);
  try {
    const response = await doFetch(joinUrl(ports.baseUrl, path), {
      method: init.method,
      headers: {
        // The only place the key appears. It is not logged and not returned.
        Authorization: `Bearer ${ports.apiKey}`,
        "Content-Type": "application/json",
        // Zernio's idempotency for POST /v1/posts, and the reason the post's
        // own logicalKey is the request key end to end. Both headers: the S0
        // record names `x-request-id` (about five minutes); the current
        // documentation also names `Idempotency-Key` (24 hours, taking
        // precedence). Neither is a licence to retry -- amendment 4 still
        // holds and nothing here re-sends -- but a key the provider honours
        // for longer is a narrower window for an accidental second post.
        ...(init.requestKey
          ? {
              "x-request-id": zernioRequestUuid(init.requestKey),
              "Idempotency-Key": zernioRequestUuid(init.requestKey),
            }
          : {}),
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

/** The status half of the adapter: what Zernio says about one account's copy of a post. */
export const zernioStatusQuery = (ports: ZernioTransportPorts) => {
  const call = (path: string, init: { method: string; body?: unknown; requestKey?: string }) =>
    zernioCall(ports, path, init);
  return {
    async lookupStatus(
      externalPostId: string,
      externalAccountRef: string,
    ): Promise<MarketingObjectStatus> {
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
      // **The target this question is about, not the post's first.** A post can
      // go to several accounts and each has its own status; the post's own
      // status is an aggregate (`partial` when they differ). The first version
      // read that aggregate and `platforms[0]`, so a question about the second
      // account was answered about the first. A target whose account cannot be
      // matched is not an answer at all.
      const accountOf = (entry: ZernioPlatformResult) =>
        typeof entry.accountId === "string"
          ? entry.accountId
          : (entry.accountId?._id ?? entry.accountId?.id ?? null);
      const entries = post?.platforms ?? [];
      const ref = String(externalAccountRef ?? "").trim();
      const matching = entries.filter((entry) => ref !== "" && accountOf(entry) === ref);
      const entry = matching.length === 1 ? matching[0] : undefined;
      if (!entry) return { state: "unknown" };
      if (entry.status === "published") {
        const externalUrl = httpsUrl(entry.platformPostUrl ?? entry.publishedUrl);
        return externalUrl ? { state: "live", externalUrl } : { state: "unknown" };
      }
      // Failed, or retracted through Zernio: the provider affirms this copy is
      // not up. Still not removal by the platform -- see above.
      if (entry.status === "failed" || entry.status === "cancelled") {
        return { state: "not_live" };
      }
      return { state: "unknown" };
    },
  };
};
