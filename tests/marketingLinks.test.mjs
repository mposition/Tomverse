// The one URL a marketing post may carry, and the ways a link escapes an origin.
//
// Contract: docs/policy/marketing-automation.md §7.3. The model picks an id and
// the server assembles the URL; what is asserted here is that the assembly
// cannot be talked into pointing somewhere else, and that every approved id is
// still a page this application serves.

import assert from "node:assert/strict";
import test from "node:test";

import {
  MARKETING_APPROVED_LINKS,
  MARKETING_LINK_IDS,
  isMarketingLinkId,
  marketingLinkPath,
  unservedMarketingLinkIds,
} from "../lib/marketingApprovedLinks.ts";
import {
  MARKETING_CAMPAIGN_MAX_LENGTH,
  MARKETING_PROFILE_LINK_CHANNELS,
  MARKETING_PUBLIC_ORIGIN,
  buildMarketingLink,
  buildMarketingProfileLink,
  usesProfileLink,
} from "../lib/marketingLinks.ts";

const request = (overrides = {}) => ({
  linkId: "link.pricing",
  channel: "linkedin",
  accountSlug: "linkedin-1",
  campaign: "autumn-compare",
  ...overrides,
});

test("every approved link is a page this application serves", () => {
  // A page that is renamed or withdrawn has to break the build rather than
  // become a post that links to a 404 for as long as the post exists.
  assert.deepEqual(unservedMarketingLinkIds(), []);
  assert.ok(MARKETING_LINK_IDS.length > 0);
});

test("an id outside the list is refused, and ids are not paths", () => {
  assert.equal(isMarketingLinkId("link.pricing"), true);
  assert.equal(isMarketingLinkId("/pricing"), false);
  assert.equal(isMarketingLinkId("link.does-not-exist"), false);
  assert.equal(marketingLinkPath("link.does-not-exist"), null);

  assert.deepEqual(buildMarketingLink(request({ linkId: "/pricing" })), {
    ok: false,
    refusal: "unknown_link_id",
  });
  assert.deepEqual(
    buildMarketingLink(request({ linkId: "https://evil.test/" })),
    { ok: false, refusal: "unknown_link_id" },
  );
});

test("a built link is ours, and carries the campaign once", () => {
  const result = buildMarketingLink(request());
  assert.equal(result.ok, true);

  const url = new URL(result.url);
  assert.equal(url.origin, MARKETING_PUBLIC_ORIGIN);
  assert.equal(url.pathname, "/pricing");
  assert.equal(url.searchParams.get("utm_source"), "linkedin");
  assert.equal(url.searchParams.get("utm_medium"), "social");
  assert.equal(url.searchParams.get("utm_campaign"), "autumn-compare");
  assert.equal(url.searchParams.get("utm_content"), "linkedin-1");
  assert.equal(url.searchParams.getAll("utm_campaign").length, 1);
});

test("a campaign name is one shape, so a report has one row per campaign", () => {
  for (const campaign of [
    "Autumn-Compare",
    "autumn compare",
    "autumn_compare",
    "-autumn",
    "autumn-",
    "autumn--compare",
    "",
    "a".repeat(MARKETING_CAMPAIGN_MAX_LENGTH + 1),
  ]) {
    assert.deepEqual(
      buildMarketingLink(request({ campaign })),
      { ok: false, refusal: "campaign_invalid" },
      `${campaign} should be refused`,
    );
  }
});

test("the account slug in utm_content is the generated kind", () => {
  for (const accountSlug of ["@tomverse", "linkedin", "linkedin-1234", "LinkedIn-1"]) {
    assert.deepEqual(buildMarketingLink(request({ accountSlug })), {
      ok: false,
      refusal: "account_slug_invalid",
    });
  }
});

test("a registry path that escaped the origin would be refused, not published", () => {
  // The builder is handed a wrong registry on purpose. With the real one the
  // id lookup already restricts the path to a fixed list, so the origin
  // comparison never runs -- and a check that never runs is not a check that
  // holds. The module's claim is that the comparison would catch a bad
  // registry, and this is the only way to make it say so.
  for (const path of [
    "//evil.test/pricing",
    "https://evil.test/pricing",
    "\\\\evil.test/pricing",
    "https://user:pass@evil.test/pricing",
    "https://tomverse.app.evil.test/pricing",
    "https://tomverse.app:8443/pricing",
  ]) {
    assert.deepEqual(
      buildMarketingLink(request(), { "link.pricing": path }),
      { ok: false, refusal: "origin_escaped" },
      `${path} should be refused`,
    );
  }

  // A path that stays on the origin still builds, so the refusals above are
  // about where it points and not about the registry being injected.
  const same = buildMarketingLink(request(), { "link.pricing": "/pricing" });
  assert.equal(same.ok, true);
  assert.equal(new URL(same.url).origin, MARKETING_PUBLIC_ORIGIN);

  // An id the given registry does not hold is refused before any of that.
  assert.deepEqual(buildMarketingLink(request(), {}), {
    ok: false,
    refusal: "unknown_link_id",
  });

  // And every path actually in the registry does resolve to ours.
  for (const id of MARKETING_LINK_IDS) {
    const url = new URL(MARKETING_APPROVED_LINKS[id], MARKETING_PUBLIC_ORIGIN);
    assert.equal(url.origin, MARKETING_PUBLIC_ORIGIN, id);
  }
});

