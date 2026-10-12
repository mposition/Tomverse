import assert from "node:assert/strict";
import test from "node:test";
import {
  isStaticMarketingPathname,
  LOCALIZED_MARKETING_BASE_PATHS,
  localizedMarketingRedirect,
} from "../lib/marketingRoutes.ts";
import { marketingProductEntryHref } from "../lib/marketingProductEntry.ts";

/**
 * R-05-LANG. The redirect that stops `/` being served in English to a visitor
 * who reads Korean or Chinese and then rewritten by the client after paint.
 * Measured before it existed: 0.1959 CLS at 320px for a zh-CN browser with no
 * query string, against a 0.1 budget, and 0.1637 of that with every webfont
 * blocked -- so it is the copy swap, not the font.
 */

test("an explicit ?lang= sends the English root to that locale", () => {
  assert.equal(
    localizedMarketingRedirect({ pathname: "/", language: "ko", source: "search" }),
    "/ko"
  );
  assert.equal(
    localizedMarketingRedirect({ pathname: "/", language: "zh", source: "search" }),
    "/zh"
  );
});

test("a browser preference alone is enough to redirect", () => {
  assert.equal(
    localizedMarketingRedirect({ pathname: "/", language: "zh", source: "accept" }),
    "/zh"
  );
});

test("English stays on the English root, whatever asked for it", () => {
  for (const source of ["search", "accept", "default"]) {
    assert.equal(
      localizedMarketingRedirect({ pathname: "/", language: "en", source }),
      null,
      `en / ${source} must not redirect`
    );
  }
});

test("an already-localized path never redirects, which is what makes a loop impossible", () => {
  // `source: "path"` is what the resolver reports once the URL carries a locale
  // segment, so the second hop cannot be generated.
  assert.equal(
    localizedMarketingRedirect({ pathname: "/ko", language: "ko", source: "path" }),
    null
  );
  assert.equal(
    localizedMarketingRedirect({ pathname: "/zh/compare-ai-models", language: "zh", source: "path" }),
    null
  );
  // Even with an explicit ?lang= on a localized path: the pathname is not a
  // redirectable base path, so there is nowhere to send it.
  assert.equal(
    localizedMarketingRedirect({ pathname: "/ko", language: "zh", source: "search" }),
    null
  );
});

test("only the routes that have a localized counterpart are redirected", () => {
  for (const path of LOCALIZED_MARKETING_BASE_PATHS) {
    assert.equal(
      localizedMarketingRedirect({ pathname: path, language: "ko", source: "accept" }),
      path === "/" ? "/ko" : `/ko${path}`
    );
  }
  for (const path of ["/privacy", "/terms", "/refund"]) {
    assert.equal(
      localizedMarketingRedirect({ pathname: path, language: "ko", source: "accept" }),
      null,
      `${path} keeps its existing legal destination`
    );
  }
});

test("application and auth routes are never language-redirected", () => {
  for (const path of ["/chat", "/auth/signin", "/admin", "/api/chat", "/status"]) {
    assert.equal(
      localizedMarketingRedirect({ pathname: path, language: "ko", source: "accept" }),
      null,
      `${path} must be left alone`
    );
  }
});

test("a trailing slash resolves to the same target rather than a second hop", () => {
  assert.equal(
    localizedMarketingRedirect({ pathname: "/compare-ai-models/", language: "ko", source: "accept" }),
    "/ko/compare-ai-models"
  );
});

test("an unsupported language is not a redirect target", () => {
  for (const language of ["jp", "xx", "", "ko-KR"]) {
    assert.equal(
      localizedMarketingRedirect({ pathname: "/", language, source: "accept" }),
      null,
      `${language} is not a generated locale`
    );
  }
});

test("the locale aliases stay routable so a redirect target is never a 404", () => {
  for (const path of ["/ko", "/kr", "/zh", "/cn", "/ko/compare-ai-models"]) {
    assert.equal(isStaticMarketingPathname(path), true, `${path} must be a static marketing route`);
  }
});

test("the dynamic Assistant and Knowledge guide uses the nonce CSP path", () => {
  assert.equal(
    isStaticMarketingPathname("/guides/assistant-knowledge"),
    false,
    "request-time feature flags and Supademo configuration must not use static hashes or shared caching"
  );
  assert.equal(
    isStaticMarketingPathname("/guides/assistant-knowledge/poster"),
    false,
    "the poster is an image response, not an HTML file with inline hashes"
  );
});

test("Review information is localized static marketing while the workspace remains dynamic", () => {
  assert.equal(isStaticMarketingPathname("/products/review"), true);
  for (const locale of ["en", "ko", "zh", "fr", "de", "es", "pt", "kr", "cn"]) {
    assert.equal(isStaticMarketingPathname(`/${locale}/products/review`), true);
  }
  for (const path of ["/review", "/ko/review", "/ko/products/review/settings", "/ko/products/chat"]) {
    assert.equal(isStaticMarketingPathname(path), false, `${path} must not inherit static marketing policy`);
  }
  assert.equal(localizedMarketingRedirect({ pathname: "/products/review", language: "ko", source: "accept" }), "/ko/products/review");
  assert.equal(localizedMarketingRedirect({ pathname: "/ko/products/review", language: "fr", source: "search" }), null);
});

test("explicit product entry keeps Review separate without changing a visitor's workspace preferences", () => {
  assert.equal(marketingProductEntryHref("review", "ko"), "/review?lang=ko");
  assert.equal(marketingProductEntryHref("chat", "ko"), "/chat/workspace?lang=ko");
  assert.equal(marketingProductEntryHref("review", "a&b"), "/review?lang=a%26b");
  assert.equal(new URL(marketingProductEntryHref("review", "ko"), "https://tomverse.test").searchParams.has("entry"), false);
});
