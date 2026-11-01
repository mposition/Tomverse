import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "../lib/marketingAutomationAccess.ts";
import {
  EXPERIMENT_CONTROL_ARM,
  EXPERIMENT_COOKIE_NAME,
  experimentVariantPathname,
  formatExperimentCookie,
  isExperimentVariantPathname,
  isStaticMarketingPathname,
  parseExperimentCookie,
  resolveExperimentRewrite,
} from "../lib/marketingRoutes.ts";

const COOKIE = "spring-hero.home-hero-v1.b";
const rewrite = (overrides = {}) =>
  resolveExperimentRewrite({
    pathname: "/",
    method: "GET",
    accept: "text/html,application/xhtml+xml",
    rscHeader: null,
    cookie: COOKIE,
    killSwitch: undefined,
    ...overrides,
  });

test("the cookie round-trips and rejects anything that is not exactly three well-formed ids", () => {
  const assignment = parseExperimentCookie(COOKIE);
  assert.deepEqual(assignment, {
    experimentId: "spring-hero",
    bundleId: "home-hero-v1",
    arm: "b",
  });
  assert.equal(formatExperimentCookie(assignment), COOKIE);
  assert.equal(EXPERIMENT_COOKIE_NAME, "tv_exp");

  for (const bad of [
    "",
    null,
    undefined,
    "spring-hero.home-hero-v1",
    "spring-hero.home-hero-v1.b.extra",
    "Spring-Hero.home-hero-v1.b",
    "spring-hero.home-hero-v1.b/../x",
    "sp.home-hero-v1.b",
    `${"a".repeat(60)}.home-hero-v1.b`,
    "spring-hero.home hero.b",
    "spring-hero..b",
  ]) {
    assert.equal(parseExperimentCookie(bad), null, String(bad));
  }
});

test("a home document load with a variant cookie is rewritten to the variant path", () => {
  assert.equal(rewrite(), "/en/lx/home-hero-v1/b");
  assert.equal(rewrite({ pathname: "/ko" }), "/ko/lx/home-hero-v1/b");
  assert.equal(rewrite({ pathname: "/en" }), "/en/lx/home-hero-v1/b");
  assert.equal(rewrite({ method: "HEAD" }), "/en/lx/home-hero-v1/b");
  assert.equal(rewrite({ pathname: "/ko/" }), "/ko/lx/home-hero-v1/b");
});

test("everything that is not a variant document load on a home page is left alone", () => {
  // The control arm and the absence of a cookie are the default page.
  assert.equal(rewrite({ cookie: `spring-hero.home-hero-v1.${EXPERIMENT_CONTROL_ARM}` }), null);
  assert.equal(rewrite({ cookie: undefined }), null);
  assert.equal(rewrite({ cookie: "garbage" }), null);
  // Only the safe document methods.
  assert.equal(rewrite({ method: "POST" }), null);
  // A Flight request is not a document, however the cookie reads.
  assert.equal(rewrite({ rscHeader: "1", accept: "*/*" }), null);
  assert.equal(rewrite({ accept: "*/*" }), null);
  assert.equal(rewrite({ accept: null }), null);
  // The kill switch overrides every cookie that already exists.
  assert.equal(rewrite({ killSwitch: "1" }), null);
  assert.equal(rewrite({ killSwitch: "   " }), "/en/lx/home-hero-v1/b");
  // Not a home page: pricing, an intent page, an unknown locale, a variant path itself.
  for (const pathname of [
    "/pricing",
    "/ko/pricing",
    "/compare-ai-models",
    "/xx",
    "/en/lx/home-hero-v1/b",
    "/api/chat",
  ]) {
    assert.equal(rewrite({ pathname }), null, pathname);
  }
  // A bundle for another surface is never routed as a home variant.
  assert.equal(rewrite({ cookie: "spring-hero.pricing-hero-v1.b" }), null);
});

test("variant paths are recognised exactly and are served as static marketing", () => {
  assert.equal(
    experimentVariantPathname("ko", "home-hero-v1", "b"),
    "/ko/lx/home-hero-v1/b"
  );
  assert.equal(isExperimentVariantPathname("/ko/lx/home-hero-v1/b"), true);
  assert.equal(isExperimentVariantPathname("/ko/lx/home-hero-v1/b/"), true);
  for (const pathname of [
    "/",
    "/ko",
    "/lx/home-hero-v1/b",
    "/ko/lx/home-hero-v1",
    "/ko/lx/home-hero-v1/b/c",
    "/xx/lx/home-hero-v1/b",
    "/ko/other/home-hero-v1/b",
    "/ko/lx/Home/b",
  ]) {
    assert.equal(isExperimentVariantPathname(pathname), false, pathname);
  }
  // Static, so the proxy computes hashes for it instead of minting a nonce
  // the prerendered HTML cannot carry.
  assert.equal(isStaticMarketingPathname("/ko/lx/home-hero-v1/b"), true);
  assert.equal(isStaticMarketingPathname("/ko/lx/Home/b"), false);
  assert.equal(isStaticMarketingPathname("/ko/unknown"), false);
});

test("the request boundary keeps the Prompt Refiner closure unchanged", () => {
  // proxy.ts is a root of the sealed runtime source closure, so this feature
  // may not add a local import to it or to marketingRoutes.ts, and neither may
  // use computed property access.
  const routes = readFileSync(new URL("../lib/marketingRoutes.ts", import.meta.url), "utf8");
  const proxy = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  const localImports = (source) =>
    [...source.matchAll(/from\s+"(@\/[^"]+|\.{1,2}\/[^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(localImports(routes), ["@/lib/apiCacheControlPolicy"]);
  assert.ok(
    !localImports(proxy).some((specifier) => /experiment/i.test(specifier)),
    "proxy.ts must not import experiment modules"
  );
  assert.ok(
    !/process\.env\[/.test(proxy) && !/process\.env\[/.test(routes),
    "no computed environment access in closure files"
  );
});

test("the proxy reads the kill switch under the name the access module defines", () => {
  // proxy.ts cannot import the constant (closure), so it spells the variable.
  const proxy = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.ok(
    proxy.includes(`process.env.${MARKETING_AUTOMATION_KILL_SWITCH_ENV}`),
    "proxy.ts spells a different kill switch variable than lib/marketingAutomationAccess.ts"
  );
});
