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
 * Statically prerendered *English* marketing routes are asserted as `en` on
 * purpose: they are built once, they serve English copy to every visitor, and
 * their language only changes on the client.
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
  // Statically prerendered marketing routes: English copy for everyone.
  {
    path: "/",
    acceptLanguage: KOREAN_BROWSER,
    expected: "en",
    why: "prerendered once with English copy; the declared language matches it",
  },
  {
    path: "/pricing",
    acceptLanguage: KOREAN_BROWSER,
    expected: "en",
    why: "prerendered once with English copy; the declared language matches it",
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
