import { expect, test, type Page, type Locator } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockPublicBillingConfig,
  mockPublicProofMetrics,
  prepareGuestPage,
} from "./support/app-fixtures";
import { marketingLocaleFor } from "@/lib/marketingLocale";
import { LOCALIZED_SEO_PATHS, localizedPath } from "@/lib/seo";

/**
 * Font-system regression contract -- see docs/ui-contracts/typography.md.
 *
 * The declared `font-family` is checked *and* the font the engine actually
 * picked, because the bug this replaces was exactly a case where the CSS
 * variable named Geist while the body rendered in Arial.
 */

// Chromium reports the fonts it really rasterized with. That is the only way to
// tell "declared Geist" apart from "declared Geist, drew Arial".
async function renderedFonts(page: Page, selector: string): Promise<string[]> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("DOM.enable");
    await client.send("CSS.enable");
    const { root } = (await client.send("DOM.getDocument")) as {
      root: { nodeId: number };
    };
    const { nodeId } = (await client.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    })) as { nodeId: number };
    if (!nodeId) throw new Error(`Selector not found: ${selector}`);
    const { fonts } = (await client.send("CSS.getPlatformFontsForNode", {
      nodeId,
    })) as { fonts: Array<{ familyName: string; glyphCount: number }> };
    return fonts
      .filter((font) => font.glyphCount > 0)
      .sort((a, b) => b.glyphCount - a.glyphCount)
      .map((font) => font.familyName);
  } finally {
    await client.detach().catch(() => {});
  }
}

