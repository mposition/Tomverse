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
  /** No approved profile link for this account on this channel. */
  | "profile_link_not_registered"
  /** An ordinary per-post link asked for on a channel that uses a profile link. */
  | "channel_uses_profile_link"
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
 * The approved profile link for each account, which is the whole of the rule.
 *
 * A host allowlist is not enough and an earlier version of this had only that.
 * `https://www.instagram.com/competitor/` is on Instagram's host and is not
 * `instagram-1`'s profile; §7.3 says the channels that cannot carry a link in a
 * caption use *the account's own fixed profile link*, and "the account's own"
 * is the part a host cannot check.
 *
 * Nor can it come from the caller. There is no `profileUrl` on
 * `MarketingChannel` (`prisma/schema.prisma`) -- an earlier comment here said
 * the caller read it from the channel row, and that row has no such column, so
 * the value would have come from wherever the caller found it. A profile link
 * goes on every post for a channel whose posts no API can retract, which makes
 * it exactly the kind of thing that is registered and reviewed rather than
 * passed in.
 *
 * **Empty**, like the other registries in this slice: the accounts are created
 * in S2, and an entry here is a URL somebody checked.
 *
 * Not exported, and each entry frozen rather than only the table. `Readonly<>`
 * is a compile-time claim and `Object.freeze` is shallow, so an exported table
 * of mutable entries would have reopened the hole this registry closed:
 *
 *     MARKETING_PROFILE_LINKS["instagram-1"].url =
 *       "https://www.instagram.com/competitor/";
 *
 * That URL is on an allowed host, so every check below would pass it. What is
 * exported instead is the slug list, which is what anything outside this module
 * has a reason to read.
 */
const MARKETING_PROFILE_LINKS: Readonly<
  Record<string, { channel: MarketingProfileLinkChannel; url: string }>
> = Object.freeze(
  Object.fromEntries(
    Object.entries({} as Record<
      string,
      { channel: MarketingProfileLinkChannel; url: string }
    >).map(([slug, entry]) => [slug, Object.freeze({ ...entry })]),
  ),
);

/** The accounts that have an approved profile link. */
export const MARKETING_PROFILE_ACCOUNT_SLUGS: readonly string[] = Object.freeze(
  Object.keys(MARKETING_PROFILE_LINKS),
);

/**
 * The hosts a registered profile link may sit on.
 *
 * Still checked, because the registry is written by hand: this is what catches
 * an entry that was typed wrong rather than one that was chosen wrong.
 * Compared against `url.host`, so an explicit port fails, and an IDN has been
 * punycoded by the parser so a look-alike does not match by eye.
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
 * The assembly, with the registry as a parameter.
 *
 * **Not exported.** An earlier version took the registry on the exported
 * builder, with a comment saying it was injectable for tests -- which made it a
 * parameter of the production API through which a caller could name any
 * destination, including on the one channel whose posts cannot be retracted.
 * A test's convenience is not a reason to give a publishable function a way to
 * be told what to publish.
 *
 * What a test actually wants to know -- that the origin comparison would catch
 * a bad registry -- is asked of `unsafeMarketingLinkIds()` below, which cannot
 * publish anything.
 */
