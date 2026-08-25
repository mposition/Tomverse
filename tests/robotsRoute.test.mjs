import assert from "node:assert/strict";
import test from "node:test";

import { isPathAllowed } from "../lib/robotsTxtCore.ts";
import { CONTENT_SIGNAL, REFUSED_AI_CRAWLERS } from "../lib/robotsPolicyCore.ts";

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
