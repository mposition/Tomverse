import { expect, test, type Page } from "@playwright/test";

/**
 * VAL-004. `app/layout.tsx` hard-coded `<html lang="en">` and let
 * `LanguageProvider` correct `document.documentElement.lang` after hydration.
 * Two things read that attribute before any of that happens:
 *
 * - `:lang(ko)` / `:lang(zh)` in app/globals.css select the font family for
 *   the whole subtree (docs/ui-contracts/typography.md), so Korean text was
 *   painted in the Latin face with a system fallback and re-drawn once the
 *   client caught up;
 * - assistive technology takes the document language from the served markup.
 *
 * The proxy now resolves the language per request and the root layout renders
 * it, so the *first HTTP response* is already right. These tests read that
 * response with `request.get` rather than a rendered page: a `page.goto`
 * measurement would be taken after hydration and could not tell a fixed
 * attribute from a corrected one.
 *
 * Two properties are checked separately, because the second is what makes the
 * first worth anything:
 *
 * 1. the served root `lang` matches the language of the request, and
 * 2. hydration does not change it -- the client agrees with the server rather
 *    than overwriting it.
 *
 * R-05-LANG. "Built once in English, corrected on the client" used to be true
 * of `/` as well, and it was a defect rather than a design: a zh-CN browser
 * measured 0.1959 CLS at 320px on that correction alone, against a 0.1 budget,
 * with every webfont blocked. The proxy now sends a non-English visitor to the
 * localized page that already carries their language, so property 1 above holds
 * for `/` too rather than being excused there.
 *
 * A marketing route with no localized counterpart -- `/pricing` and most of the
 * rest -- still serves English to everyone and still declares `en`, because
 * there is nowhere else to send that visitor. Those cases stay asserted as `en`
 * on purpose, and they are what is left of the old compromise.
 *
 * RECON-I18N-001. The localized marketing routes used to be the exception --
 * prerendered Korean, Chinese, French copy under a root that still said
 * `lang="en"`, because the layout rendering `<html>` sat above the `[locale]`
 * segment and could not read its param. They now have a root layout of their
 * own (`app/[locale]/layout.tsx`), so the root attribute is generated per
 * locale at build time and is asserted here like any other.
 */

const KOREAN_BROWSER = "ko-KR,ko;q=0.9,en;q=0.5";
const ENGLISH_BROWSER = "en-US,en;q=0.9";

const rootLangOf = (html: string) =>
  html.match(/<html[^>]*\blang="([^"]*)"/)?.[1] ?? null;

type Case = {
  path: string;
  acceptLanguage: string;
  expected: string;
  why: string;
};

const SERVED_LANGUAGE_CASES: Case[] = [
  // Dynamic application routes: resolved per request.
  {
    path: "/chat?lang=ko",
    acceptLanguage: ENGLISH_BROWSER,
    expected: "ko",
    why: "an explicit ?lang is what the server renders, whatever the browser prefers",
  },
  {
    path: "/chat?lang=en",
    acceptLanguage: KOREAN_BROWSER,
    expected: "en",
    why: "an explicit ?lang overrides the browser preference in both directions",
  },
  {
    path: "/chat",
    acceptLanguage: KOREAN_BROWSER,
    expected: "ko",
    why: "with no ?lang the application layout renders the browser's language",
  },
  {
    path: "/chat",
    acceptLanguage: ENGLISH_BROWSER,
    expected: "en",
    why: "with no ?lang the application layout renders the browser's language",
  },
  {
    path: "/auth/signin?lang=ko",
    acceptLanguage: ENGLISH_BROWSER,
    expected: "ko",
    why: "sign-in pins ?lang server-side (VAL-003); the document must say so",
  },
  {
    path: "/auth/signin?lang=en",
    acceptLanguage: KOREAN_BROWSER,
    expected: "en",
    why: "sign-in pins ?lang server-side (VAL-003); the document must say so",
  },
  {
    path: "/auth/signin",
    acceptLanguage: KOREAN_BROWSER,
    expected: "ko",
    why: "with no ?lang the application layout renders the browser's language",
  },
  // Statically prerendered marketing routes.
  {
    path: "/",
    acceptLanguage: KOREAN_BROWSER,
    expected: "ko",
    // `request.get` follows the redirect, which is the point: what a Korean
    // browser ends up holding is Korean copy declaring Korean. The hop itself
    // is asserted separately below.
    why: "R-05-LANG: a Korean browser is served the localized page, not English corrected later",
  },
  {
    path: "/",
    acceptLanguage: ENGLISH_BROWSER,
    expected: "en",
    why: "English is served the English root unchanged; no redirect, no correction",
  },
  {
    path: "/pricing",
    acceptLanguage: KOREAN_BROWSER,
    expected: "en",
    why: "no localized counterpart exists, so English copy and an `en` declaration still agree",
  },
];

