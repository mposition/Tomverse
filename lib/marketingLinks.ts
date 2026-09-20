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

import { MARKETING_APPROVED_LINKS } from "@/lib/marketingApprovedLinks";

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
  | "origin_escaped"
  /** A profile link pointing somewhere that is not the channel's own site. */
  | "profile_host_not_allowed"
  | "url_too_long";

export type MarketingLinkResult =
  | { ok: true; url: string }
  | { ok: false; refusal: MarketingLinkRefusal };

export type MarketingLinkRequest = {
  linkId: string;
  channel: string;
  accountSlug: string;
  campaign: string;
};

/**
 * The slug shape, which is only half the rule.
 *
 * The database says
 * `"accountSlug" ~ '^[a-z]+-[0-9]{1,3}$' AND "accountSlug" LIKE "channel" || '-%'`
 * (prisma/migrations/20260918120000_marketing_automation_tables/migration.sql).
 * Carrying only the first half here would let a LinkedIn post go out tagged
 * `utm_source=linkedin&utm_content=instagram-1`, naming two different accounts
 * in one link and making every report that groups by either of them wrong.
 */
const ACCOUNT_SLUG_PATTERN = /^[a-z]+-[0-9]{1,3}$/;

const accountSlugMatchesChannel = (accountSlug: string, channel: string) =>
  ACCOUNT_SLUG_PATTERN.test(accountSlug) &&
  accountSlug.startsWith(`${channel}-`);

/**
 * The hosts a channel's profile link may point at.
 *
 * Without this the builder accepts any https URL a caller hands it, and the
 * result goes into every post on Instagram and TikTok -- the two channels whose
 * posts cannot be retracted through an API (§7.3, O15). The caller reads the
 * URL from a channel row, so this is defence in depth, which is exactly why it
 * is worth having: the row is the thing that could be wrong.
 *
 * Compared against `url.host`, so a port fails and a look-alike host fails: the
 * URL parser has already punycoded an IDN by then, so `ɪnstagram.com` arrives
 * as `xn--nstagram-j1a.com` rather than matching by eye.
 */
const PROFILE_LINK_HOSTS: Record<string, readonly string[]> = {
  instagram: ["instagram.com", "www.instagram.com"],
  tiktok: ["tiktok.com", "www.tiktok.com"],
};

/** r4 amendment 9: an https URL field is capped at 2,048 characters. */
export const MARKETING_URL_MAX_LENGTH = 2048;

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
  /**
   * The approved paths. Injectable only so a test can hand this function the
   * wrong registry and watch the origin comparison below hold -- with the real
   * one the id lookup already restricts the input to a fixed list, which makes
   * the comparison unreachable and therefore unproven.
   */
  links: Readonly<Record<string, string>> = MARKETING_APPROVED_LINKS,
): MarketingLinkResult {
  const path = Object.prototype.hasOwnProperty.call(links, request.linkId)
    ? links[request.linkId]
    : undefined;
  if (path === undefined) {
    return { ok: false, refusal: "unknown_link_id" };
  }
  if (
    request.campaign.length > MARKETING_CAMPAIGN_MAX_LENGTH ||
    !MARKETING_CAMPAIGN_PATTERN.test(request.campaign)
  ) {
    return { ok: false, refusal: "campaign_invalid" };
  }
  if (!accountSlugMatchesChannel(request.accountSlug, request.channel)) {
    return { ok: false, refusal: "account_slug_invalid" };
  }

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
  const assembled = url.toString();
  if (assembled.length > MARKETING_URL_MAX_LENGTH) {
    return { ok: false, refusal: "url_too_long" };
  }
  return { ok: true, url: assembled };
}

/**
 * The URL for a channel whose caption cannot carry one: the account's own
 * profile link, with the same campaign parameters.
 *
 * The profile link is the account's, not the post's, so it is supplied by the
 * caller from the channel row rather than looked up here. The host is still
 * checked against the channel: this link goes on every post for a channel that
 * cannot retract one, so accepting whatever URL a row happens to hold would
 * make a bad row unrecoverable rather than merely wrong.
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
  if (!accountSlugMatchesChannel(accountSlug, channel)) {
    return { ok: false, refusal: "account_slug_invalid" };
  }
  if (profileUrl.length > MARKETING_URL_MAX_LENGTH) {
    return { ok: false, refusal: "url_too_long" };
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

  // And it has to be the channel's own site. `url.host` includes the port, so
  // an explicit one fails, and an IDN has already been punycoded by the parser
  // so a look-alike does not match by eye.
  const allowed = Object.prototype.hasOwnProperty.call(
    PROFILE_LINK_HOSTS,
    channel,
  )
    ? PROFILE_LINK_HOSTS[channel]
    : undefined;
  if (!allowed || !allowed.includes(url.host)) {
    return { ok: false, refusal: "profile_host_not_allowed" };
  }

  applyCampaign(url, { channel, accountSlug, campaign });
  return { ok: true, url: url.toString() };
}
