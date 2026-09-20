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
  MARKETING_PROFILE_LINKS,
  MARKETING_PROFILE_LINK_CHANNELS,
  MARKETING_PUBLIC_ORIGIN,
  buildMarketingLink,
  buildMarketingProfileLink,
  usesProfileLink,
} from "../lib/marketingLinks.ts";

/** A registered account, the way S2 will write one. */
const profiles = (overrides = {}) => ({
  "instagram-1": { channel: "instagram", url: "https://www.instagram.com/tomverse/" },
  "tiktok-1": { channel: "tiktok", url: "https://www.tiktok.com/@tomverse" },
  ...overrides,
});

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

// ---------------------------------------------------------------------------
// The profile link, which belongs to an account rather than to a caller
// ---------------------------------------------------------------------------

const profileRequest = (overrides = {}) => ({
  channel: "instagram",
  accountSlug: "instagram-1",
  campaign: "autumn-compare",
  ...overrides,
});

test("the registry ships empty, so no profile link resolves yet", () => {
  // The accounts are created in S2. An entry here is a URL somebody checked,
  // so the registry is empty for the same reason the claim registry is.
  assert.deepEqual(Object.keys(MARKETING_PROFILE_LINKS), []);
  assert.deepEqual(buildMarketingProfileLink(profileRequest()), {
    ok: false,
    refusal: "profile_link_not_registered",
  });
});

test("a registered account gets its own link, with the campaign on it", () => {
  const result = buildMarketingProfileLink(profileRequest(), profiles());
  assert.equal(result.ok, true);

  const url = new URL(result.url);
  assert.equal(url.host, "www.instagram.com");
  assert.equal(url.pathname, "/tomverse/");
  assert.equal(url.searchParams.get("utm_content"), "instagram-1");
  assert.equal(url.searchParams.get("utm_source"), "instagram");
});

test("the right host is not the right account", () => {
  // The defect a host allowlist alone leaves: a competitor's profile is on
  // Instagram's host, and §7.3 says the account's *own* fixed profile link.
  const impostor = profiles({
    "instagram-1": {
      channel: "instagram",
      url: "https://www.instagram.com/competitor/",
    },
  });
  const result = buildMarketingProfileLink(profileRequest(), impostor);

  // The builder cannot tell this from the real one -- which is the point of
  // the registry being written and reviewed rather than passed in. What it can
  // tell is that the URL came from the registry and not from the caller, and
  // there is no parameter left through which a caller could supply one.
  assert.equal(result.ok, true);
  assert.equal(new URL(result.url).pathname, "/competitor/");

  // What it can tell is that the URL came from the registry and not from the
  // caller. A `profileUrl` on the request is simply not read any more, so the
  // parameter that made this a caller's decision is gone rather than guarded.
  const withSuppliedUrl = buildMarketingProfileLink(
    profileRequest({ profileUrl: "https://www.instagram.com/attacker/" }),
    profiles(),
  );
  assert.equal(withSuppliedUrl.ok, true);
  assert.equal(new URL(withSuppliedUrl.url).pathname, "/tomverse/");
});

test("an account registered to another channel is not this channel's", () => {
  assert.deepEqual(
    buildMarketingProfileLink(
      profileRequest({ channel: "tiktok", accountSlug: "tiktok-1" }),
      profiles({
        "tiktok-1": {
          channel: "instagram",
          url: "https://www.instagram.com/tomverse/",
        },
      }),
    ),
    { ok: false, refusal: "profile_link_not_registered" },
  );
});

test("a channel that can carry a link in its caption gets no profile link", () => {
  assert.deepEqual(
    buildMarketingProfileLink(
      profileRequest({ channel: "linkedin", accountSlug: "linkedin-1" }),
      profiles({
        "linkedin-1": {
          channel: "linkedin",
          url: "https://www.linkedin.com/company/tomverse/",
        },
      }),
    ),
    { ok: false, refusal: "profile_link_not_registered" },
  );
});

test("a registry entry typed wrong is caught by the host check", () => {
  for (const url of [
    "https://evil.test/tomverse/",
    "https://www.tiktok.com/@tomverse",
    "https://www.instagram.com.evil.test/tomverse/",
    "https://www.instagram.com:8443/tomverse/",
    "https://ɪnstagram.com/tomverse/",
  ]) {
    assert.deepEqual(
      buildMarketingProfileLink(
        profileRequest(),
        profiles({ "instagram-1": { channel: "instagram", url } }),
      ),
      { ok: false, refusal: "profile_host_not_allowed" },
      url,
    );
  }

  for (const url of [
    "http://www.instagram.com/tomverse/",
    "https://user:pass@www.instagram.com/tomverse/",
    "not a url",
    "javascript:alert(1)",
  ]) {
    assert.deepEqual(
      buildMarketingProfileLink(
        profileRequest(),
        profiles({ "instagram-1": { channel: "instagram", url } }),
      ),
      { ok: false, refusal: "origin_escaped" },
      url,
    );
  }
});

test("a URL longer than the field it is stored in is refused", () => {
  // r4 amendment 9 caps an https URL field at 2,048 characters.
  assert.deepEqual(
    buildMarketingProfileLink(
      profileRequest(),
      profiles({
        "instagram-1": {
          channel: "instagram",
          url: `https://www.instagram.com/${"a".repeat(2100)}`,
        },
      }),
    ),
    { ok: false, refusal: "url_too_long" },
  );

  // And the cap is applied after the campaign parameters, because they are
  // part of the link that gets stored and posted. This URL is under the cap
  // until the four utm parameters go on it.
  assert.deepEqual(
    buildMarketingProfileLink(
      profileRequest(),
      profiles({
        "instagram-1": {
          channel: "instagram",
          url: `https://www.instagram.com/${"a".repeat(2000)}`,
        },
      }),
    ),
    { ok: false, refusal: "url_too_long" },
  );

  assert.deepEqual(
    buildMarketingLink(request(), { "link.pricing": `/${"a".repeat(2100)}` }),
    { ok: false, refusal: "url_too_long" },
  );
});
