import assert from "node:assert/strict";
import test from "node:test";
import {
  isStaticMarketingPathname,
  localizedMarketingRedirect,
} from "../lib/marketingRoutes.ts";

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
  // Generated per locale.
  for (const intent of [
    "ai-answer-review",
    "ai-for-file-analysis",
    "chatgpt-vs-claude",
    "compare-ai-models",
  ]) {
    assert.equal(
      localizedMarketingRedirect({ pathname: `/${intent}`, language: "ko", source: "accept" }),
      `/ko/${intent}`
    );
  }
  // English-only marketing pages: there is no /ko/pricing to send anyone to,
  // so redirecting would be a 404 dressed up as a fix.
  for (const path of ["/pricing", "/faq", "/privacy", "/terms", "/safety/approach"]) {
    assert.equal(
      localizedMarketingRedirect({ pathname: path, language: "ko", source: "accept" }),
      null,
      `${path} has no localized counterpart`
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
