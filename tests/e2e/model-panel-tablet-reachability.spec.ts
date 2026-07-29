import { expect, test, type Page } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

/**
 * UI-P1-05. At tablet widths the shell falls back to a tabs layout, where only the
 *    active model's panel renders -- the other two are `display:none` and
 *    `aria-hidden`. The tab bar that names all three was suppressed while the
 *    conversation was empty, so the composer said "3 models" while two of them
 *    had no representation on screen at all. At >=1058px all three panels
 *    render side by side, which is why the same empty state was fine there.
 *
 * The tabs/columns boundary is derived, not hard-coded in the product: with 3
 * models, a collapsed 64px sidebar and 32px of chrome, tabs engage once each
 * panel would fall below 310px, i.e. below (310 * 3) + 128 = 1058px. Both
 * sides of that boundary are asserted so a change to the arithmetic shows up
 * here rather than as a layout surprise.
 */

const TABS_BOUNDARY = 1058;

const GUEST_MODELS = ["gpt-5-4-mini", "claude-haiku-4-5", "gemini-2-5-flash"];

const TABLET_WIDTHS = [768, 834, 1024, TABS_BOUNDARY - 1] as const;

async function openEmptyChat(
  page: Page,
  options: { width: number; height?: number; lang: "ko" | "en"; sidebar?: "auto" | "collapsed" }
) {
  await page.setViewportSize({ width: options.width, height: options.height ?? 900 });
  await prepareGuestPage(page, options.lang);
  if (options.sidebar) {
    await page.addInitScript((preference) => {
      window.localStorage.setItem("tomverse_sidebar_collapsed_v1", preference as string);
    }, options.sidebar);
  }
  await page.goto(`/chat?lang=${options.lang}`);
  await expect(page.getByTestId("desktop-chat-shell")).toBeVisible();
  // The empty state is the condition under test, not an incidental starting
  // point: the defect only existed while it was showing.
  await expect(page.getByTestId("chat-empty-state")).toBeVisible();
}

const tabs = (page: Page) => page.getByTestId("model-compare-tab");

for (const width of TABLET_WIDTHS) {
  for (const lang of ["ko", "en"] as const) {
    test(`every selected model is identifiable in an empty conversation at ${width}px (${lang})`, {
      tag: "@ui-risk",
    }, async ({ page }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop-chromium",
        "Viewport is set explicitly; covered once."
      );
      await openEmptyChat(page, { width, lang });

      const tablist = page.getByTestId("model-compare-tablist");
      await expect(tablist, "the tabs layout applies at this width").toBeVisible();
      await expect(tabs(page)).toHaveCount(GUEST_MODELS.length);

      // Every selected model is named, on screen, by a control the user can
      // reach -- not merely present in the DOM.
      const named = await tabs(page).evaluateAll((elements) =>
        elements.map((element) => ({
          modelId: element.getAttribute("data-model-id"),
          text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
          visible: element.getBoundingClientRect().width > 0,
          hidden: Boolean(element.closest('[aria-hidden="true"]')),
        }))
      );
      expect(named.map((entry) => entry.modelId).sort()).toEqual([...GUEST_MODELS].sort());
      for (const entry of named) {
        expect(entry.visible, `${entry.modelId} tab has no box`).toBe(true);
        expect(entry.hidden, `${entry.modelId} tab is inside an aria-hidden subtree`).toBe(
          false
        );
        expect(entry.text.length, `${entry.modelId} tab has no label`).toBeGreaterThan(0);
      }

      // ...and reachable: the WAI-ARIA roving tabindex means one tab is in the
      // tab order and the arrow keys walk the rest.
      await tabs(page).first().focus();
      const reached = new Set<string>();
      for (let step = 0; step < GUEST_MODELS.length; step += 1) {
        const focused = await page.evaluate(() =>
          document.activeElement?.getAttribute("data-model-id")
        );
        if (focused) reached.add(focused);
        await page.keyboard.press("ArrowRight");
      }
      expect([...reached].sort(), "arrow keys did not reach every model").toEqual(
        [...GUEST_MODELS].sort()
      );

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow, "horizontal overflow").toBeLessThanOrEqual(1);
    });
  }
}

test(`the tab bar gives way to columns at ${TABS_BOUNDARY}px`, { tag: "@ui-risk" }, async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Viewport is set explicitly; covered once."
  );
  await openEmptyChat(page, { width: TABS_BOUNDARY, lang: "en" });
  await expect(page.getByTestId("model-compare-tablist")).toHaveCount(0);
  const visiblePanels = await page
    .locator('[data-testid="desktop-model-panel"]')
    .evaluateAll((elements) =>
      elements.filter((element) => element.getBoundingClientRect().width > 0).length
    );
  expect(visiblePanels, "all three panels render side by side above the boundary").toBe(3);
});

test("the tab bar does not overlap the welcome composer or the workflow dock", {
  tag: "@ui-risk",
}, async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chromium",
    "Viewport is set explicitly; covered once."
  );
  await openEmptyChat(page, { width: 834, lang: "ko" });

  const overlaps = await page.evaluate(() => {
    const tablist = document.querySelector('[data-testid="model-compare-tablist"]')!;
    const box = tablist.getBoundingClientRect();
    const others = ["chat-input", "chat-textarea", "chat-empty-state"];
    const found: string[] = [];
    for (const testId of others) {
      for (const element of Array.from(
        document.querySelectorAll(`[data-testid="${testId}"]`)
      )) {
        const other = element.getBoundingClientRect();
        const overlapX = Math.max(
          0,
          Math.min(box.right, other.right) - Math.max(box.left, other.left)
        );
        const overlapY = Math.max(
          0,
          Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top)
        );
        if (overlapX * overlapY > 1) found.push(`${testId}: ${Math.round(overlapX * overlapY)}px^2`);
      }
    }
    return found;
  });
  expect(overlaps, `the tab bar overlapped: ${overlaps.join(", ")}`).toEqual([]);
});
