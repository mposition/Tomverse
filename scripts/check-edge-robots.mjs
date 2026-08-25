// Verifies what a deployment's *edge* serves, not what the application returns.
//
// The distinction is the whole point. On 2026-08-25 staging's application
// served `User-Agent: * / Disallow: /` and staging was still crawlable,
// because Cloudflare's managed robots.txt setting prepended its own
// `User-agent: * / Allow: /` group to the response. Both strings were in the
// file; by RFC 9309 the groups merge, and Google resolves an equally specific
// conflict towards `Allow`.
//
// So this script asks lib/robotsTxtCore.ts what the served body *means*, and
// asks it of the public URL rather than of the origin. A check that grepped
// for `Disallow: /` would have passed throughout.
//
//   npm run check:edge-robots -- https://staging.tomverse.app
//   npm run check:edge-robots -- https://tomverse.app

import { isPathAllowed } from "../lib/robotsTxtCore.ts";
import { REFUSED_AI_CRAWLERS, servesCanonicalSite } from "../lib/robotsPolicyCore.ts";
import { SITE_ORIGIN } from "../lib/seo.ts";

const target = process.argv[2];
if (!target) {
  console.error("Usage: npm run check:edge-robots -- <origin>");
  process.exit(2);
}

const origin = new URL(target).origin;
const canonical = servesCanonicalSite(SITE_ORIGIN, { PUBLIC_APP_URL: origin });

// A query string the edge has not cached yet. `robots.txt` is served with a
// four-hour max-age, so without this the script can report a copy from before
// the deployment it is meant to be checking.
const bust = `cb=${Date.now()}`;

const fetchText = async (path) => {
  const response = await fetch(`${origin}${path}${path.includes("?") ? "&" : "?"}${bust}`, {
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return { body: await response.text(), headers: response.headers };
};

const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

const { body } = await fetchText("/robots.txt");
const { headers: rootHeaders } = await fetchText("/");

if (canonical) {
  expect(isPathAllowed(body, "Googlebot", "/"), "Googlebot is refused / on the canonical site");
  expect(!isPathAllowed(body, "Googlebot", "/admin"), "/admin is not refused");
  expect(!isPathAllowed(body, "Googlebot", "/share/x"), "/share is not refused");
  for (const crawler of REFUSED_AI_CRAWLERS) {
    expect(!isPathAllowed(body, crawler, "/"), `${crawler} is not refused`);
  }
  expect(/^Sitemap:/m.test(body), "the canonical site does not name its sitemap");
  expect(
    !/noindex/i.test(rootHeaders.get("x-robots-tag") ?? ""),
    "the canonical site sends X-Robots-Tag: noindex on /"
  );
} else {
  for (const crawler of ["Googlebot", "Bingbot", "GPTBot"]) {
    expect(!isPathAllowed(body, crawler, "/"), `${crawler} may crawl / on a non-canonical origin`);
    expect(
      !isPathAllowed(body, crawler, "/safety"),
      `${crawler} may crawl /safety on a non-canonical origin`
    );
  }
  expect(!/^Sitemap:/m.test(body), "a non-canonical origin advertises a sitemap");
  expect(!/^Host:/m.test(body), "a non-canonical origin claims a canonical host");
  // robots.txt suppresses the fetch; this suppresses the listing. Google is
  // explicit that a disallowed URL can still appear in results when something
  // links to it, so the header is the part that keeps staging out of the index.
  expect(
    /noindex/i.test(rootHeaders.get("x-robots-tag") ?? ""),
    "a non-canonical origin does not send X-Robots-Tag: noindex on /"
  );
}

const role = canonical ? "canonical site" : "non-canonical deployment";
if (failures.length) {
  console.error(`Edge robots check FAILED for ${origin} (${role}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("\nServed robots.txt:\n");
  console.error(body);
  process.exit(1);
}

console.log(`Edge robots check passed for ${origin} (${role}).`);
