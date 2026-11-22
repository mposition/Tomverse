import assert from "node:assert/strict";
import test from "node:test";

import { isPathAllowed } from "../lib/robotsTxtCore.ts";
import {
  CONTENT_SIGNAL,
  REFUSED_AI_CRAWLERS,
  SEARCH_INDEX_CRAWLERS,
  USER_REQUEST_FETCHERS,
} from "../lib/robotsPolicyCore.ts";

/**
 * The route's contract, checked against the text it really produces.
 *
 * `resolveRobots` is the function Next itself uses to turn the object
 * `app/robots.ts` returns into the response body, so rendering through it
 * means these assertions are about the served file rather than about an
 * object shape that happens to look right. The rules are then read by
 * lib/robotsTxtCore.ts, because "the file contains Disallow: /" is exactly the
 * check that passed while staging was crawlable.
 */
const { resolveRobots } = await import(
  "next/dist/build/webpack/loaders/metadata/resolve-route-data.js"
);
const route = (await import("../app/robots.ts")).default;

const render = (origin) => {
  const previous = process.env.PUBLIC_APP_URL;
  process.env.PUBLIC_APP_URL = origin;
  try {
    return resolveRobots(route());
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = previous;
  }
};

const PRODUCTION = () => render("https://tomverse.app");
const STAGING = () => render("https://staging.tomverse.app");

test("the canonical site invites search engines in", () => {
  const body = PRODUCTION();
  assert.equal(isPathAllowed(body, "Googlebot", "/"), true);
  assert.equal(isPathAllowed(body, "Googlebot", "/compare-ai-models"), true);
});

test("the canonical site still keeps crawlers out of the private surfaces", () => {
  const body = PRODUCTION();
  for (const path of ["/admin", "/api/health", "/auth/signin", "/e2e", "/chat", "/chat/abc", "/share/x"]) {
    assert.equal(isPathAllowed(body, "Googlebot", path), false, path);
  }
});

/**
 * The half of Cloudflare's managed block that was worth keeping. Each of these
 * used to be refused by Cloudflare's file; after the zone setting is turned
 * off, this route is the only thing refusing them.
 */
test("every refused AI crawler is refused by our own file", () => {
  const body = PRODUCTION();
  for (const crawler of REFUSED_AI_CRAWLERS) {
    assert.equal(isPathAllowed(body, crawler, "/"), false, crawler);
  }
  assert.ok(REFUSED_AI_CRAWLERS.length > 0);
});

/** The other half: the declaration, not the refusal. */
test("the canonical site declares its content signals", () => {
  assert.match(PRODUCTION(), new RegExp(`^Content-Signal: ${CONTENT_SIGNAL}$`, "m"));
});

/**
 * Search indexers and user-triggered fetchers are invited by name, on exactly
 * the `*` terms. Named, because a named group replaces `*` for that crawler
 * (RFC 9309 §2.2.1) -- so each of these groups must repeat the private
 * exclusions itself, or the named crawler would be *more* welcome than
 * Googlebot, into /admin included.
 */
test("search index crawlers and user-request fetchers get the canonical access, by name", () => {
  const body = PRODUCTION();
  assert.ok(SEARCH_INDEX_CRAWLERS.length > 0);
  assert.ok(USER_REQUEST_FETCHERS.length > 0);
  for (const crawler of [...SEARCH_INDEX_CRAWLERS, ...USER_REQUEST_FETCHERS]) {
    assert.equal(isPathAllowed(body, crawler, "/"), true, crawler);
    assert.equal(isPathAllowed(body, crawler, "/compare-ai-models"), true, crawler);
    for (const path of ["/admin", "/api/health", "/auth/signin", "/e2e", "/chat", "/chat/abc", "/share/x"]) {
      assert.equal(isPathAllowed(body, crawler, path), false, `${crawler} ${path}`);
    }
  }
});

