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
  MARKETING_CAMPAIGN_PATTERN_SOURCE,
  MARKETING_PROFILE_ACCOUNT_SLUGS,
  MARKETING_PROFILE_LINK_CHANNELS,
  MARKETING_PUBLIC_ORIGIN,
  buildMarketingLink,
  buildMarketingProfileLink,
  unsafeMarketingLinkIds,
  unsafeMarketingProfileAccounts,
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
  // Asked of the validator, not of the builder. An earlier version of this
  // test handed `buildMarketingLink` a registry of its own -- which meant the
  // publishable function had a parameter naming its destination, and a
  // production caller could have used it. The question is the same; the thing
  // being asked cannot publish.
  for (const path of [
    "//evil.test/pricing",
    "https://evil.test/pricing",
    "\\\\evil.test/pricing",
    "https://user:pass@evil.test/pricing",
    "https://tomverse.app.evil.test/pricing",
    "https://tomverse.app:8443/pricing",
  ]) {
    assert.deepEqual(
      unsafeMarketingLinkIds({ "link.pricing": path }),
      ["link.pricing"],
      `${path} should be reported`,
    );
  }

  // A path that stays on the origin is not reported, so the above is about
  // where they point rather than about the registry being a fixture.
  assert.deepEqual(unsafeMarketingLinkIds({ "link.pricing": "/pricing" }), []);

  // And the real registry is clean, which is the build-time use of this.
  assert.deepEqual(unsafeMarketingLinkIds(), []);
  for (const id of MARKETING_LINK_IDS) {
    const url = new URL(MARKETING_APPROVED_LINKS[id], MARKETING_PUBLIC_ORIGIN);
    assert.equal(url.origin, MARKETING_PUBLIC_ORIGIN, id);
  }
});

test("neither builder can be handed a registry", () => {
  // The blocker this replaced: both took one "for tests", and a caller could
  // have named any destination -- including on the channel whose posts cannot
  // be retracted. Extra arguments are ignored rather than honoured.
  const injected = buildMarketingLink(request(), {
    "link.pricing": "https://evil.test/pricing",
  });
  assert.equal(injected.ok, true);
  assert.equal(new URL(injected.url).origin, MARKETING_PUBLIC_ORIGIN);

  const injectedProfile = buildMarketingProfileLink(profileRequest(), {
    "instagram-1": {
      channel: "instagram",
      url: "https://www.instagram.com/competitor/",
    },
  });
  assert.deepEqual(injectedProfile, {
    ok: false,
    refusal: "profile_link_not_registered",
  });
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
    request({ channel: "threads", accountSlug: "threads-1" }),
  );
  assert.equal(matching.ok, true);
  assert.equal(new URL(matching.url).searchParams.get("utm_source"), "threads");

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
  assert.deepEqual(MARKETING_PROFILE_ACCOUNT_SLUGS, []);
  assert.deepEqual(buildMarketingProfileLink(profileRequest()), {
    ok: false,
    refusal: "profile_link_not_registered",
  });
});

test("a well-formed registry reports nothing unsafe", () => {
  // The builder cannot be handed a registry, so what a fixture can be asked is
  // whether every entry in it would be publishable.
  assert.deepEqual(unsafeMarketingProfileAccounts(profiles()), []);
  assert.deepEqual(unsafeMarketingProfileAccounts(), []);
});

test("the right host is not the right account", () => {
  // The defect a host allowlist alone leaves: a competitor profile sits on
  // Instagram's host, and §7.3 says the account's *own* fixed profile link.
  // Neither the builder nor the validator can tell those apart, which is why
  // the registry is written and reviewed -- and why the caller has no way to
  // supply one. The validator reports nothing, because the entry is
  // well-formed; what it is not is somebody's decision.
  assert.deepEqual(
    unsafeMarketingProfileAccounts(
      profiles({
        "instagram-1": {
          channel: "instagram",
          url: "https://www.instagram.com/competitor/",
        },
      }),
    ),
    [],
  );

  // A `profileUrl` on the request is not read: the parameter that made this a
  // caller's decision is gone rather than guarded.
  assert.deepEqual(
    buildMarketingProfileLink(
      profileRequest({ profileUrl: "https://www.instagram.com/attacker/" }),
    ),
    { ok: false, refusal: "profile_link_not_registered" },
  );
});

test("an account registered to another channel is not this channel's", () => {
  assert.deepEqual(
    unsafeMarketingProfileAccounts(
      profiles({
        "tiktok-1": {
          channel: "instagram",
          url: "https://www.instagram.com/tomverse/",
        },
      }),
    ),
    [{ accountSlug: "tiktok-1", refusal: "account_slug_invalid" }],
    "a tiktok-1 slug registered under instagram cannot name either account",
  );
});

