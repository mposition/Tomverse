import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCALIZED_SEO_PATHS,
  SEO_LOCALES,
  SITE_ORIGIN,
  createPageMetadata,
  localizedLanguageAlternates,
  localizedPath,
} from "../lib/seo.ts";
import * as sitemapModule from "../app/sitemap.ts";

// tsx hands a .ts default export to an .mjs importer either as the function
// or wrapped once more under `default`, depending on how it compiled the file.
const sitemap =
  typeof sitemapModule.default === "function"
    ? sitemapModule.default
    : sitemapModule.default.default;

/**
 * SEO-I18N-01. The Chinese alternate names the script (`zh-Hans`), not a
 * region, and every localized group still references itself and every
 * sibling. Checked at the two places the tag reaches the outside -- page
 * metadata and the sitemap -- because a group whose pages disagree about
 * their alternates is ignored as a whole by search engines.
 */

const EXPECTED_HREFLANG = {
  en: "en",
  ko: "ko",
  zh: "zh-Hans",
  fr: "fr",
  de: "de",
  es: "es",
  pt: "pt",
};

test("the Chinese alternate is zh-Hans and points at the /zh URL", () => {
  for (const basePath of LOCALIZED_SEO_PATHS) {
    const languages = localizedLanguageAlternates(basePath);
    assert.equal(languages["zh-Hans"], `${SITE_ORIGIN}${localizedPath("zh", basePath)}`);
    assert.equal(languages["zh-CN"], undefined, `${basePath} still names zh-CN`);
  }
});

test("each group lists every locale once, plus x-default at the base path", () => {
  for (const basePath of LOCALIZED_SEO_PATHS) {
    const languages = localizedLanguageAlternates(basePath);
    assert.deepEqual(
      Object.keys(languages).sort(),
      ["x-default", ...SEO_LOCALES.map((locale) => EXPECTED_HREFLANG[locale])].sort()
    );
    assert.equal(languages["x-default"], `${SITE_ORIGIN}${basePath}`);
    for (const locale of SEO_LOCALES) {
      assert.equal(
        languages[EXPECTED_HREFLANG[locale]],
        `${SITE_ORIGIN}${localizedPath(locale, basePath)}`
      );
    }
  }
});

test("every page in a group carries the same alternates as its canonical siblings", () => {
  for (const basePath of LOCALIZED_SEO_PATHS) {
    const expected = localizedLanguageAlternates(basePath);
    for (const locale of SEO_LOCALES) {
      const metadata = createPageMetadata({
        title: "t",
        description: "d",
        path: localizedPath(locale, basePath),
        locale,
        localizedBasePath: basePath,
      });
      assert.deepEqual(metadata.alternates?.languages, expected);
      // Self-reference: the page's own canonical is one of its alternates.
      assert.ok(
        Object.values(expected).includes(metadata.alternates?.canonical),
        `${localizedPath(locale, basePath)} does not reference itself`
      );
    }
  }
});

test("the sitemap's localized entries reference themselves and share one set per group", () => {
  const entries = sitemap();
  for (const basePath of LOCALIZED_SEO_PATHS) {
    const expected = localizedLanguageAlternates(basePath);
    const urls = [basePath, ...SEO_LOCALES.map((locale) => localizedPath(locale, basePath))].map(
      (path) => `${SITE_ORIGIN}${path}`
    );
    for (const url of urls) {
      const entry = entries.find((candidate) => candidate.url === url);
      assert.ok(entry, `${url} is missing from the sitemap`);
      assert.deepEqual(entry.alternates?.languages, expected);
      assert.ok(Object.values(expected).includes(url), `${url} does not reference itself`);
    }
  }
  const serialized = JSON.stringify(entries);
  assert.equal(serialized.includes('"zh-CN"'), false, "the sitemap still names zh-CN");
});

test("Open Graph keeps its own locale format; zh_CN is not part of this change", () => {
  const metadata = createPageMetadata({
    title: "t",
    description: "d",
    path: "/zh",
    locale: "zh",
    localizedBasePath: "/",
  });
  assert.equal(metadata.openGraph?.locale, "zh_CN");
});