// Chromium quotes multi-word family names in the computed value
// (`"Noto Sans KR", ...`), so the quotes come off before matching.
async function declaredFontFamily(target: Locator): Promise<string> {
  const computed = await target.evaluate(
    (el) => window.getComputedStyle(el).fontFamily
  );
  return computed.replace(/["']/g, "");
}

// Screenshot-stable state: webfonts resolved and layout settled.
async function waitForFonts(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

// The path with any `/{locale}` prefix removed. `/ko` and `/zh/pricing` both
// answer from the localized routes, so switching away from one means composing
// the destination from what is underneath, not from the current path.
function unlocalizedPath(pathname: string): string {
  const [first, ...rest] = pathname.split("/").filter(Boolean);
  if (first && marketingLocaleFor(first)) {
    return `/${rest.join("/")}`;
  }
  return pathname;
}

async function selectLanguage(page: Page, lang: "ko" | "en" | "zh") {
  const select = page.getByLabel("Language");
  if ((await select.inputValue()) === lang) {
    // WebKit can finish the document load before the next/font face has
    // settled. Keep the no-navigation path under the same font-ready
    // contract as an actual locale switch so computed styles are meaningful.
    await waitForFonts(page);
    return;
  }

  // Since the localized marketing routes got their own root layout, the
  // switcher crosses a *document* boundary on any page that has a localized
  // variant. Two things follow, and this helper was written before both:
  //
  // - an evaluate issued straight after `selectOption` lands in the old
  //   document's destroyed context ("Execution context was destroyed");
  // - LanguageProvider sets `documentElement.lang` on the *old* page before
  //   the navigation starts, so waiting on the language alone returns while
  //   the previous document is still on screen and the measurement races it.
  //
  // korean-typography.spec.ts hit exactly this and was fixed; this suite has
  // the same helper and was not, so it stayed red until the full Chromium
  // suite ran. Waiting for the URL first pins which document is measured.
  const base = unlocalizedPath(new URL(page.url()).pathname) || "/";
  const localizable = LOCALIZED_SEO_PATHS.includes(
    base as (typeof LOCALIZED_SEO_PATHS)[number]
  );
  await select.selectOption(lang);
  if (localizable) {
    // Composed with the switcher's own helper rather than by hand: English is
    // not served unprefixed here, it has a `/en` route like every other SEO
    // locale, and assuming otherwise waits for a URL that never arrives.
    await page.waitForURL((url) => url.pathname === localizedPath(lang, base));
    await page.waitForLoadState("load");
  }

  // Only then the fonts: ko and zh re-point `--font-ui` through `:lang()` and
  // those faces are `preload: false` by policy, so they are fetched once the
  // language changes. The poll tolerates a context torn down mid-evaluate.
  await expect
    .poll(
      async () => {
        try {
          return await page.evaluate(async () => {
            await document.fonts.ready;
            return document.documentElement.lang;
          });
        } catch {
          return null;
        }
      },
      { message: `language did not settle on "${lang}"` }
    )
    .toBe(lang);
}

test.describe("font system: locale families", () => {
  test.beforeEach(async ({ page }) => {
    await mockPublicBillingConfig(page);
    await mockPublicProofMetrics(page);
  });

  test(
    "English UI renders in Geist and never falls back to Arial",
    { tag: "@smoke" },
    async ({ page }, testInfo) => {
      await page.goto("/");
      await selectLanguage(page, "en");

      const title = page.getByTestId("landing-hero-title");
      await expect(title).toBeVisible();
      expect(await declaredFontFamily(title)).toMatch(/^Geist\b/);

      // Mobile WebKit reports `-webkit-standard` for the body element even
      // when rendered descendants resolve the author family. Check body and
      // rasterized platform fonts only where CDP can report them reliably;
      // every engine still checks the real headline above.
      if (!testInfo.project.name.includes("chromium")) return;
      const body = page.locator("body");
      expect(await declaredFontFamily(body)).toMatch(/^Geist\b/);
      expect(await declaredFontFamily(body)).not.toMatch(/Arial/);
      const used = await renderedFonts(page, "[data-testid='landing-hero-title']");
      expect(used[0]).toMatch(/^Geist\b/);
      expect(used).not.toContain("Arial");
    }
  );

  test("Korean UI renders in Noto Sans KR, Latin included", async ({ page }, testInfo) => {
    await page.goto("/");
    await selectLanguage(page, "ko");

    const declared = await declaredFontFamily(
      page.getByTestId("landing-hero-title")
    );
    expect(declared).toMatch(/^Noto Sans KR\b/);
    expect(declared).toMatch(/Apple SD Gothic Neo/);
    expect(declared).toMatch(/Malgun Gothic/);
    expect(declared).not.toMatch(/Arial/);

    if (!testInfo.project.name.includes("chromium")) return;
    const used = await renderedFonts(page, "[data-testid='landing-hero-title']");
    // A mixed Hangul/Latin headline must come from one family, not two.
    expect(used.some((font) => font.startsWith("Noto Sans KR"))).toBe(true);
    expect(used.filter((font) => font.startsWith("Geist"))).toEqual([]);
    expect(used).not.toContain("Arial");
  });

  test("Chinese UI renders in Noto Sans SC", async ({ page }, testInfo) => {
    await page.goto("/");
    await selectLanguage(page, "zh");

    const declared = await declaredFontFamily(
      page.getByTestId("landing-hero-title")
    );
    expect(declared).toMatch(/^Noto Sans SC\b/);
    expect(declared).toMatch(/PingFang SC/);
    expect(declared).toMatch(/Microsoft YaHei/);
    expect(declared).not.toMatch(/Arial/);

    if (!testInfo.project.name.includes("chromium")) return;
    const used = await renderedFonts(page, "[data-testid='landing-hero-title']");
    expect(used.some((font) => font.startsWith("Noto Sans SC"))).toBe(true);
    expect(used).not.toContain("Arial");
  });

  test("switching locale re-points the whole subtree, not single glyphs", async ({
    page,
  }) => {
    await page.goto("/");
    await selectLanguage(page, "en");
    expect(
      await declaredFontFamily(page.getByTestId("landing-hero-title"))
    ).toMatch(/^Geist\b/);

    await selectLanguage(page, "ko");
    const korean = await declaredFontFamily(
      page.getByTestId("landing-primary-cta")
    );
    expect(korean).toMatch(/^Noto Sans KR\b/);

    await selectLanguage(page, "en");
    expect(
      await declaredFontFamily(page.getByTestId("landing-hero-title"))
    ).toMatch(/^Geist\b/);
  });
});

test.describe("font system: monospace scope", () => {
  test("chat body copy is not monospace, and the composer only switches for preserved formatting", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await page.goto("/chat?entry=guest-preview");
    await waitForFonts(page);

    const textarea = page.getByTestId("chat-textarea");
    await expect(textarea).toBeVisible();
    expect(await declaredFontFamily(textarea)).toMatch(/^Geist\b/);
    expect(await declaredFontFamily(textarea)).not.toMatch(/Geist Mono/);

    const greeting = page.getByTestId("chat-welcome-greeting");
    await expect(greeting).toBeVisible();
    expect(await declaredFontFamily(greeting)).not.toMatch(/Geist Mono/);
  });

  test("no marketing page preloads the mono face", async ({ page }) => {
    await mockPublicBillingConfig(page);
    await mockPublicProofMetrics(page);
    await page.goto("/pricing");
    await waitForFonts(page);

    const preloadHrefs = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="font"]')].map(
        (link) => link.href
      )
    );
    // The Latin UI face is the only thing worth blocking a marketing render on.
    expect(preloadHrefs.length).toBeLessThanOrEqual(1);
  });
});

