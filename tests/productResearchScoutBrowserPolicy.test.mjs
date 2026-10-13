import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AbortTally,
  SCOUT_LOCALES,
  SCOUT_PAGE_ORIGIN,
  SCOUT_PAGES,
  decideScoutRequest,
  isBotChallenge,
  isScoutCausedConsoleError,
  originOf,
} from "../lib/productResearchScoutBrowserPolicy.mjs";

const allowedOrigins = [SCOUT_PAGE_ORIGIN];

test("the page table is the policy's twenty pages, in order, with unique ids", () => {
  // docs/policy/product-research-agent.md §12. A change here is a policy change.
  assert.deepEqual(
    SCOUT_PAGES.map(({ id, path, lang }) => `${id} ${path} ${lang}`),
    [
      "home.en / en",
      "pricing.en /pricing en",
      "models.en /models en",
      "compare-ai-models.en /compare-ai-models en",
      "chatgpt-vs-claude.en /chatgpt-vs-claude en",
      "ai-for-file-analysis.en /ai-for-file-analysis en",
      "about.en /about en",
      "faq.en /faq en",
      "support.en /support en",
      "help-centre.en /support/help-centre en",
      "privacy.en /privacy en",
      "terms.en /terms en",
      "safety.en /safety en",
      "chat-guest.en /chat en",
      "home.ko / ko",
      "pricing.ko /pricing ko",
      "models.ko /models ko",
      "faq.ko /faq ko",
      "support.ko /support ko",
      "chat-guest.ko /chat ko",
    ],
  );
  assert.equal(new Set(SCOUT_PAGES.map(({ id }) => id)).size, 20);
  assert.equal(SCOUT_PAGE_ORIGIN, "https://tomverse.app");
  for (const { lang } of SCOUT_PAGES) assert.ok(SCOUT_LOCALES[lang], `locale for ${lang}`);
  assert.ok(Object.isFrozen(SCOUT_PAGES) && SCOUT_PAGES.every((page) => Object.isFrozen(page)));
});

test("only GET and HEAD leave the browser, whatever the case", () => {
  for (const method of ["GET", "get", "HEAD", "head"]) {
    assert.deepEqual(decideScoutRequest({ method, url: `${SCOUT_PAGE_ORIGIN}/x`, allowedOrigins }), { allow: true });
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE", "post", ""]) {
    assert.deepEqual(
      decideScoutRequest({ method, url: `${SCOUT_PAGE_ORIGIN}/x`, allowedOrigins }),
      { allow: false, reason: "method" },
      method,
    );
  }
});

test("the method is judged before the origin, so a forbidden method never reads as an origin miss", () => {
  assert.deepEqual(
    decideScoutRequest({ method: "POST", url: "https://elsewhere.example/x", allowedOrigins }),
    { allow: false, reason: "method" },
  );
});

test("an origin must match exactly: scheme, host and port", () => {
  for (const url of [
    "http://tomverse.app/",
    "https://tomverse.app:8443/",
    "https://www.tomverse.app/",
    "https://staging.tomverse.app/",
    "https://tomverse.app.evil.example/",
    "https://evil.example/?https://tomverse.app",
  ]) {
    assert.deepEqual(decideScoutRequest({ method: "GET", url, allowedOrigins }), { allow: false, reason: "origin" }, url);
  }
  assert.deepEqual(
    decideScoutRequest({ method: "GET", url: "https://tomverse.app:443/pricing", allowedOrigins }),
    { allow: true },
  );
});

test("opaque and unparsable URLs are refused, never treated as same-origin", () => {
  for (const url of ["data:text/html,hi", "blob:https://tomverse.app/abc", "about:blank", "javascript:alert(1)", "not a url", "ws://tomverse.app/"]) {
    const decision = decideScoutRequest({ method: "GET", url, allowedOrigins });
    assert.equal(decision.allow, false, url);
    assert.equal(decision.reason, "invalid_url", url);
  }
  assert.equal(originOf("blob:https://tomverse.app/abc"), null);
  assert.equal(originOf("https://tomverse.app/a?b#c"), "https://tomverse.app");
});

test("a bot challenge is recognised by its header or by the Cloudflare interstitial", () => {
  assert.equal(isBotChallenge({ status: 200, headers: { "cf-mitigated": "challenge" }, title: "" }), true);
  assert.equal(isBotChallenge({ status: 403, headers: { server: "cloudflare" }, title: "Just a moment..." }), true);
  assert.equal(isBotChallenge({ status: 503, headers: { server: "cloudflare" }, title: "Attention Required! | Cloudflare" }), true);
  // An ordinary page, an ordinary error and a page that merely says the words.
  assert.equal(isBotChallenge({ status: 200, headers: { server: "cloudflare" }, title: "Tomverse" }), false);
  assert.equal(isBotChallenge({ status: 404, headers: { server: "cloudflare" }, title: "Not found" }), false);
  assert.equal(isBotChallenge({ status: 200, headers: { server: "cloudflare" }, title: "Just a moment, please" }), false);
  assert.equal(isBotChallenge({ status: 503, headers: { server: "railway-edge" }, title: "Just a moment" }), false);
});

test("the abort tally keeps method and origin and drops the path", () => {
  const tally = new AbortTally();
  tally.add({ reason: "method", method: "post", url: "https://tomverse.app/api/consent?token=secret" });
  tally.add({ reason: "method", method: "POST", url: "https://tomverse.app/other/path" });
  tally.add({ reason: "origin", method: "GET", url: "https://cdn.example:8443/a.js" });
  tally.add({ reason: "invalid_url", method: "GET", url: "data:text/plain,x" });
  const entries = tally.entries();
  assert.deepEqual(entries, [
    { reason: "invalid_url", method: "GET", origin: "opaque", count: 1 },
    { reason: "method", method: "POST", origin: "https://tomverse.app", count: 2 },
    { reason: "origin", method: "GET", origin: "https://cdn.example:8443", count: 1 },
  ]);
  assert.ok(!JSON.stringify(entries).includes("secret"));
  assert.ok(!JSON.stringify(entries).includes("/api/consent"));
});

test("console errors the scout's own blocking caused are told apart by their error code", () => {
  assert.equal(isScoutCausedConsoleError("Failed to load resource: net::ERR_BLOCKED_BY_CLIENT.Inspector"), true);
  assert.equal(isScoutCausedConsoleError("Failed to load resource: net::ERR_NAME_NOT_RESOLVED"), true);
  // Real page failures stay in UI-02.
  assert.equal(isScoutCausedConsoleError("Failed to load resource: the server responded with a status of 500 ()"), false);
  assert.equal(isScoutCausedConsoleError("Failed to load resource: net::ERR_CONNECTION_REFUSED"), false);
  assert.equal(isScoutCausedConsoleError("TypeError: Cannot read properties of undefined"), false);
  assert.equal(isScoutCausedConsoleError("net::ERR_BLOCKED_BY_CLIENTX"), false);
});
