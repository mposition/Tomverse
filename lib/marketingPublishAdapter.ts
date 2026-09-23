/**
 * What a marketing publishing adapter has to be able to do, and nothing that
 * does it.
 *
 * Contract: the S2 plan's "S2c — adapter contract and claim-only publisher".
 * This slice defines the interface and deliberately ships no implementation:
 * there is no credential in this build, so there is nothing that could make an
 * external call even by accident. What it buys is that the publisher written in
 * S2d2 has a shape to satisfy rather than a shape to invent, and that the
 * claim path in `lib/marketingStore.ts` can be written and tested against a
 * resolver that answers honestly today.
 *
 * ## Six operations, and why each is separate
 *
 * `publish` and `lookupByRequestKey` are the two halves of one guarantee. A
 * request that leaves and is never answered -- the connection dropped, the
 * process was killed -- has an outcome the platform knows and we do not, and
 * the only safe way to find it is to ask about the exact key we sent. Retrying
 * `publish` in that state is how an account posts twice. So the key is the
 * post's `logicalKey`, which is unique in the database, and the lookup takes
 * the same key rather than anything the first call returned.
 *
 * `lookupStatus` is a different question: what does the platform say about an
 * object we know exists? That is how a published post is verified later, and
 * how a post removed by the platform is noticed.
 *
 * `cancel` exists because O15 turns on it. A channel whose API cannot retract
 * a post may never reach autonomous mode, so an adapter has to be able to say
 * whether it can -- which is what `capabilities` is for.
 *
 * `observeHealth` is the only one that is allowed to be cheap and frequent: the
 * admission resolver requires a health observation no older than
 * `MARKETING_HEALTH_FRESHNESS_SECONDS`, made during the current invocation.
 *
 * ## What is not here
 *
 * No credential, no base URL, no HTTP client and no retry policy. An adapter
 * receives whatever it needs to authenticate from the service that constructs
 * it, and the only construction path in this build is the unavailable one
 * below. Nothing in `lib/` may hold a marketing platform credential.
 */

import "server-only";

import type { MarketingChannel } from "@/lib/marketingAutomationSchema";

/** What an adapter can do for a given account, as the adapter reports it. */
export type MarketingAdapterCapabilities = {
  /** Whether a published object can be retracted through the API (policy O15). */
  readonly canRetract: boolean;
  /** Whether comments on a published object can be read and monitored. */
  readonly canMonitorComments: boolean;
  /** Whether the platform answers a lookup by our own idempotency key. */
  readonly canLookupByRequestKey: boolean;
};

/**
 * What a health observation is about.
 *
 * Two, because the admission resolver asks two different questions:
 * `adapterHealthy` for publishing and `commentsMonitorHealthy` for autonomy,
 * and a platform can be able to accept a post while its comment API is down.
 * The plan's `marketing_provider.health_observed` row is keyed by channel,
 * connection generation *and* capability, so an adapter that could only
 * observe "the account" would have to be reopened in S2d2 to say which.
 */
export const MARKETING_HEALTH_CAPABILITIES = ["publish", "comments"] as const;

export type MarketingHealthCapability =
  (typeof MARKETING_HEALTH_CAPABILITIES)[number];

/** One health observation, as the adapter made it just now. */
export type MarketingAdapterHealth = {
  /** Which capability this observation answers for. */
  readonly capability: MarketingHealthCapability;
  readonly healthy: boolean;
  /**
   * Why, when it is not healthy, in words an operator can act on and a
   * platform cannot leak through. Never a raw provider body: a 401 says the
   * token is wrong, and the token itself is not part of saying so.
   */
  readonly reason: string | null;
};

/** What we send. Nothing here identifies a person or an account holder. */
export type MarketingPublishRequest = {
  /** The post's `logicalKey`, which is the idempotency key end to end. */
  readonly requestKey: string;
  readonly channel: MarketingChannel;
  /** The account to post from, as the platform knows it. */
  readonly externalAccountRef: string;
  readonly locale: string;
  readonly renderedText: string;
  readonly assetIds: readonly string[];
  readonly finalUrl: string | null;
};

/**
 * What came back, as three answers that are not interchangeable.
 *
 * `published` means the platform confirmed an object. `failed` means it
 * confirmed there is none and said why. `outcome_unknown` means we do not
 * know -- and that is a result, not an error to swallow: the policy says never
 * blind retry, and this is the value that makes the caller stop.
 */
export type MarketingPublishResult =
  | {
      readonly outcome: "published";
      readonly externalPostId: string;
      /** HTTPS, on the platform's own host. */
      readonly externalUrl: string;
    }
  | {
      readonly outcome: "failed";
      /** A closed code, never provider prose. */
      readonly errorCode: string;
    }
  | {
      readonly outcome: "outcome_unknown";
      readonly errorCode: string;
    };

/** What the platform says about an object we believe exists. */
export type MarketingObjectStatus =
  | { readonly state: "live"; readonly externalUrl: string }
  | { readonly state: "removed" }
  | { readonly state: "unknown" };

export type MarketingPublishAdapter = {
  readonly provider: string;
  capabilities(channel: MarketingChannel): Promise<MarketingAdapterCapabilities>;
  observeHealth(
    externalAccountRef: string,
    capability: MarketingHealthCapability,
  ): Promise<MarketingAdapterHealth>;
  publish(request: MarketingPublishRequest): Promise<MarketingPublishResult>;
  /** The same key that was sent, never an id the failed call returned. */
  lookupByRequestKey(
    requestKey: string,
    externalAccountRef: string,
  ): Promise<MarketingPublishResult>;
  lookupStatus(
    externalPostId: string,
    externalAccountRef: string,
  ): Promise<MarketingObjectStatus>;
  cancel(
    externalPostId: string,
    externalAccountRef: string,
  ): Promise<{ readonly cancelled: boolean; readonly errorCode: string | null }>;
};

/** Why no adapter is available, as a closed list rather than a sentence. */
export type MarketingAdapterUnavailableReason =
  | "no_adapter_implemented"
  | "provider_not_recognised";

export type MarketingAdapterResolution =
  | { readonly available: true; readonly adapter: MarketingPublishAdapter }
  | {
      readonly available: false;
      readonly reason: MarketingAdapterUnavailableReason;
    };

/**
 * The adapter for a provider, or the reason there is not one.
 *
 * Always the second, in this build. It is written as a resolver returning a
 * refusal rather than as a function that throws, because the publisher has to
 * be able to ask without handling an exception on the ordinary path -- "there
 * is no adapter" is the expected answer until S2d2, not an error.
 *
 * It takes no credential and reads no environment. When S2d2 adds the Zernio
 * adapter, what changes here is one branch; what does not change is that this
 * module cannot construct something that holds a secret, because the secret
 * arrives at the service, not at the library.
 */
export const resolveMarketingPublishAdapter = (
  provider: string,
): MarketingAdapterResolution => {
  if (provider !== "zernio") {
    return { available: false, reason: "provider_not_recognised" };
  }
  // S2d2 replaces this line and nothing above it.
  return { available: false, reason: "no_adapter_implemented" };
};

/**
 * Whether any adapter exists at all.
 *
 * The claim path uses this to say why it stopped. A claim is not a dispatch --
 * it takes a slot and a lease and touches no provider -- so an absent adapter
 * does not prevent one; what it prevents is the dispatch that would follow, and
 * a claim taken for a dispatch that cannot happen is a slot held for nothing.
 */
export const marketingPublishAdapterAvailable = (provider: string): boolean =>
  resolveMarketingPublishAdapter(provider).available;
