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
  // The registry is a fixed list, so this is about the check rather than about
  // today's data: these are the four shapes that leave an origin when they are
  // resolved against it, and the assertion is that the parser's answer is what
  // decides.
  for (const path of [
    "//evil.test/pricing",
    "https://evil.test/pricing",
    "\\\\evil.test/pricing",
    "https://user:pass@evil.test/pricing",
  ]) {
    const url = new URL(path, MARKETING_PUBLIC_ORIGIN);
    assert.notEqual(
      url.origin,
      MARKETING_PUBLIC_ORIGIN,
      `${path} should not resolve to our origin`,
    );
  }

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
