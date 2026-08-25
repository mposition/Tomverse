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

import {
  applicationServedBody,
  carriesManagedBlock,
  isPathAllowed,
} from "../lib/robotsTxtCore.ts";
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

// A second bucket, for one situation only: an assertion about the merged file
// that we cannot satisfy because Cloudflare supplies the half that breaks it.
//
// This is not a softer `expect`. Everything we own -- our half of the body,
// the `noindex` header -- stays in `expect` and still fails the run. What
// moves here is the merged-file outcome on a non-canonical origin while the
// managed block is present, because turning that block off is gated behind a
// plan we do not have (docs/ops/search-indexing-boundary.md §4a).
//
// A check that is red for something nobody can fix is a check people stop
// reading, and the value of this one is that its red means something. So the
// blocked item is reported by name on every run, loudly, and the exit code is
// reserved for what someone can act on. If the managed block ever goes away,
// `managed` is false and these assertions become ordinary failures again --
// no flag to remember to unset.
const deviations = [];
const expectOrDeviate = (condition, message, deviate) => {
  if (condition) return;
  (deviate ? deviations : failures).push(message);
};

const { body } = await fetchText("/robots.txt");
const { headers: rootHeaders } = await fetchText("/");

// Two bodies, two questions. `served` is what a crawler will act on, splice
// and all. `own` is the half this application produced -- and while the
// Cloudflare managed block is still on, only `own` can tell you whether our
// policy would survive turning it off. Checking the merged file alone reported
// production as correct on 2026-08-25 while `app/robots.ts` named no AI
// crawler at all; Cloudflare's half was doing that work.
const served = body;
const own = applicationServedBody(body);
const managed = carriesManagedBlock(body);

if (canonical) {
  // Effective, on the whole file.
  expect(isPathAllowed(served, "Googlebot", "/"), "Googlebot is refused / on the canonical site");
  expect(!isPathAllowed(served, "Googlebot", "/admin"), "/admin is not refused");
  expect(!isPathAllowed(served, "Googlebot", "/share/x"), "/share is not refused");
  // Ours, on our half only.
  for (const crawler of REFUSED_AI_CRAWLERS) {
    expect(
      !isPathAllowed(own, crawler, "/"),
      `${crawler} is not refused by our own robots.txt${managed ? " (only by Cloudflare's block)" : ""}`
    );
  }
  expect(/^Sitemap:/m.test(own), "the canonical site does not name its sitemap");
  expect(/^Host:/m.test(own), "the canonical site does not name its host");
  expect(
    !/noindex/i.test(rootHeaders.get("x-robots-tag") ?? ""),
    "the canonical site sends X-Robots-Tag: noindex on /"
  );
} else {
  // What our own file says is ours, and is never excused.
  for (const crawler of ["Googlebot", "Bingbot", "GPTBot"]) {
    expect(
      !isPathAllowed(own, crawler, "/"),
      `${crawler} is not refused / by our own robots.txt`
    );
    expect(
      !isPathAllowed(own, crawler, "/safety"),
      `${crawler} is not refused /safety by our own robots.txt`
    );
    // What the merged file says is only ours when nobody else is writing in it.
    expectOrDeviate(
      !isPathAllowed(served, crawler, "/"),
      `${crawler} may crawl / — Cloudflare's managed block supplies an Allow: / group that outranks ours`,
      managed
    );
  }
  expect(!/^Sitemap:/m.test(own), "a non-canonical origin advertises a sitemap");
  expect(!/^Host:/m.test(own), "a non-canonical origin claims a canonical host");
  // The load-bearing one while the above is deviated. robots.txt suppresses the
  // fetch; this suppresses the listing, and Google reads it only on a page it
  // was allowed to fetch -- so with crawling permitted this is both what keeps
  // staging out of the index and what gets an already-indexed URL dropped.
  expect(
    /noindex/i.test(rootHeaders.get("x-robots-tag") ?? ""),
    "a non-canonical origin does not send X-Robots-Tag: noindex on /"
  );
}

const role = canonical ? "canonical site" : "non-canonical deployment";
if (managed) {
  console.log(
    `Note: Cloudflare's managed robots.txt block is still served on ${origin}. ` +
      "Every assertion about our own policy above was made against our half of the file."
  );
}
if (deviations.length) {
  console.log(`\nKnown deviations for ${origin} — see docs/ops/search-indexing-boundary.md §4a:`);
  for (const deviation of deviations) console.log(`  ~ ${deviation}`);
  console.log(
    "  These are not failures because the fix is a Cloudflare zone setting this account's plan\n" +
      "  cannot change. They stop being deviations the moment the managed block is gone."
  );
}
if (failures.length) {
  console.error(`Edge robots check FAILED for ${origin} (${role}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("\nServed robots.txt:\n");
  console.error(body);
  process.exit(1);
}

console.log(`Edge robots check passed for ${origin} (${role}).`);
