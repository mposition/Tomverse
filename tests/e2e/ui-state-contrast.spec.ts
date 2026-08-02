import { expect, test, type Page } from "@playwright/test";
import {
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  enterConversation,
  expectThemeApplied,
  installChatModelStub,
  setDeterministicTheme,
  submitComposer,
  type Theme,
} from "./support/chat-state-fixtures";
import { prepareGuestPage } from "./support/app-fixtures";
import {
  findUndersizedText,
  formatContrastSample,
  measureContrastInScope,
} from "./support/ui-audit";

/**
 * UI-003 / UI-007. Failure, recovery and status text has to be readable at the
 * moment it matters most, in both themes.
 *
 * Two things make this measurable rather than assumed:
 *
 * - Every ratio is composited from real painted pixels. Tailwind v4 emits
 *   `oklch()`, Chromium serialises the computed value as CIE `lab()`, and this
 *   product leans on `/70`-style alpha, so both an `rgb()` regex and a naive
 *   "foreground token vs. surface token" comparison get the wrong answer. See
 *   `measureContrast` in support/ui-audit.ts.
 * - The states are the product's own, entered through the same fixtures the
 *   golden suite uses -- not a stand-in card built for the test.
 */

const THEMES: Theme[] = ["light", "dark"];

async function expectScopeMeetsAa(page: Page, scopeSelector: string, label: string) {
  const scope = page.locator(scopeSelector);
  const roots = await scope.count();
  expect(roots, `${label}: scope not present`).toBeGreaterThan(0);

  const failures: string[] = [];
  let measured = 0;
  for (let index = 0; index < roots; index++) {
    const samples = await measureContrastInScope(scope.nth(index));
    measured += samples.length;
    for (const sample of samples) {
      if (!sample.passes) {
        failures.push(formatContrastSample(`${label}/${sample.selector}`, sample));
      }
    }
  }
  expect(measured, `${label}: found no measurable text`).toBeGreaterThan(0);
  expect(failures, `WCAG 2.2 AA failures:\n${failures.join("\n")}`).toEqual([]);
}

const FAILING_STUB = {
  "gpt-5-4-mini": { kind: "error", status: 500, message: "QA fixture: request failed." },
  "claude-sonnet-5": { kind: "error", status: 500, message: "QA fixture: request failed." },
  "gemini-3-5-flash": {
    kind: "error",
    status: 500,
    message: "QA fixture: request failed.",
  },
} as const;

const PARTIAL_STUB = {
  "gpt-5-4-mini": { kind: "success", chunks: ["The capital of France is Paris."], intervalMs: 5 },
  "claude-sonnet-5": { kind: "success", chunks: ["Paris."], intervalMs: 5 },
  "gemini-3-5-flash": {
    kind: "error",
    status: 500,
    message: "QA fixture: model C failed.",
  },
} as const;

test.use({ hasTouch: true });

test.beforeEach(async ({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Colour measurement is engine-sensitive; it is maintained on desktop-chromium like the goldens."
  );
});