test("a channel that can carry a link in its caption gets no profile link", () => {
  assert.deepEqual(
    unsafeMarketingProfileAccounts({
      "linkedin-1": {
        channel: "linkedin",
        url: "https://www.linkedin.com/company/tomverse/",
      },
    }),
    [{ accountSlug: "linkedin-1", refusal: "profile_link_not_registered" }],
  );

  assert.deepEqual(
    buildMarketingProfileLink(
      profileRequest({ channel: "linkedin", accountSlug: "linkedin-1" }),
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
      unsafeMarketingProfileAccounts(
        profiles({ "instagram-1": { channel: "instagram", url } }),
      ),
      [{ accountSlug: "instagram-1", refusal: "profile_host_not_allowed" }],
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
      unsafeMarketingProfileAccounts(
        profiles({ "instagram-1": { channel: "instagram", url } }),
      ),
      [{ accountSlug: "instagram-1", refusal: "origin_escaped" }],
      url,
    );
  }
});

test("a URL longer than the field it is stored in is refused", () => {
  // r4 amendment 9 caps an https URL field at 2,048 characters.
  assert.deepEqual(
    unsafeMarketingProfileAccounts(
      profiles({
        "instagram-1": {
          channel: "instagram",
          url: `https://www.instagram.com/${"a".repeat(2100)}`,
        },
      }),
    ),
    [{ accountSlug: "instagram-1", refusal: "url_too_long" }],
  );

  // And the cap is applied after the campaign parameters, because they are
  // part of the link that gets stored and posted. This URL is under the cap
  // until the four utm parameters go on it.
  assert.deepEqual(
    unsafeMarketingProfileAccounts(
      profiles({
        "instagram-1": {
          channel: "instagram",
          url: `https://www.instagram.com/${"a".repeat(2000)}`,
        },
      }),
    ),
    [{ accountSlug: "instagram-1", refusal: "url_too_long" }],
  );

  assert.deepEqual(
    unsafeMarketingLinkIds({ "link.pricing": `/${"a".repeat(2100)}` }),
    ["link.pricing"],
  );
});

test("the channels that use a profile link get no ordinary link", () => {
  // The other direction of the channel rule. `buildMarketingProfileLink()`
  // refuses a channel that can carry a link in its caption; without this, the
  // two that cannot could still be handed a per-post URL -- on exactly the
  // channels whose posts no API can retract.
  for (const channel of MARKETING_PROFILE_LINK_CHANNELS) {
    assert.deepEqual(
      buildMarketingLink(
        request({ channel, accountSlug: `${channel}-1` }),
      ),
      { ok: false, refusal: "channel_uses_profile_link" },
      channel,
    );
  }

  // And a channel that can carry one still gets it.
  assert.equal(buildMarketingLink(request()).ok, true);
});

test("neither registry can be edited through what is exported", () => {
  // `as const` and `Readonly<>` are compile-time claims, and `Object.freeze` is
  // shallow. A writable entry would have reopened the hole the profile
  // registry closed: a competitor URL on an allowed host passes every check.
  assert.throws(
    () => {
      "use strict";
      MARKETING_APPROVED_LINKS["link.pricing"] = "/evil";
    },
    TypeError,
    "an approved path decides where a published post sends people",
  );

  // The profile registry is not exported at all; only its slugs are, and that
  // list is frozen too.
  assert.throws(
    () => {
      "use strict";
      MARKETING_PROFILE_ACCOUNT_SLUGS.push("instagram-1");
    },
    TypeError,
  );

  assert.equal(buildMarketingLink(request()).ok, true);
  assert.equal(new URL(buildMarketingLink(request()).url).pathname, "/pricing");
});

test("the profile-link channel list cannot be spliced out from under the rule", () => {
  // `as const` is erased at build time. Removing "instagram" from this array
  // would make `usesProfileLink()` false and skip the refusal above, which is
  // the round-4 bypass reopened through a different shared object.
  assert.equal(Object.isFrozen(MARKETING_PROFILE_LINK_CHANNELS), true);
  assert.throws(
    () => {
      "use strict";
      MARKETING_PROFILE_LINK_CHANNELS.splice(0, 1);
    },
    TypeError,
  );

  assert.deepEqual(
    buildMarketingLink(request({ channel: "instagram", accountSlug: "instagram-1" })),
    { ok: false, refusal: "channel_uses_profile_link" },
  );
});

test("the channel refusal comes before the link id is looked up", () => {
  // So the answer for one of these channels is the same whichever id was
  // asked for, rather than depending on whether the id happened to exist.
  assert.deepEqual(
    buildMarketingLink(
      request({
        channel: "tiktok",
        accountSlug: "tiktok-1",
        linkId: "link.does-not-exist",
      }),
    ),
    { ok: false, refusal: "channel_uses_profile_link" },
  );
});

test("the campaign shape cannot be replaced from outside the module", () => {
  // A RegExp carries its own mutable matcher: `.compile()` replaces the
  // pattern in place and `Object.freeze` does not stop it. So the pattern is
  // not exported -- what is exported is its source, which is a string and
  // cannot be tested with.
  assert.equal(typeof MARKETING_CAMPAIGN_PATTERN_SOURCE, "string");

  // Loosening a local copy built from that source changes nothing, because the
  // builder does not read it.
  const mine = new RegExp(MARKETING_CAMPAIGN_PATTERN_SOURCE);
  mine.compile(/.*/);
  assert.equal(mine.test("Autumn Compare"), true, "the local copy is loosened");

  assert.deepEqual(
    buildMarketingLink(request({ campaign: "Autumn Compare" })),
    { ok: false, refusal: "campaign_invalid" },
    "and the builder still refuses it",
  );
});