function assembleMarketingLink(
  request: MarketingLinkRequest,
  links: Readonly<Record<string, string>>,
): MarketingLinkResult {
  const path = Object.prototype.hasOwnProperty.call(links, request.linkId)
    ? links[request.linkId]
    : undefined;
  if (path === undefined) {
    return { ok: false, refusal: "unknown_link_id" };
  }
  // The other half of the channel rule. `buildMarketingProfileLink()` refuses a
  // channel that can carry a link in its caption; without this, the channels
  // that cannot could still get an ordinary per-post URL -- which is what §7.3
  // says they do not get, on the two channels whose posts no API can retract.
  if (usesProfileLink(request.channel)) {
    return { ok: false, refusal: "channel_uses_profile_link" };
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
 * The URL for a post on a channel that can carry one, or a refusal.
 *
 * One argument. The approved paths are this module's, and there is no way to
 * hand it a different set.
 */
export function buildMarketingLink(
  request: MarketingLinkRequest,
): MarketingLinkResult {
  return assembleMarketingLink(request, MARKETING_APPROVED_LINKS);
}

/**
 * The link ids in a registry whose path does not stay on our origin.
 *
 * A validator rather than a builder: it answers the question a test needs to
 * ask about a bad registry, and it returns ids rather than URLs, so nothing it
 * produces can be published. Run against the real registry it is a build-time
 * check, the way `unservedMarketingLinkIds()` is.
 */
export function unsafeMarketingLinkIds(
  links: Readonly<Record<string, string>> = MARKETING_APPROVED_LINKS,
): string[] {
  const unsafe: string[] = [];
  for (const [linkId, path] of Object.entries(links)) {
    const result = assembleMarketingLink(
      {
        linkId,
        channel: "linkedin",
        accountSlug: "linkedin-1",
        campaign: "registry-check",
      },
      links,
    );
    if (!result.ok && result.refusal !== "unknown_link_id") {
      unsafe.push(linkId);
      continue;
    }
    if (result.ok && new URL(result.url).origin !== MARKETING_PUBLIC_ORIGIN) {
      // Unreachable through `assembleMarketingLink`, which is the point of
      // asserting it: if it ever becomes reachable, this says so.
      unsafe.push(linkId);
    }
    void path;
  }
  return unsafe;
}

/** Not exported, for the reason `assembleMarketingLink` is not. */
function assembleMarketingProfileLink(
  {
    channel,
    accountSlug,
    campaign,
  }: {
    channel: string;
    accountSlug: string;
    campaign: string;
  },
  registry: Readonly<Record<string, { channel: string; url: string }>>,
): MarketingLinkResult {
  if (
    campaign.length > MARKETING_CAMPAIGN_MAX_LENGTH ||
    !MARKETING_CAMPAIGN_PATTERN.test(campaign)
  ) {
    return { ok: false, refusal: "campaign_invalid" };
  }
  if (!accountSlugMatchesChannel(accountSlug, channel)) {
    return { ok: false, refusal: "account_slug_invalid" };
  }

  const entry = Object.prototype.hasOwnProperty.call(registry, accountSlug)
    ? registry[accountSlug]
    : undefined;
  if (!entry) return { ok: false, refusal: "profile_link_not_registered" };

  // The registry's own channel has to be the channel posting. Otherwise the
  // slug check above is the only thing tying them together, and it compares a
  // slug to a string the same caller supplied.
  if (entry.channel !== channel) {
    return { ok: false, refusal: "profile_link_not_registered" };
  }
  if (!usesProfileLink(channel)) {
    // A channel that can carry a link in its caption does not get one of these.
    return { ok: false, refusal: "profile_link_not_registered" };
  }
  if (entry.url.length > MARKETING_URL_MAX_LENGTH) {
    return { ok: false, refusal: "url_too_long" };
  }

  let url: URL;
  try {
    url = new URL(entry.url);
  } catch {
    return { ok: false, refusal: "origin_escaped" };
  }

  // Somebody else's site, so the rule is not "our origin" but "a real https
  // origin with nothing hidden in it": userinfo in a URL is how a link that
  // reads as one host reaches another.
  if (url.protocol !== "https:" || url.username || url.password) {
    return { ok: false, refusal: "origin_escaped" };
  }

  // And it has to be on the channel's own site, which catches a registry entry
  // that was typed wrong rather than one that was chosen wrong. `url.host`
  // includes the port, so an explicit one fails, and an IDN has been punycoded
  // by the parser so a look-alike does not match by eye.
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
  const assembled = url.toString();
  // After the parameters, not before: they are part of the link that is stored
  // and posted, and the cap is on the field that holds it.
  if (assembled.length > MARKETING_URL_MAX_LENGTH) {
    return { ok: false, refusal: "url_too_long" };
  }
  return { ok: true, url: assembled };
}

/**
 * The URL for a channel whose caption cannot carry one: the account's own
 * profile link, with the same campaign parameters.
 *
 * Takes the account and nothing else. The account is what the post knows, the
 * link is what has been approved for it, and a caller who could hand in either
 * a URL or a registry could hand in a competitor's profile on the right host.
 */
export function buildMarketingProfileLink(request: {
  channel: string;
  accountSlug: string;
  campaign: string;
}): MarketingLinkResult {
  return assembleMarketingProfileLink(request, MARKETING_PROFILE_LINKS);
}

/**
 * The account slugs in a profile registry whose entry would not be publishable.
 *
 * The validator twin of `unsafeMarketingLinkIds()`, and it exists for the same
 * reason: this is the question a test needs to ask about a bad registry, and
 * asking it of the builder would have meant giving the builder a way to be
 * handed one.
 */
export function unsafeMarketingProfileAccounts(
  registry: Readonly<
    Record<string, { channel: string; url: string }>
  > = MARKETING_PROFILE_LINKS,
): Array<{ accountSlug: string; refusal: MarketingLinkRefusal }> {
  const unsafe: Array<{ accountSlug: string; refusal: MarketingLinkRefusal }> =
    [];
  for (const [accountSlug, entry] of Object.entries(registry)) {
    const result = assembleMarketingProfileLink(
      {
        channel: entry.channel,
        accountSlug,
        campaign: "registry-check",
      },
      registry,
    );
    if (!result.ok) unsafe.push({ accountSlug, refusal: result.refusal });
  }
  return unsafe;
}
