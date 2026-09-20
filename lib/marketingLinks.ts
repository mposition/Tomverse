/**
 * Building the one URL a marketing post is allowed to carry.
 *
 * Contract: docs/policy/marketing-automation.md §7.3. The model picks an id;
 * this assembles the URL, checks the origin it produced, and attaches the
 * campaign parameters. Channels that cannot carry a link in a caption
 * (Instagram, TikTok) get the account's fixed profile link instead, with the
 * same parameters, which is the same rule stated for a surface that has one
 * link rather than one per post.
 *
 * Why the origin is checked *after* assembly rather than the path before it.
 * A path is not a safe input to `new URL(path, origin)` in the way it looks:
 * `//evil.test/x` is a protocol-relative URL and resolves to another host,
 * `https://evil.test` replaces the base entirely, and a backslash is normalised
 * to a slash by the URL parser before any of that. Inspecting the string first
 * means enumerating those; comparing the origin afterwards means asking the
 * parser what it actually built, which is the thing that matters. Both happen
 * here -- the id lookup already restricts the input to a fixed list -- but the
 * origin comparison is the one that would still hold if the list were wrong.
 *
 * Pure: no server-only import, no network, no Prisma.
 */

import {
  MARKETING_APPROVED_LINKS,
  isMarketingLinkId,
  type MarketingLinkId,
} from "@/lib/marketingApprovedLinks";

/** Where marketing links point. One origin, and it is ours. */
export const MARKETING_PUBLIC_ORIGIN = "https://tomverse.app";

/**
 * The campaign name a post carries.
 *
 * Narrow because it ends up in an analytics dimension that is grouped on: a
 * campaign that differs only by case or by a stray space becomes two rows in
 * every report, and nobody notices until the numbers are already wrong.
 */
export const MARKETING_CAMPAIGN_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MARKETING_CAMPAIGN_MAX_LENGTH = 60;

/**
 * The channels whose captions cannot carry a link
 * (docs/policy/marketing-automation.md §7.3, O15).
 */
export const MARKETING_PROFILE_LINK_CHANNELS = ["instagram", "tiktok"] as const;
export type MarketingProfileLinkChannel =
  (typeof MARKETING_PROFILE_LINK_CHANNELS)[number];

export const usesProfileLink = (channel: string): boolean =>
  (MARKETING_PROFILE_LINK_CHANNELS as readonly string[]).includes(channel);

/** Why a link could not be built. Codes, because the Guard records them. */
export type MarketingLinkRefusal =
  | "unknown_link_id"
  | "campaign_invalid"
  | "account_slug_invalid"
  | "origin_escaped";

export type MarketingLinkResult =
  | { ok: true; url: string }
  | { ok: false; refusal: MarketingLinkRefusal };

export type MarketingLinkRequest = {
  linkId: string;
  channel: string;
  accountSlug: string;
  campaign: string;
};

const ACCOUNT_SLUG_PATTERN = /^[a-z]+-[0-9]{1,3}$/;

/**
 * The campaign parameters, in a fixed order and set rather than appended.
 *
 * `searchParams.set` and not string concatenation: an approved path could one
 * day carry a query of its own, and appending `?utm_source=...` to a URL that
 * already has one produces a second question mark and a parameter nobody reads.
 * `set` also replaces rather than duplicates, so a path that already named a
 * campaign cannot end up with two.
 */
const applyCampaign = (
  url: URL,
  { channel, accountSlug, campaign }: Omit<MarketingLinkRequest, "linkId">,
) => {
  url.searchParams.set("utm_source", channel);
  url.searchParams.set("utm_medium", "social");
  url.searchParams.set("utm_campaign", campaign);
  url.searchParams.set("utm_content", accountSlug);
};

/**
 * The URL for a post on a channel that can carry one, or a refusal.
 */
export function buildMarketingLink(
  request: MarketingLinkRequest,
): MarketingLinkResult {
  if (!isMarketingLinkId(request.linkId)) {
    return { ok: false, refusal: "unknown_link_id" };
  }
  if (
    request.campaign.length > MARKETING_CAMPAIGN_MAX_LENGTH ||
    !MARKETING_CAMPAIGN_PATTERN.test(request.campaign)
  ) {
    return { ok: false, refusal: "campaign_invalid" };
  }
  if (!ACCOUNT_SLUG_PATTERN.test(request.accountSlug)) {
    return { ok: false, refusal: "account_slug_invalid" };
  }

  const path = MARKETING_APPROVED_LINKS[request.linkId as MarketingLinkId];

  let url: URL;
  try {
    url = new URL(path, MARKETING_PUBLIC_ORIGIN);
  } catch {
    return { ok: false, refusal: "origin_escaped" };
  }

  // What the parser built, not what the string looked like. A protocol-relative
  // path, an absolute URL, a backslash or userinfo in the registry would all
  // land here rather than in a published post.
  if (url.origin !== MARKETING_PUBLIC_ORIGIN) {
    return { ok: false, refusal: "origin_escaped" };
  }

  applyCampaign(url, request);
  return { ok: true, url: url.toString() };
}

/**
 * The URL for a channel whose caption cannot carry one: the account's own
 * profile link, with the same campaign parameters.
 *
 * The profile link is the account's, not the post's, so it is supplied by the
 * caller from the channel row rather than looked up here -- this module knows
 * about our own site and nothing about anybody's profile pages.
 */
export function buildMarketingProfileLink({
  profileUrl,
  channel,
  accountSlug,
  campaign,
}: {
  profileUrl: string;
  channel: string;
  accountSlug: string;
  campaign: string;
}): MarketingLinkResult {
  if (
    campaign.length > MARKETING_CAMPAIGN_MAX_LENGTH ||
    !MARKETING_CAMPAIGN_PATTERN.test(campaign)
  ) {
    return { ok: false, refusal: "campaign_invalid" };
  }
  if (!ACCOUNT_SLUG_PATTERN.test(accountSlug)) {
    return { ok: false, refusal: "account_slug_invalid" };
  }

  let url: URL;
  try {
    url = new URL(profileUrl);
  } catch {
    return { ok: false, refusal: "origin_escaped" };
  }

  // Somebody else's site, so the rule is not "our origin" but "a real https
  // origin with nothing hidden in it": userinfo in a URL is how a link that
  // reads as one host reaches another.
  if (url.protocol !== "https:" || url.username || url.password) {
    return { ok: false, refusal: "origin_escaped" };
  }

  applyCampaign(url, { channel, accountSlug, campaign });
  return { ok: true, url: url.toString() };
}
