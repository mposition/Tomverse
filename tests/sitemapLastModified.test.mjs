import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SEO_LOCALES, SITE_ORIGIN, localizedPath } from "../lib/seo.ts";
import { SITEMAP_CONTENT_EVIDENCE } from "../lib/sitemapContentDates.ts";
import * as sitemapModule from "../app/sitemap.ts";
import { en } from "../locales/en.ts";
import { ko } from "../locales/ko.ts";
import { zh } from "../locales/zh.ts";
import { fr } from "../locales/fr.ts";
import { de } from "../locales/de.ts";
import { es } from "../locales/es.ts";
import { pt } from "../locales/pt.ts";

// tsx hands a .ts default export to an .mjs importer either as the function
// or wrapped once more under `default`, depending on how it compiled the file.
const sitemap =
    typeof sitemapModule.default === "function"
        ? sitemapModule.default
        : sitemapModule.default.default;

/**
 * AEO-04. `lastmod` appears only where a page's content date is evidenced,
 * the evidenced date matches what the page shows, and the content it vouches
 * for has not changed since.
 */

/** The order lib/sitemapContentDates.ts documents for the privacy digest. */
const PRIVACY_LOCALES = { en, ko, zh, fr, de, es, pt };

/** A sitemap URL's page path, with the locale prefix `localizedPath()` adds removed. */
const LOCALE_PREFIXES = SEO_LOCALES.map((locale) => localizedPath(locale, "/"));
const pathOf = (url) => {
    const path = new URL(url).pathname;
    for (const prefix of LOCALE_PREFIXES) {
        const bare = prefix.replace(/\/$/, "");
        if (path === bare || path === prefix) return "/";
        if (path.startsWith(`${bare}/`)) return path.slice(bare.length);
    }
    return path;
};

const utcDay = (iso) => new Date(`${iso}T00:00:00.000Z`);

test("the locale prefix is removed for every SEO locale", () => {
    for (const locale of SEO_LOCALES) {
        assert.equal(pathOf(`${SITE_ORIGIN}${localizedPath(locale, "/compare-ai-models")}`), "/compare-ai-models");
    }
    assert.equal(pathOf(`${SITE_ORIGIN}/privacy`), "/privacy");
});

test("only pages with evidenced content carry lastModified, and with that date", () => {
    const dated = sitemap().filter((entry) => entry.lastModified !== undefined);
    assert.deepEqual(
        [...new Set(dated.map((entry) => pathOf(entry.url)))].sort(),
        Object.keys(SITEMAP_CONTENT_EVIDENCE).sort()
    );
    for (const entry of dated) {
        assert.equal(
            new Date(entry.lastModified).toISOString(),
            utcDay(SITEMAP_CONTENT_EVIDENCE[pathOf(entry.url)].date).toISOString()
        );
    }
});

test("every evidenced page is one the sitemap lists", () => {
    const urls = new Set(sitemap().map((entry) => entry.url));
    for (const path of Object.keys(SITEMAP_CONTENT_EVIDENCE)) {
        assert.ok(urls.has(`${SITE_ORIGIN}${path}`), `${path} is not in the sitemap`);
    }
});

test("the sitemap does not stamp the time it was generated", () => {
    const first = JSON.stringify(sitemap());
    assert.equal(first, JSON.stringify(sitemap()));
    const today = new Date().toISOString().slice(0, 10);
    const evidenced = Object.values(SITEMAP_CONTENT_EVIDENCE).map((evidence) => evidence.date);
    if (!evidenced.includes(today)) assert.equal(first.includes(today), false);
});

test("the privacy date is exactly the effective date the page shows, in every locale", () => {
    const { date } = SITEMAP_CONTENT_EVIDENCE["/privacy"];
    const squash = (text) => text.toLowerCase().replace(/\s+/g, "");
    for (const [locale, copy] of Object.entries(PRIVACY_LOCALES)) {
        // The whole formatted date, not its numbers one by one: "October 14,
        // 2026 (revision 9)" holds a 9, a 14 and a 2026 and is still not
        // September 14. Whitespace is ignored because zh writes 2026 年 9 月.
        const expected = new Intl.DateTimeFormat(locale, {
            year: "numeric",
            month: "long",
            day: "numeric",
            timeZone: "UTC",
        }).format(utcDay(date));
        assert.ok(
            squash(copy.privacyPolicy.effective).includes(squash(expected)),
            `${locale}: "${copy.privacyPolicy.effective}" does not show ${expected}`
        );
    }
});

test("the privacy content the date vouches for has not changed", () => {
    const digest = createHash("sha256");
    digest.update(readFileSync("components/legal/PrivacyPolicy.tsx", "utf8").replace(/\r\n/g, "\n"));
    for (const copy of Object.values(PRIVACY_LOCALES)) digest.update(JSON.stringify(copy.privacyPolicy));
    assert.equal(
        digest.digest("hex"),
        SITEMAP_CONTENT_EVIDENCE["/privacy"].contentSha256,
        "The privacy policy changed. Decide whether the effective date moves, update the date on the page, " +
            "then `date` and `contentSha256` in lib/sitemapContentDates.ts together."
    );
});