/**
 * The other half of what a named group replaces: the Content-Signal line sits
 * in the `*` group, and a consumer that reads the signal from the group
 * matching its own token would see nothing there. So every invited named
 * group repeats the declaration, verbatim.
 */
test("every invited named group carries the Content-Signal its crawlers read", () => {
  const body = PRODUCTION();
  for (const crawler of [...SEARCH_INDEX_CRAWLERS, ...USER_REQUEST_FETCHERS]) {
    // resolveRobots renders one blank-line-separated block per rule; the
    // crawler's block is the one with a User-Agent line naming it.
    const block = body
      .split("\n\n")
      .find((candidate) => candidate.split("\n").includes(`User-Agent: ${crawler}`));
    assert.ok(block, `${crawler} has no group of its own`);
    assert.match(
      block,
      new RegExp(`^Content-Signal: ${CONTENT_SIGNAL}$`, "m"),
      `${crawler}'s group does not declare the Content-Signal`
    );
  }
});

/**
 * Product tokens match exactly. Inviting an operator's search and
 * user-request bots does nothing for its training crawler, which stays on the
 * refused list.
 */
test("an invited fetcher does not pardon the same operator's training crawler", () => {
  const body = PRODUCTION();
  assert.equal(isPathAllowed(body, "GPTBot", "/"), false);
  assert.equal(isPathAllowed(body, "ChatGPT-User", "/"), true);
  assert.equal(isPathAllowed(body, "ClaudeBot", "/"), false);
  assert.equal(isPathAllowed(body, "Claude-User", "/"), true);
});

test("the canonical site names its sitemap and host", () => {
  const body = PRODUCTION();
  assert.match(body, /^Sitemap: https:\/\/tomverse\.app\/sitemap\.xml$/m);
  assert.match(body, /^Host: https:\/\/tomverse\.app$/m);
});

test("a non-canonical deployment refuses every crawler, for every path", () => {
  const body = STAGING();
  for (const crawler of ["Googlebot", "Bingbot", "GPTBot", "SomethingNew"]) {
    assert.equal(isPathAllowed(body, crawler, "/"), false, crawler);
    assert.equal(isPathAllowed(body, crawler, "/safety"), false, crawler);
  }
});

/**
 * Not decoration. A `Sitemap:` or `Host:` line here points a crawler back at
 * production from a deployment that just refused it, and the `host` directive
 * on a non-canonical origin is how staging came to claim production's
 * canonical host in the first place.
 */
test("a non-canonical deployment advertises nothing", () => {
  const body = STAGING();
  assert.doesNotMatch(body, /^Sitemap:/m);
  assert.doesNotMatch(body, /^Host:/m);
  assert.doesNotMatch(body, /^Content-Signal:/m);
});

/**
 * The refusal has to be the only `*` group in the file. A second one -- an AI
 * crawler carve-out, a signal line with its own `Allow` -- would merge with it
 * and win the tie, which is precisely what Cloudflare's block did.
 */
test("the non-canonical body carries exactly one group", () => {
  const groups = STAGING().match(/^User-Agent:/gim) ?? [];
  assert.equal(groups.length, 1);
});

/**
 * `next.config.ts` cannot import `lib/seo.ts` -- it is loaded by Next's config
 * loader, outside the app's module graph -- so it repeats the canonical origin
 * as a literal. One copy, and this is what stops the two from drifting: a
 * config that disagreed with `SITE_ORIGIN` would put the `noindex` header on
 * production, or leave it off staging, with nothing else to notice.
 */
test("next.config.ts and lib/seo.ts name the same canonical origin", async () => {
  const { readFile } = await import("node:fs/promises");
  const { SITE_ORIGIN } = await import("../lib/seo.ts");
  const config = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
  const declared = config.match(/const CANONICAL_SITE_ORIGIN = "([^"]+)";/);
  assert.ok(declared, "next.config.ts no longer declares CANONICAL_SITE_ORIGIN");
  assert.equal(declared[1], SITE_ORIGIN);
});
