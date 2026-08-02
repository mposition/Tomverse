import { expect, test } from "@playwright/test";
import { mockAuthenticatedApi } from "./support/app-fixtures";
import { formatContrastSample, measureContrast } from "./support/ui-audit";

/**
 * UI-009 and UI-023, both on the conversation context menu.
 *
 * UI-009: the panel and its items were dark-only, so in light theme a dark slab
 * appeared over a light sidebar -- and the `⋮` trigger went from `text-zinc-500`
 * to `hover:text-zinc-200` with no `dark:` guard, which on the light sidebar is
 * roughly 1.1:1. The affordance disappeared exactly when the pointer reached it.
 *
 * UI-023: `animate-fadeIn` was applied to that panel but defined nowhere, so
 * Tailwind emitted no rule for it and the class was inert.
 */

async function openConversationMenu(page: import("@playwright/test").Page) {
  await page.getByTestId("conversation-menu").first().click();
  await expect(page.getByTestId("conversation-menu-panel")).toBeVisible();
}

test.describe("conversation context menu", () => {
  test(
    "the panel follows the light theme instead of staying dark",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await mockAuthenticatedApi(page);
      await page.addInitScript(() =>
        window.localStorage.setItem("tomverse_theme_preference", "light")
      );
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.goto("/chat?lang=en");
      await expect(page.locator("html")).not.toHaveClass(/dark/);

      await openConversationMenu(page);
      const panel = page.getByTestId("conversation-menu-panel");

      // A light panel is what the surrounding sidebar is; a dark one is the bug.
      const panelIsLight = await panel.evaluate((element) => {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d")!;
        // Tailwind 4 serialises colours as oklab(...); painting resolves them.
        context.fillStyle = getComputedStyle(element).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
        return 0.2126 * r + 0.7152 * g + 0.0722 * b > 128;
      });
      expect(panelIsLight).toBe(true);

      // And the label on it still has to be readable.
      // Sample the settled state rather than an engine-dependent frame inside
      // the 120ms opacity entrance, which composites both colours with the
      // page underneath and is not the state a user reads.
      await panel.evaluate((element) =>
        Promise.all(element.getAnimations().map((animation) => animation.finished))
      );
      const item = panel.getByRole("button").first();
      const sample = await measureContrast(item, "context menu item");
      expect(sample.passes, formatContrastSample("context menu item", sample)).toBe(
        true
      );
    }
  );

  test(
    "the actions trigger stays visible on hover in light theme",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await mockAuthenticatedApi(page);
      await page.addInitScript(() =>
        window.localStorage.setItem("tomverse_theme_preference", "light")
      );
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.goto("/chat?lang=en");

      const trigger = page.getByTestId("conversation-menu").first();
      const row = page.locator('[data-testid="sidebar-conversation-item"]').first();
      await row.hover();
      await expect(trigger).toBeVisible();

      // Move the real pointer to the trigger's centre and confirm `:hover`
      // actually matched before sampling -- `locator.hover()` can settle on the
      // row while the row-level hover styles are still what is painted.
      const box = await trigger.boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await expect
        .poll(() => trigger.evaluate((element) => element.matches(":hover")))
        .toBe(true);

      // 3:1 is the non-text contrast floor for a UI component (WCAG 1.4.11).
      // The icon inherits `color`, so the button's own composited pair is what
      // decides whether the affordance is still visible under the pointer.
      const sample = await measureContrast(trigger, "conversation actions");
      expect(
        sample.ratio,
        formatContrastSample("conversation actions", sample)
      ).toBeGreaterThanOrEqual(3);
    }
  );

  test(
    "animate-fadeIn resolves to a real animation",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await mockAuthenticatedApi(page);
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.goto("/chat?lang=en");
      await openConversationMenu(page);

      const animationName = await page
        .getByTestId("conversation-menu-panel")
        .evaluate((element) => getComputedStyle(element).animationName);
      expect(animationName).not.toBe("none");
    }
  );

  test(
    "the fade is suppressed under reduced motion",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await mockAuthenticatedApi(page);
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.goto("/chat?lang=en");
      await openConversationMenu(page);

      const duration = await page
        .getByTestId("conversation-menu-panel")
        .evaluate((element) => getComputedStyle(element).animationDuration);
      // The global reduced-motion rule collapses it rather than removing it.
      expect(parseFloat(duration)).toBeLessThan(0.01);
    }
  );
});