test.describe("font system: accessibility and reflow", () => {
  const VIEWPORTS = [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
  ];

  for (const viewport of VIEWPORTS) {
    for (const lang of ["en", "ko", "zh"] as const) {
      test(`no horizontal overflow at ${viewport.width}px in ${lang}`, async ({ page }) => {
        await mockPublicBillingConfig(page);
        await mockPublicProofMetrics(page);
        await page.setViewportSize(viewport);
        await page.goto("/");
        await selectLanguage(page, lang);
        await expectNoHorizontalOverflow(page);
      });
    }
  }

  test("200% text scaling keeps the locale font and does not overflow", async ({ page }) => {
    await mockPublicBillingConfig(page);
    await mockPublicProofMetrics(page);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/");
    await selectLanguage(page, "ko");

    await page.evaluate(() => {
      document.documentElement.style.fontSize = "32px";
    });
    await waitForFonts(page);

    expect(await declaredFontFamily(page.locator("body"))).toMatch(/^Noto Sans KR\b/);
    await expectNoHorizontalOverflow(page);
  });

  test("dark mode uses the same families as light mode", async ({ page }) => {
    await mockPublicBillingConfig(page);
    await mockPublicProofMetrics(page);
    await page.goto("/");
    await selectLanguage(page, "ko");
    const light = await declaredFontFamily(page.locator("body"));

    await page.emulateMedia({ colorScheme: "dark" });
    await waitForFonts(page);
    expect(await declaredFontFamily(page.locator("body"))).toBe(light);
  });

  test("customer chat surfaces keep text at 11px or larger", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/chat?entry=guest-preview");
    await waitForFonts(page);

    const tooSmall = await page.evaluate(() => {
      const offenders: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("body *")) {
        if (!el.offsetParent && el.tagName !== "BODY") continue;
        const hasOwnText = [...el.childNodes].some(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
        );
        if (!hasOwnText) continue;
        const size = parseFloat(window.getComputedStyle(el).fontSize);
        if (size < 11) {
          offenders.push(`${el.tagName}.${el.className} ${size}px`);
        }
      }
      return offenders;
    });

    expect(tooSmall).toEqual([]);
  });

  test("the mobile composer input stays at 16px so iOS does not zoom", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/chat?entry=guest-preview");
    await waitForFonts(page);

    const textarea = page.getByTestId("chat-textarea");
    await expect(textarea).toBeVisible();
    const size = await textarea.evaluate((el) =>
      parseFloat(window.getComputedStyle(el).fontSize)
    );
    expect(size).toBeGreaterThanOrEqual(16);
  });
});
