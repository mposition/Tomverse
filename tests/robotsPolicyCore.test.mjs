import assert from "node:assert/strict";
import test from "node:test";

import {
  deploymentOrigin,
  robotsDecision,
  servesCanonicalSite,
} from "../lib/robotsPolicyCore.ts";

const SITE = "https://tomverse.app";

/**
 * The bug this exists for, as it actually happened.
 *
 * `app/robots.ts` emitted `allow: "/"` from every deployment, so staging said
 * yes to crawlers and named production as its canonical host while doing it.
 * The 2026-08-23 Search Console export carried
 * `https://staging.tomverse.app/safety` -- indexed, from a deployment whose
 * whole job is to hold changes nobody has released.
 */
test("staging is not the canonical site", () => {
  const decision = robotsDecision(SITE, {
    PUBLIC_APP_URL: "https://staging.tomverse.app",
  });
  assert.deepEqual(decision, {
    kind: "disallow_all",
    origin: "https://staging.tomverse.app",
  });
});

test("the canonical origin is the canonical site", () => {
  assert.deepEqual(robotsDecision(SITE, { PUBLIC_APP_URL: SITE }), {
    kind: "canonical",
  });
});

/**
 * A trailing slash and a capital letter are the same host, and a robots file
 * that de-indexed a site over either would be a worse bug than the one being
 * fixed.
 */
test("a trailing slash or different case is the same host", () => {
  for (const value of ["https://tomverse.app/", "HTTPS://Tomverse.App"]) {
    assert.equal(servesCanonicalSite(SITE, { PUBLIC_APP_URL: value }), true, value);
  }
});

/**
 * The asymmetry, pinned. Staging left crawlable is bounded and slow to undo;
 * production serving `disallow: /` because one variable went missing
 * de-indexes everything and recovers on Google's schedule. So nothing
 * established means production.
 */
test("an origin that was never established reads as production", () => {
  assert.equal(servesCanonicalSite(SITE, {}), true);
  assert.equal(servesCanonicalSite(SITE, { PUBLIC_APP_URL: "" }), true);
  assert.equal(servesCanonicalSite(SITE, { PUBLIC_APP_URL: "not a url" }), true);
});

/** The precedence the rest of the app already uses. */
test("PUBLIC_APP_URL wins over NEXT_PUBLIC_APP_URL", () => {
  assert.equal(
    deploymentOrigin({
      PUBLIC_APP_URL: "https://staging.tomverse.app",
      NEXT_PUBLIC_APP_URL: SITE,
    }),
    "https://staging.tomverse.app"
  );
  assert.equal(deploymentOrigin({ NEXT_PUBLIC_APP_URL: SITE }), SITE);
});

/** A preview host is not staging and is not production either. */
test("any other origin is refused too", () => {
  assert.equal(
    servesCanonicalSite(SITE, { PUBLIC_APP_URL: "https://tomverse-pr-12.up.railway.app" }),
    false
  );
});