for (const testCase of SERVED_LANGUAGE_CASES) {
  test(`served root lang is "${testCase.expected}" for ${testCase.path} (${
    testCase.acceptLanguage.split(",")[0]
  })`, { tag: "@ui-risk" }, async ({ request }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "The served bytes do not depend on the viewport; covered once."
    );
    const response = await request.get(testCase.path, {
      headers: { "accept-language": testCase.acceptLanguage },
    });
    expect(response.ok()).toBe(true);
    expect(rootLangOf(await response.text()), testCase.why).toBe(testCase.expected);
  });
}

// The localized marketing routes are prerendered per locale, so the language
// travels with the route rather than with the request: the same bytes are
// served to every visitor and the root attribute has to be right in them.
const LOCALIZED_ROUTES: Array<{ path: string; expected: string }> = [
  { path: "/ko", expected: "ko" },
  { path: "/ko/compare-ai-models", expected: "ko" },
  { path: "/zh", expected: "zh" },
  { path: "/fr/chatgpt-vs-claude", expected: "fr" },
  { path: "/en", expected: "en" },
];

for (const { path, expected } of LOCALIZED_ROUTES) {
  test(`localized marketing route ${path} is served as lang="${expected}"`, {
    tag: "@ui-risk",
  }, async ({ request }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "The served bytes do not depend on the viewport; covered once."
    );
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
    const html = await response.text();
    expect(
      rootLangOf(html),
      `${path} serves ${expected} copy, so the document must declare it`
    ).toBe(expected);
    // The content keeps its own declaration too: it is what `:lang()` matched
    // before this route had a root of its own, and removing it would make the
    // fix depend on a single attribute with nothing behind it.
    expect(html).toContain(`lang="${expected}"`);
  });
}

/**
 * R-05-LANG. The hop itself, asserted where following it cannot hide it.
 *
 * Each of these was a way to get it wrong: caching a language-dependent
 * redirect in the shared cache that serves static marketing for an hour would
 * replay one visitor's language to everyone; redirecting a request that already
 * carries a locale would loop; dropping the query string would lose campaign
 * attribution; and honouring `Accept-Language` over a stored choice would drag
 * a visitor who picked English back to their browser's language every visit.
 */
const LANGUAGE_REDIRECTS: Array<{
  path: string;
  headers?: Record<string, string>;
  to: string | null;
  why: string;
}> = [
  {
    path: "/",
    headers: { "accept-language": KOREAN_BROWSER },
    to: "/ko",
    why: "a Korean browser is sent to the Korean page",
  },
  {
    path: "/",
    headers: { "accept-language": "zh-CN,zh;q=0.9" },
    to: "/zh",
    why: "a Chinese browser is sent to the Chinese page",
  },
  {
    path: "/",
    headers: { "accept-language": ENGLISH_BROWSER },
    to: null,
    why: "English is left where it is",
  },
  {
    path: "/?lang=ko&utm_source=x&ref=y",
    to: "/ko?utm_source=x&ref=y",
    why: "the handled parameter is consumed and the rest of the query survives",
  },
  {
    path: "/",
    headers: { "accept-language": KOREAN_BROWSER, cookie: "tomverse_lang=en" },
    to: null,
    why: "a stored choice of English outranks the browser's preference",
  },
  {
    path: "/ko",
    headers: { "accept-language": KOREAN_BROWSER },
    to: null,
    why: "an already-localized path is not redirected again, so there is no loop",
  },
  {
    path: "/pricing",
    headers: { "accept-language": KOREAN_BROWSER },
    to: null,
    why: "no /ko/pricing exists; redirecting there would be a 404 dressed as a fix",
  },
  {
    path: "/chat",
    headers: { "accept-language": KOREAN_BROWSER },
    to: null,
    why: "application routes resolve their own language and are never redirected",
  },
];

