import assert from "node:assert/strict";
import test from "node:test";
import { resolveDocumentLanguage } from "../lib/documentLanguage.ts";

// VAL-004. The root layout is the only place `<html lang>` can be set, and it
// cannot see the route's params or query string -- the proxy resolves the
// language and hands it over as a header. These lock the resolution itself, so
// the rule is testable without rendering a page.

test("an explicit ?lang wins over everything else", () => {
  assert.deepEqual(
    resolveDocumentLanguage({
      pathname: "/chat",
      searchLanguage: "ko",
      acceptLanguage: "en-US,en;q=0.9",
    }),
    { language: "ko", source: "search" }
  );
});

test("a localized path prefix decides when there is no ?lang", () => {
  assert.deepEqual(
    resolveDocumentLanguage({ pathname: "/ko", acceptLanguage: "en-US" }),
    { language: "ko", source: "path" }
  );
  assert.deepEqual(
    resolveDocumentLanguage({ pathname: "/ko/compare-ai-models" }),
    { language: "ko", source: "path" }
  );
});

test("the marketing path aliases resolve to the language they redirect to", () => {
  assert.equal(resolveDocumentLanguage({ pathname: "/kr" }).language, "ko");
  assert.equal(resolveDocumentLanguage({ pathname: "/cn" }).language, "zh");
});

test("a path segment that is not a locale is not treated as one", () => {
  assert.deepEqual(
    resolveDocumentLanguage({ pathname: "/pricing", acceptLanguage: "ko-KR,ko;q=0.9" }),
    { language: "ko", source: "accept" }
  );
  assert.equal(resolveDocumentLanguage({ pathname: "/enterprise" }).language, "en");
});

test("Accept-Language is read in quality order, not header order", () => {
  assert.deepEqual(
    resolveDocumentLanguage({ acceptLanguage: "en;q=0.4,ko;q=0.9" }),
    { language: "ko", source: "accept" }
  );
  // A region subtag still selects its base language.
  assert.equal(
    resolveDocumentLanguage({ acceptLanguage: "zh-Hans-CN,zh;q=0.9" }).language,
    "zh"
  );
});

test("Traditional Chinese browsers and paths resolve to zh-Hant", () => {
  for (const acceptLanguage of ["zh-TW,zh;q=0.9", "zh-HK", "zh-Hant", "zh-Hant-TW", "zh-MO"]) {
    assert.equal(resolveDocumentLanguage({ acceptLanguage }).language, "zh-Hant", acceptLanguage);
  }
  // Mainland and bare `zh` stay on Simplified.
  assert.equal(resolveDocumentLanguage({ acceptLanguage: "zh-CN" }).language, "zh");
  assert.equal(resolveDocumentLanguage({ acceptLanguage: "zh" }).language, "zh");
  assert.deepEqual(resolveDocumentLanguage({ pathname: "/zh-Hant" }), {
    language: "zh-Hant",
    source: "path",
  });
  assert.equal(resolveDocumentLanguage({ pathname: "/zh-hant/pricing" }).language, "zh-Hant");
  assert.equal(resolveDocumentLanguage({ searchLanguage: "zh-Hant" }).language, "zh-Hant");
  // `/zh-tw` is not a route, so the path does not decide.
  assert.equal(resolveDocumentLanguage({ pathname: "/zh-tw" }).source, "default");
});

test("unsupported and malformed inputs fall back to English", () => {
  assert.deepEqual(resolveDocumentLanguage({}), { language: "en", source: "default" });
  assert.equal(
    resolveDocumentLanguage({ searchLanguage: "klingon", acceptLanguage: "" }).language,
    "en"
  );
  // A broken q value must not discard the rest of the header.
  assert.equal(
    resolveDocumentLanguage({ acceptLanguage: "ko;q=notanumber,en" }).language,
    "en"
  );
});