test("a path that already had a query keeps one campaign, not two", () => {
  // `set` rather than an appended string: the second `?` is the bug this
  // prevents, and it is invisible until somebody reads the analytics.
  const url = new URL("/pricing?plan=pro", MARKETING_PUBLIC_ORIGIN);
  url.searchParams.set("utm_campaign", "autumn-compare");
  url.searchParams.set("utm_campaign", "autumn-compare");
  assert.equal(url.searchParams.getAll("utm_campaign").length, 1);
  assert.equal(url.searchParams.get("plan"), "pro");
});

// ---------------------------------------------------------------------------
// The channels that cannot carry a link in a caption
// ---------------------------------------------------------------------------

test("Instagram and TikTok use the account's profile link", () => {
  for (const channel of MARKETING_PROFILE_LINK_CHANNELS) {
    assert.equal(usesProfileLink(channel), true);
  }
  assert.equal(usesProfileLink("linkedin"), false);
});

test("a profile link is https, has no userinfo, and carries the campaign", () => {
  const result = buildMarketingProfileLink({
    profileUrl: "https://www.instagram.com/tomverse/",
    channel: "instagram",
    accountSlug: "instagram-1",
    campaign: "autumn-compare",
  });
  assert.equal(result.ok, true);
  const url = new URL(result.url);
  assert.equal(url.host, "www.instagram.com");
  assert.equal(url.searchParams.get("utm_content"), "instagram-1");

  for (const profileUrl of [
    "http://www.instagram.com/tomverse/",
    "https://user:pass@www.instagram.com/tomverse/",
    "not a url",
    "javascript:alert(1)",
  ]) {
    assert.deepEqual(
      buildMarketingProfileLink({
        profileUrl,
        channel: "instagram",
        accountSlug: "instagram-1",
        campaign: "autumn-compare",
      }),
      { ok: false, refusal: "origin_escaped" },
      `${profileUrl} should be refused`,
    );
  }
});

test("a slug has to belong to the channel it is tagged with", () => {
  // The database says
  // `accountSlug LIKE channel || '-%'`; carrying only the regex here let a
  // LinkedIn post go out as utm_source=linkedin&utm_content=instagram-1.
  assert.deepEqual(
    buildMarketingLink(request({ channel: "linkedin", accountSlug: "instagram-1" })),
    { ok: false, refusal: "account_slug_invalid" },
  );

  const matching = buildMarketingLink(
    request({ channel: "instagram", accountSlug: "instagram-1" }),
  );
  assert.equal(matching.ok, true);
  assert.equal(new URL(matching.url).searchParams.get("utm_source"), "instagram");

  // A prefix that merely starts the same is not the channel.
  assert.deepEqual(
    buildMarketingLink(request({ channel: "link", accountSlug: "linkedin-1" })),
    { ok: false, refusal: "account_slug_invalid" },
  );
});

test("a profile link must be on the channel's own site", () => {
  // This link goes on every post for a channel whose posts the API cannot
  // retract, so a wrong row must not be able to become a published link.
  for (const [channel, profileUrl] of [
    ["instagram", "https://evil.test/tomverse/"],
    ["instagram", "https://www.tiktok.com/@tomverse"],
    ["instagram", "https://www.instagram.com.evil.test/tomverse/"],
    ["instagram", "https://www.instagram.com:8443/tomverse/"],
    ["tiktok", "https://www.instagram.com/tomverse/"],
  ]) {
    assert.deepEqual(
      buildMarketingProfileLink({
        profileUrl,
        channel,
        accountSlug: `${channel}-1`,
        campaign: "autumn-compare",
      }),
      { ok: false, refusal: "profile_host_not_allowed" },
      `${channel} <- ${profileUrl}`,
    );
  }

  // An IDN look-alike is punycoded by the parser before the comparison, so it
  // is refused on its bytes rather than on how it reads.
  assert.deepEqual(
    buildMarketingProfileLink({
      profileUrl: "https://\u026Anstagram.com/tomverse/",
      channel: "instagram",
      accountSlug: "instagram-1",
      campaign: "autumn-compare",
    }),
    { ok: false, refusal: "profile_host_not_allowed" },
  );

  // A channel with no profile link at all cannot get one.
  assert.deepEqual(
    buildMarketingProfileLink({
      profileUrl: "https://www.linkedin.com/company/tomverse/",
      channel: "linkedin",
      accountSlug: "linkedin-1",
      campaign: "autumn-compare",
    }),
    { ok: false, refusal: "profile_host_not_allowed" },
  );
});

test("a URL longer than the field it is stored in is refused", () => {
  // r4 amendment 9 caps an https URL field at 2,048 characters.
  const long = `https://www.instagram.com/${"a".repeat(2100)}`;
  assert.deepEqual(
    buildMarketingProfileLink({
      profileUrl: long,
      channel: "instagram",
      accountSlug: "instagram-1",
      campaign: "autumn-compare",
    }),
    { ok: false, refusal: "url_too_long" },
  );

  assert.deepEqual(
    buildMarketingLink(request(), { "link.pricing": `/${"a".repeat(2100)}` }),
    { ok: false, refusal: "url_too_long" },
  );
});