for (const theme of THEMES) {
  test(`full-error recovery text meets AA (${theme})`, { tag: "@ui-risk" }, async ({ page }) => {
    await enterConversation(page, { theme, viewport: DESKTOP_VIEWPORT, lang: "ko" });
    await installChatModelStub(page, FAILING_STUB as never);
    await submitComposer(page, "Trigger a full failure.", DESKTOP_VIEWPORT.width);

    const errorCards = page.locator(
      '[data-testid="chat-message"][data-message-role="assistant"] [role="alert"]'
    );
    await expect(errorCards).toHaveCount(3);

    await expectScopeMeetsAa(
      page,
      '[data-testid="chat-message"][data-message-role="assistant"] [role="alert"]',
      `full-error/${theme}`
    );
  });

  test(`partial-failure recovery text meets AA (${theme})`, { tag: "@ui-risk" }, async ({ page }) => {
    await enterConversation(page, { theme, viewport: DESKTOP_VIEWPORT, lang: "ko" });
    await installChatModelStub(page, PARTIAL_STUB as never);
    await submitComposer(page, "Trigger a single-model failure.", DESKTOP_VIEWPORT.width);

    const errorCards = page.locator(
      '[data-testid="chat-message"][data-message-role="assistant"] [role="alert"]'
    );
    await expect(errorCards).toHaveCount(1);

    await expectScopeMeetsAa(
      page,
      '[data-testid="chat-message"][data-message-role="assistant"] [role="alert"]',
      `partial-failure/${theme}`
    );
  });

  test(`mobile chat status chrome meets AA (${theme})`, { tag: "@ui-risk" }, async ({ page }) => {
    await enterConversation(page, { theme, viewport: MOBILE_VIEWPORT, lang: "ko" });

    await expectScopeMeetsAa(
      page,
      '[data-testid="mobile-header-model-summary"]',
      `mobile-header/${theme}`
    );
    await expectScopeMeetsAa(page, '[data-testid="chat-input"]', `composer/${theme}`);
  });

  test(`desktop sidebar chrome meets AA (${theme})`, { tag: "@ui-risk" }, async ({ page }) => {
    await enterConversation(page, { theme, viewport: DESKTOP_VIEWPORT, lang: "ko" });
    // The rail opens collapsed to icons; the copy this covers -- conversation
    // titles, group labels, plan and credit status -- only exists expanded.
    const expand = page.getByTestId("sidebar-expand-button");
    if (await expand.count()) await expand.click();
    await expect(page.getByTestId("sidebar-new-chat")).toBeVisible();
    await expectScopeMeetsAa(
      page,
      '[data-testid="chat-sidebar"]',
      `sidebar/${theme}`
    );
  });

  test(`desktop model panel chrome meets AA (${theme})`, { tag: "@ui-risk" }, async ({ page }) => {
    await enterConversation(page, { theme, viewport: DESKTOP_VIEWPORT, lang: "ko" });
    await expectScopeMeetsAa(
      page,
      '[data-testid="desktop-model-panel"]',
      `desktop-model-panel/${theme}`
    );
  });
}

/**
 * UI-007. The audit's complaint was not "some text is small" but "text a
 * consumer has to read is 9-10px". 11px is the floor the consent notice already
 * settled on for required copy, so it is the floor here too. Genuine
 * exceptions -- a counter drawn inside a 20px avatar whose value is also in the
 * accessible name -- opt out explicitly with `data-allow-small-text`, which
 * keeps them visible in review instead of invisible in a blanket threshold.
 */
const MINIMUM_CONSUMER_FONT_PX = 11;

test("consumer chrome carries no sub-11px text (mobile)", { tag: "@ui-risk" }, async ({ page }) => {
  await enterConversation(page, { theme: "light", viewport: MOBILE_VIEWPORT, lang: "ko" });

  const scopes = [
    '[data-testid="mobile-chat-shell"] header',
    '[data-testid="chat-input"]',
  ];
  const offenders: Array<{ scope: string; selector: string; fontSizePx: number; text: string }> =
    [];
  for (const scope of scopes) {
    const found = await findUndersizedText(page.locator(scope).first(), MINIMUM_CONSUMER_FONT_PX);
    offenders.push(...found.map((item) => ({ scope, ...item })));
  }
  expect(
    offenders,
    `Sub-${MINIMUM_CONSUMER_FONT_PX}px consumer text:\n${offenders
      .map((o) => `${o.scope} ${o.selector} ${o.fontSizePx}px "${o.text}"`)
      .join("\n")}`
  ).toEqual([]);
});