for (const redirectCase of LANGUAGE_REDIRECTS) {
  test(`language redirect: ${redirectCase.path} -> ${
    redirectCase.to ?? "(no redirect)"
  } -- ${redirectCase.why}`, {
    tag: "@ui-risk",
  }, async ({ request }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Redirect behaviour does not depend on the viewport; covered once."
    );
    const response = await request.get(redirectCase.path, {
      maxRedirects: 0,
      headers: redirectCase.headers,
    });
    if (redirectCase.to === null) {
      expect(response.status(), redirectCase.why).toBe(200);
      return;
    }
    expect(response.status(), redirectCase.why).toBe(307);
    expect(response.headers()["location"], redirectCase.why).toBe(redirectCase.to);
    // A shared cache holds static marketing for an hour. This response must
    // never be one of the things it holds.
    expect(
      response.headers()["cache-control"],
      "a language-dependent redirect must not be publicly cacheable"
    ).toContain("no-store");
    expect(response.headers()["vary"]).toContain("Accept-Language");
    expect(response.headers()["vary"]).toContain("Cookie");
  });
}

// The legacy aliases redirect to the canonical locale rather than rendering a
// second copy under a different path.
for (const { path, to } of [
  { path: "/kr", to: "/ko" },
  { path: "/cn", to: "/zh" },
]) {
  test(`legacy locale alias ${path} redirects to ${to}`, { tag: "@ui-risk" }, async ({
    request,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Redirect behaviour does not depend on the viewport; covered once."
    );
    const response = await request.get(path, { maxRedirects: 0 });
    expect([307, 308]).toContain(response.status());
    expect(response.headers()["location"]).toBe(to);
  });
}

const readLangState = (page: Page) =>
  page.evaluate(() => ({
    lang: document.documentElement.lang,
    // The family actually in effect for body copy, which is what `:lang()`
    // is there to decide.
    family: getComputedStyle(document.body).fontFamily,
  }));

const HYDRATION_CASES = [
  { path: "/chat?lang=ko", acceptLanguage: ENGLISH_BROWSER, expected: "ko", cjk: true },
  { path: "/chat?lang=en", acceptLanguage: KOREAN_BROWSER, expected: "en", cjk: false },
  { path: "/auth/signin?lang=ko", acceptLanguage: ENGLISH_BROWSER, expected: "ko", cjk: true },
] as const;

for (const hydrationCase of HYDRATION_CASES) {
  test(`hydration leaves the root lang alone on ${hydrationCase.path}`, {
    tag: "@ui-risk",
  }, async ({ browser }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "Hydration behaviour does not depend on the viewport; covered once."
    );
    const context = await browser.newContext({
      locale: hydrationCase.acceptLanguage.split(",")[0],
      extraHTTPHeaders: { "accept-language": hydrationCase.acceptLanguage },
    });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await page.goto(hydrationCase.path);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);

    const state = await readLangState(page);
    expect(
      state.lang,
      "the client changed the language the server had already declared"
    ).toBe(hydrationCase.expected);
    // The locale font stack is chosen by `:lang()`, so a correct attribute has
    // to actually reach the family. Korean gets Noto Sans KR, everything else
    // keeps Geist -- see docs/ui-contracts/typography.md.
    expect(state.family).toContain(hydrationCase.cjk ? "Noto Sans KR" : "Geist");

    const hydrationErrors = consoleErrors.filter((message) =>
      /hydrat|did not match|Text content does not match/i.test(message)
    );
    expect(hydrationErrors, `hydration errors: ${hydrationErrors.join(" | ")}`).toEqual([]);

    await context.close();
  });
}
