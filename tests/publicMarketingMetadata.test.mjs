import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";
import {
  assistantKnowledgeMetadata,
  localizedPublicPageMetadata,
  publicMarketingLocaleParams,
  publicMarketingMetadataCopy,
  publicMarketingPageMetadata,
} from "../lib/publicMarketingMetadata.ts";
import { isStaticMarketingPathname } from "../lib/marketingRoutes.ts";
import { LOCALIZED_SEO_PATHS, SEO_LOCALES, SITE_ORIGIN, getHomeSeoCopy, reviewOgCopy } from "../lib/seo.ts";
import * as sitemapModule from "../app/sitemap.ts";

const sitemap = typeof sitemapModule.default === "function" ? sitemapModule.default : sitemapModule.default.default;

test("each public metadata destination has a real static locale wrapper", () => {
  const params = publicMarketingLocaleParams();
  assert.deepEqual(params.map(({locale}) => locale).sort(), [...SEO_LOCALES, "kr", "cn"].sort());
  for (const basePath of Object.keys(publicMarketingMetadataCopy)) {
    const routeFile = new URL(`../app/[locale]${basePath}/page.tsx`, import.meta.url);
    assert.ok(existsSync(routeFile), `${basePath} has no locale route`);
    const source = readFileSync(routeFile, "utf8");
    assert.ok(source.includes('dynamic = "force-static"'), basePath);
    assert.ok(source.includes('dynamicParams = false'), basePath);
    assert.ok(source.includes('return publicMarketingLocaleParams()'), basePath);
    assert.ok(source.includes(`localizedPublicPageMetadata(props, "${basePath}")`), basePath);
    assert.ok(source.includes(`path="${basePath}"`), basePath);
    assert.ok(LOCALIZED_SEO_PATHS.includes(basePath), basePath);
    for (const { locale } of params) {
      assert.equal(isStaticMarketingPathname(`/${locale}${basePath}`), true);
      assert.equal(isStaticMarketingPathname(`/${locale}${basePath}/unpublished`), false);
    }
  }
});

test("seven-language public metadata uses translated text and canonical sibling alternates", async () => {
  for (const [basePath, copy] of Object.entries(publicMarketingMetadataCopy)) {
    assert.deepEqual(Object.keys(copy).sort(), [...SEO_LOCALES].sort());
    for (const locale of SEO_LOCALES) {
      const metadata = publicMarketingPageMetadata(basePath, locale, true);
      assert.ok(metadata.title.absolute.length > 5);
      assert.ok(metadata.description.length > 15);
      assert.equal(metadata.alternates.canonical, `${SITE_ORIGIN}/${locale}${basePath}`);
      assert.equal(metadata.openGraph.title, metadata.title.absolute);
      assert.equal(metadata.twitter.description, metadata.description);
      assert.equal(metadata.openGraph.images[0].alt, metadata.twitter.images[0].alt);
      assert.equal(metadata.alternates.languages[locale === "zh" ? "zh-Hans" : locale], metadata.alternates.canonical);
      if (locale !== "en") {
        assert.notEqual(copy[locale].description, copy.en.description);
        assert.notEqual(metadata.openGraph.images[0].alt, publicMarketingPageMetadata(basePath).openGraph.images[0].alt);
      }
    }
    const alias = await localizedPublicPageMetadata({ params: Promise.resolve({ locale: "kr" }) }, basePath);
    assert.equal(alias.alternates.canonical, `${SITE_ORIGIN}/ko${basePath}`);
    assert.deepEqual(await localizedPublicPageMetadata({ params: Promise.resolve({ locale: "xx" }) }, basePath), {});
  }
});

test("legal and dynamic guide destinations do not inherit static localized policy", () => {
  for (const path of ["/terms", "/privacy", "/refund", "/guides/assistant-knowledge"]) {
    assert.equal(LOCALIZED_SEO_PATHS.includes(path), false);
    for (const locale of SEO_LOCALES) assert.equal(isStaticMarketingPathname(`/${locale}${path}`), false);
  }
  assert.equal(isStaticMarketingPathname("/guides/assistant-knowledge"), false);
  const guideSource = readFileSync(new URL("../app/(site)/(marketing)/guides/assistant-knowledge/page.tsx", import.meta.url), "utf8");
  assert.ok(guideSource.includes('dynamic = "force-dynamic"'));
  assert.ok(guideSource.includes('await isAssistantPackageImportEnabled()'));
  assert.ok(guideSource.includes('configuredAssistantKnowledgeSupademoEmbeds()'));
  assert.ok(guideSource.includes('assistantKnowledgeMetadata(lang)'));
});

test("Knowledge query metadata points only to supported query-language pages", () => {
  for (const locale of SEO_LOCALES) {
    const metadata = assistantKnowledgeMetadata(locale);
    const url = new URL(metadata.alternates.canonical);
    assert.equal(url.pathname, "/guides/assistant-knowledge");
    assert.equal(url.searchParams.get("lang"), locale);
    for (const alternate of Object.values(metadata.alternates.languages)) assert.equal(new URL(alternate).pathname, url.pathname);
    assert.equal(metadata.alternates.languages["zh-CN"], undefined);
  }
});

test("home metadata follows the public guest offer and Review OG names the product", () => {
  for (const locale of SEO_LOCALES) {
    const available = getHomeSeoCopy(locale, true);
    const unavailable = getHomeSeoCopy(locale, false);
    assert.equal(available.title, unavailable.title);
    assert.notEqual(available.description, unavailable.description);
    assert.ok(unavailable.description.includes("Review"));
    assert.ok(reviewOgCopy[locale].title.startsWith("Tomverse Review |"));
  }
});

test("expanded localized sitemap has no duplicate canonical entries", () => {
  const entries = sitemap();
  assert.equal(new Set(entries.map(entry => entry.url)).size, entries.length);
  for (const basePath of Object.keys(publicMarketingMetadataCopy)) {
    assert.equal(entries.filter(entry => entry.url === SITE_ORIGIN + basePath).length, 1);
    for (const locale of SEO_LOCALES) assert.ok(entries.some(entry => entry.url === `${SITE_ORIGIN}/${locale}${basePath}`));
  }
});