test("full-error recovery copy carries no sub-11px text", { tag: "@ui-risk" }, async ({ page }) => {
  await enterConversation(page, { theme: "light", viewport: DESKTOP_VIEWPORT, lang: "ko" });
  await installChatModelStub(page, FAILING_STUB as never);
  await submitComposer(page, "Trigger a full failure.", DESKTOP_VIEWPORT.width);

  const card = page
    .locator('[data-testid="chat-message"][data-message-role="assistant"] [role="alert"]')
    .first();
  await expect(card).toBeVisible();

  const offenders = await findUndersizedText(card, MINIMUM_CONSUMER_FONT_PX);
  expect(
    offenders,
    `Sub-${MINIMUM_CONSUMER_FONT_PX}px error copy:\n${offenders
      .map((o) => `${o.selector} ${o.fontSizePx}px "${o.text}"`)
      .join("\n")}`
  ).toEqual([]);
});

/**
 * UI-CONTRAST-001. Everything above measures a *state container* -- an error
 * card, a retry affordance -- entered through the chat fixtures. That left
 * the ordinary, always-on body and supporting text of the routes a customer
 * actually lands on unmeasured, which is how the composer's AI disclaimer
 * (2.62:1 light, 3.67:1 dark) and the sign-in "or" divider (2.62:1 light)
 * stayed AA failures while this suite was green.
 *
 * This sweep measures every visible text-bearing element on the four required
 * routes, in both locales and both themes, at the two required viewports.
 * `measureContrastInScope` composites the real painted pixels through a
 * canvas (Tailwind v4 emits `oklch()`, Chromium serialises `lab()`, and the
 * product leans on `/70`-style alpha), and it already skips `.sr-only`,
 * replaced-element fallback content, and disabled controls -- the last of
 * which WCAG 2.2 SC 1.4.3 exempts as an inactive user interface component.
 */
/**
 * UI-008 / UX-014. The four routes this started with were the ones the Insight
 * audit had screenshots of. Everything a visitor can reach before signing in is
 * in scope now: the legal and support pages carry the longest runs of
 * supporting text in the product, `/status` is what a user reads during an
 * incident, and `/models` and `/faq` are the two densest tables of small
 * secondary copy. Each route is measured in both locales, both themes and both
 * viewports, so the matrix is 4x what the route count suggests.
 */
const REQUIRED_ROUTES = [
  "/",
  "/chat",
  "/auth/signin",
  "/pricing",
  "/support",
  "/terms",
  "/privacy",
  "/refund",
  "/status",
  "/models",
  "/faq",
  "/about",
] as const;
const REQUIRED_LOCALES = ["ko", "en"] as const;
const REQUIRED_VIEWPORTS = [
  { width: 1440, height: 900, name: "desktop" },
  { width: 390, height: 844, name: "mobile" },
] as const;

for (const viewport of REQUIRED_VIEWPORTS) {
  for (const route of REQUIRED_ROUTES) {
    test(
      `${route} meets WCAG 2.2 AA for body and supporting text (${viewport.name})`,
      { tag: "@ui-risk" },
      async ({ page }) => {
        test.setTimeout(120_000);
        const failures: string[] = [];
        let measured = 0;

        for (const lang of REQUIRED_LOCALES) {
          for (const theme of THEMES) {
            await page.setViewportSize({
              width: viewport.width,
              height: viewport.height,
            });
            await prepareGuestPage(page, lang);
            await setDeterministicTheme(page, theme);
            await page.goto(`${route}?lang=${lang}`);
            await page.waitForLoadState("networkidle").catch(() => undefined);
            // Webfont metrics decide which glyphs are painted, and the Korean
            // and Latin faces are self-hosted with preload: false.
            await page.evaluate(() => document.fonts.ready);
            await expectThemeApplied(page, theme);

            const samples = await measureContrastInScope(page.locator("body"));
            measured += samples.length;
            for (const sample of samples) {
              if (sample.passes) continue;
              failures.push(
                formatContrastSample(`${lang}/${theme}${sample.selector}`, sample)
              );
            }
          }
        }

        expect(measured, `${route}: found no measurable text`).toBeGreaterThan(0);
        expect(
          failures,
          `WCAG 2.2 AA failures on ${route} (${viewport.name}):\n${failures.join("\n")}`
        ).toEqual([]);
      }
    );
  }
}
