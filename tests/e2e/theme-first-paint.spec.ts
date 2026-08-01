import { expect, test, type Page } from "@playwright/test";

/**
 * UI-001. The theme was applied by `ThemeController`, a `useEffect`, so it ran
 * only after hydration. Until then the document painted with the `:root`
 * defaults -- white -- in a product whose default theme is dark. On the
 * statically prerendered marketing routes the cached HTML is always light-first,
 * so the flash was unconditional there.
 *
 * These tests deliberately do not assert on the *steady* state, which passed
 * before the fix too because Playwright retries. They sample the document at the
 * first opportunity the page gives them and assert it is already correct:
 *
 * - `readAtFirstPaint` registers an init script that captures
 *   `documentElement.className` from inside `requestAnimationFrame` on
 *   `DOMContentLoaded`, i.e. before React has hydrated.
 * - the raw HTML assertions confirm the bootstrap ships in the served bytes.
 */

const THEME_KEY = "tomverse_theme_preference";

type FirstPaintSample = {
  className: string;
  dataTheme: string | null;
  colorScheme: string;
};

async function readAtFirstPaint(page: Page): Promise<FirstPaintSample> {
  return page.evaluate(
    () =>
      (window as unknown as { __themeFirstPaint?: FirstPaintSample })
        .__themeFirstPaint as FirstPaintSample
  );
}

async function captureFirstPaint(page: Page, stored: string | null) {
  await page.addInitScript(
    ({ key, value }) => {
      try {
        if (value === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, value);
      } catch {
        // Storage can be unavailable; the bootstrap must cope either way.
      }
      const record = () => {
        const root = document.documentElement;
        (
          window as unknown as { __themeFirstPaint?: unknown }
        ).__themeFirstPaint = {
          className: root.className,
          dataTheme: root.dataset.theme ?? null,
          colorScheme: root.style.colorScheme,
        };
      };
      // Runs before hydration: DOMContentLoaded fires once the parser has seen
      // the bootstrap, and the rAF callback lands before the first paint.
      document.addEventListener("DOMContentLoaded", () =>
        requestAnimationFrame(record)
      );
    },
    { key: THEME_KEY, value: stored }
  );
}

test.describe("theme is correct before the first paint", () => {
  test(
    "a stored dark preference is applied before hydration",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await captureFirstPaint(page, "dark");
      await page.goto("/pricing");

      const sample = await readAtFirstPaint(page);
      expect(sample.className).toContain("dark");
      expect(sample.dataTheme).toBe("dark");
      expect(sample.colorScheme).toBe("dark");
    }
  );

  test(
    "a stored light preference never flashes dark",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await captureFirstPaint(page, "light");
      await page.goto("/pricing");

      const sample = await readAtFirstPaint(page);
      expect(sample.className).not.toContain("dark");
      expect(sample.dataTheme).toBe("light");
      expect(sample.colorScheme).toBe("light");
    }
  );

  test(
    "system preference resolves to dark before the first paint",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await page.emulateMedia({ colorScheme: "dark" });
      await captureFirstPaint(page, "system");
      await page.goto("/pricing");

      const sample = await readAtFirstPaint(page);
      expect(sample.className).toContain("dark");
      expect(sample.dataTheme).toBe("system");
      expect(sample.colorScheme).toBe("dark");
    }
  );

  test(
    "no stored preference follows the system setting",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await page.emulateMedia({ colorScheme: "dark" });
      await captureFirstPaint(page, null);
      await page.goto("/pricing");

      const sample = await readAtFirstPaint(page);
      expect(sample.className).toContain("dark");
      expect(sample.dataTheme).toBe("system");
    }
  );

  test(
    "a corrupted stored value falls back to system instead of throwing",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await page.emulateMedia({ colorScheme: "dark" });
      await captureFirstPaint(page, "{not-a-theme}");
      await page.goto("/pricing");

      const sample = await readAtFirstPaint(page);
      expect(sample.dataTheme).toBe("system");
      expect(sample.className).toContain("dark");
    }
  );

  test(
    "the localized prerendered root also bootstraps the theme",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await captureFirstPaint(page, "dark");
      await page.goto("/ko");

      const sample = await readAtFirstPaint(page);
      expect(sample.className).toContain("dark");
      expect(sample.dataTheme).toBe("dark");
      await expect(page.locator("html")).toHaveAttribute("lang", "ko");
    }
  );

  test(
    "the application root also bootstraps the theme",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await captureFirstPaint(page, "dark");
      await page.goto("/chat");

      const sample = await readAtFirstPaint(page);
      expect(sample.className).toContain("dark");
      expect(sample.dataTheme).toBe("dark");
    }
  );

  test(
    "the bootstrap ships inline, self-contained, in the served HTML",
    { tag: "@ui-risk" },
    async ({ request, baseURL }) => {
      for (const route of ["/pricing", "/ko", "/chat"]) {
        const response = await request.get(`${baseURL}${route}`, {
          failOnStatusCode: false,
        });
        const html = await response.text();
        expect(html, `${route} must carry the bootstrap`).toContain(
          "prefers-color-scheme: dark"
        );
        expect(html, `${route} must read the stored preference`).toContain(
          THEME_KEY
        );
      }
    }
  );

  test(
    "switching theme after load still works and leaves no hydration error",
    { tag: "@ui-risk" },
    async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => consoleErrors.push(String(error)));

      await captureFirstPaint(page, "dark");
      await page.goto("/pricing");
      await expect(page.locator("html")).toHaveClass(/dark/);

      // ThemeController still owns everything after the bootstrap.
      await page.evaluate((key) => {
        window.localStorage.setItem(key, "light");
        window.dispatchEvent(
          new CustomEvent("tomverse:theme-preference-changed", {
            detail: "light",
          })
        );
      }, THEME_KEY);
      await expect(page.locator("html")).not.toHaveClass(/dark/);

      expect(
        consoleErrors.filter((message) => /hydrat|did not match/i.test(message))
      ).toEqual([]);
    }
  );
});
