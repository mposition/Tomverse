import { expect, test, type Page } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

/**
 * UI-001. The theme applied by the *first paint* must already be the one the
 * visitor ends up with.
 *
 * Before this, `.dark` could only be written by React, so every document
 * painted light and snapped to the user's theme after hydration. Two halves fix
 * it, and they are tested separately because they fail separately:
 *
 *  - `app/globals.css` answers "no explicit choice" from `prefers-color-scheme`
 *    with no script at all. This is what a `force-static`, publicly cached
 *    marketing page can honour, since it depends on nothing per-visitor.
 *  - `components/ThemeBootstrap.tsx` answers the one case CSS cannot: an
 *    explicit choice that contradicts the OS. It runs during HTML parsing,
 *    before the first paint.
 *
 * The assertions below compare the theme at `DOMContentLoaded` -- captured by
 * an init script, which is the earliest a test can observe the document -- with
 * the theme after hydration. Equal means no flash. Asserting only the final
 * state would pass on the very build this spec exists to fail.
 */

const THEME_COOKIE = "tomverse_theme";
const LEGACY_STORAGE_KEY = "tomverse_theme_preference";

type ThemeSample = {
  className: string;
  dataTheme: string | null;
  backgroundColor: string;
  colorScheme: string;
};

type ThemeObservation = {
  firstPaint: ThemeSample | null;
  hydrated: ThemeSample;
  consoleErrors: string[];
  cspViolations: string[];
};

/**
 * Records the document's theme as soon as the parser reaches the end of the
 * document, which is after ThemeBootstrap has run and before React hydrates.
 */
async function captureFromFirstPaint(page: Page) {
  await page.addInitScript(() => {
    const read = () => {
      const root = document.documentElement;
      return {
        className: root.className,
        dataTheme: root.dataset.theme ?? null,
        // `--background` is applied to <body>, not <html> (app/globals.css),
        // so the painted colour has to be read there.
        backgroundColor: document.body
          ? getComputedStyle(document.body).backgroundColor
          : "",
        colorScheme: getComputedStyle(root).colorScheme,
      };
    };
    const record = () => {
      (window as unknown as Record<string, unknown>).__firstPaintTheme = read();
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", record, { once: true });
    } else {
      record();
    }
  });
}

async function observe(page: Page, path: string): Promise<ThemeObservation> {
  const consoleErrors: string[] = [];
  const cspViolations: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    const text = message.text();
    // React reports a server/client mismatch as a hydration error. The theme
    // classes are under `suppressHydrationWarning`, so any that appears here is
    // a real one.
    if (/hydrat/i.test(text)) consoleErrors.push(text);
    if (/Content Security Policy|Refused to execute/i.test(text)) {
      cspViolations.push(text);
    }
  });

  await page.goto(path);
  await page.waitForLoadState("networkidle");

  const result = await page.evaluate(() => {
    const root = document.documentElement;
    return {
      firstPaint:
        ((window as unknown as Record<string, unknown>).__firstPaintTheme as
          | ThemeSample
          | undefined) ?? null,
      hydrated: {
        className: root.className,
        dataTheme: root.dataset.theme ?? null,
        backgroundColor: getComputedStyle(document.body).backgroundColor,
        colorScheme: getComputedStyle(root).colorScheme,
      },
    };
  });

  return { ...result, consoleErrors, cspViolations };
}

/** The theme did not change between the first paint and hydration. */
function expectNoFlash(observation: ThemeObservation, label: string) {
  expect(observation.firstPaint, `${label}: first-paint sample missing`).not.toBeNull();
  expect(
    observation.firstPaint!.backgroundColor,
    `${label}: background changed after hydration (this is the flash)`
  ).toBe(observation.hydrated.backgroundColor);
  expect(
    observation.firstPaint!.colorScheme,
    `${label}: color-scheme changed after hydration`
  ).toBe(observation.hydrated.colorScheme);
  expect(observation.consoleErrors, `${label}: hydration errors`).toEqual([]);
  expect(observation.cspViolations, `${label}: CSP violations`).toEqual([]);
}

const DARK_BACKGROUND = "rgb(10, 10, 10)";
const LIGHT_BACKGROUND = "rgb(255, 255, 255)";

test.describe("theme is correct on the first paint", () => {
  test.beforeEach(async ({ page }) => {
    await prepareGuestPage(page, "en");
    await captureFromFirstPaint(page);
  });

  // The half CSS answers on its own: no cookie, no stored value, so the OS
  // decides and a statically cached page is still correct.
  for (const colorScheme of ["light", "dark"] as const) {
    for (const path of ["/about", "/chat"]) {
      test(`no explicit choice follows the OS (${colorScheme}, ${path})`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme });
        const observation = await observe(page, path);
        const label = `system/${colorScheme}${path}`;

        expectNoFlash(observation, label);
        expect(observation.hydrated.backgroundColor, label).toBe(
          colorScheme === "dark" ? DARK_BACKGROUND : LIGHT_BACKGROUND
        );
      });
    }
  }

  // The half only the bootstrap can answer: the choice contradicts the OS, and
  // on /about the HTML is prerendered and cached with no theme in it at all.
  for (const [choice, colorScheme, expected] of [
    ["light", "dark", LIGHT_BACKGROUND],
    ["dark", "light", DARK_BACKGROUND],
  ] as const) {
    for (const path of ["/about", "/chat"]) {
      test(`an explicit ${choice} choice overrides an OS set to ${colorScheme} (${path})`, async ({
        page,
        context,
      }) => {
        await context.addCookies([
          { name: THEME_COOKIE, value: choice, url: "http://127.0.0.1:3100" },
        ]);
        await page.emulateMedia({ colorScheme });
        const observation = await observe(page, path);
        const label = `${choice}/os-${colorScheme}${path}`;

        expectNoFlash(observation, label);
        expect(observation.hydrated.backgroundColor, label).toBe(expected);
        expect(observation.hydrated.className, `${label}: class`).toContain(choice);
      });
    }
  }

  test("a cached marketing page carries no visitor theme in its HTML", async ({
    page,
  }) => {
    // The cache-poisoning guard: whatever this visitor's cookie says, the
    // prerendered document must not have been rendered with it, or the next
    // visitor behind the same cache entry inherits it.
    const response = await page.request.get("/about", {
      headers: { Cookie: `${THEME_COOKIE}=dark` },
    });
    const html = await response.text();
    const openingTag = /<html[^>]*>/.exec(html)?.[0] ?? "";
    expect(openingTag, "static marketing HTML must not carry a theme class").not.toMatch(
      /\b(dark|light)\b/
    );
    expect(openingTag, "nor a data-theme").not.toContain("data-theme");
    // ... while still shipping the script that corrects it client-side.
    expect(html).toContain(THEME_COOKIE);
  });

  test("a pre-cookie choice is migrated and then served from the cookie", async ({
    page,
    context,
  }) => {
    // Everyone who picked a theme before the cookie existed has it only in
    // localStorage. It must still apply on the first paint, and must be
    // promoted so the *server* can honour it next time.
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, "dark");
    }, LEGACY_STORAGE_KEY);
    await page.emulateMedia({ colorScheme: "light" });

    const observation = await observe(page, "/chat");
    expectNoFlash(observation, "migration");
    expect(observation.hydrated.backgroundColor).toBe(DARK_BACKGROUND);

    const cookies = await context.cookies();
    expect(
      cookies.find((cookie) => cookie.name === THEME_COOKIE)?.value,
      "the stored choice must be promoted to the cookie"
    ).toBe("dark");
  });

  test("the cookie wins when the two stores disagree", async ({ page, context }) => {
    // A stale localStorage value must never override the cookie, or the theme
    // the server rendered from would be replaced after hydration.
    await context.addCookies([
      { name: THEME_COOKIE, value: "light", url: "http://127.0.0.1:3100" },
    ]);
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, "dark");
    }, LEGACY_STORAGE_KEY);
    await page.emulateMedia({ colorScheme: "dark" });

    const observation = await observe(page, "/chat");
    expectNoFlash(observation, "cookie vs storage");
    expect(observation.hydrated.backgroundColor).toBe(LIGHT_BACKGROUND);
  });

  test("a localized marketing route is themed like the English one", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    const observation = await observe(page, "/ko");
    expectNoFlash(observation, "localized marketing");
    expect(observation.hydrated.backgroundColor).toBe(DARK_BACKGROUND);
  });

  test("a soft navigation keeps the theme it arrived with", async ({
    page,
    context,
  }) => {
    await context.addCookies([
      { name: THEME_COOKIE, value: "dark", url: "http://127.0.0.1:3100" },
    ]);
    await page.emulateMedia({ colorScheme: "light" });
    await observe(page, "/about");

    const before = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor
    );
    await page.getByRole("link", { name: /pricing/i }).first().click();
    await page.waitForLoadState("networkidle");
    const after = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor
    );

    // The bootstrap is inert on a client navigation by design; the theme has to
    // survive on the class already applied rather than be re-applied.
    expect(after, "theme changed across a soft navigation").toBe(before);
    expect(after).toBe(DARK_BACKGROUND);
  });
});
