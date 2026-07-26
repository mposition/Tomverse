import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  modelMenuTrigger,
  openModelCatalogue,
  prepareGuestPage,
} from "./support/app-fixtures";

/**
 * STG-F008 responsive contract. The picker is a full-height sheet on phones and
 * a centred modal on desktop, so every viewport is checked for the same five
 * things: the recommendations are readable, "All models" is reachable, search
 * and filters work, the selection is visible, and the completion controls are
 * not pushed off-screen or under the keyboard/safe area.
 */
const VIEWPORTS = [
  { name: "320x568", width: 320, height: 568 },
  { name: "390x844", width: 390, height: 844 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "1440x900", width: 1440, height: 900 },
] as const;

const MIN_HIT_AREA = 44;

async function expectWithinViewport(page: Page, locator: Locator, label: string) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box, `${label} has no box`).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x, `${label} overflows left`).toBeGreaterThanOrEqual(-1);
  expect(box!.y, `${label} overflows top`).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, `${label} overflows right`).toBeLessThanOrEqual(
    viewport!.width + 1
  );
  expect(box!.y + box!.height, `${label} overflows bottom`).toBeLessThanOrEqual(
    viewport!.height + 1
  );
}

async function expectMinHitArea(locator: Locator, label: string) {
  const box = await locator.boundingBox();
  expect(box, `${label} has no box`).not.toBeNull();
  // Padded pseudo-element hit areas are not part of the layout box, so the
  // effective target is measured from the element's own click rect plus any
  // ::before inset the component adds.
  const effective = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const before = getComputedStyle(element, "::before");
    const inset = Math.abs(Number.parseFloat(before.insetBlockStart || "0")) || 0;
    return {
      width: rect.width + inset * 2,
      height: rect.height + inset * 2,
    };
  });
  expect(effective.width, `${label} width`).toBeGreaterThanOrEqual(MIN_HIT_AREA - 0.5);
  expect(effective.height, `${label} height`).toBeGreaterThanOrEqual(MIN_HIT_AREA - 0.5);
}

for (const viewport of VIEWPORTS) {
  test(`model picker stays usable at ${viewport.name}`, async ({ page }, testInfo) => {
    // The 44px minimum tracks useIsMobileShell(), which requires a coarse
    // pointer AND a width under 768px -- a touch tablet at 768px+ gets the
    // desktop shell and its compact mouse sizing on purpose. Layout,
    // reachability and overflow are checked at every viewport regardless.
    const usesMobileShell =
      testInfo.project.name.startsWith("mobile") && viewport.width <= 767;
    const checkHitArea = async (locator: Locator, label: string) => {
      if (!usesMobileShell) return;
      await expectMinHitArea(locator, label);
    };

    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await prepareGuestPage(page, "en");
    await page.goto("/chat");

    await modelMenuTrigger(page).click();
    const dialog = page.locator("#chat-input-popover");
    await expect(dialog).toBeVisible();
    await expectWithinViewport(page, dialog, `dialog at ${viewport.name}`);

    // 1. Recommendations are readable, one per row when there is no space for two.
    const cards = dialog.getByTestId("recommended-model-option");
    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThanOrEqual(6);
    expect(cardCount).toBeLessThanOrEqual(8);
    await expect(cards.first()).toBeVisible();
    await expectWithinViewport(page, cards.first(), "first recommendation");

    if (viewport.width <= 390) {
      const columns = await dialog
        .getByTestId("model-recommendations")
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
      expect(columns, "phones show a single-column recommendation list").toBe(1);
    }

    // 2. The selection is visible without leaving the screen.
    await expect(dialog.getByTestId("selected-model-chip").first()).toBeVisible();

    // 3. Completion controls are reachable, not clipped or covered.
    const summary = dialog.getByTestId("model-selection-summary");
    const done = dialog.getByTestId("model-picker-done");
    await expect(summary).toBeVisible();
    await expect(done).toBeVisible();
    await expectWithinViewport(page, done, "done control");
    await checkHitArea(dialog.getByTestId("model-search-input"), "search input");

    // 4. Search works from the recommended screen and drops into the catalogue.
    await dialog.getByTestId("model-search-input").fill("sonar");
    await expect.poll(() => dialog.getByTestId("model-option").count()).toBeGreaterThan(0);
    await expect(done).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await dialog.getByTestId("model-search-clear").click();
    await expect(cards.first()).toBeVisible();

    // 5. All models, its task filter and its filter sheet all fit and work.
    await openModelCatalogue(page);
    const taskFilter = dialog.getByTestId("model-task-filter");
    const filterTrigger = dialog.getByTestId("model-filter-sheet-trigger");
    await expect(taskFilter).toBeVisible();
    await expectWithinViewport(page, taskFilter, "task filter");
    await checkHitArea(filterTrigger, "filter sheet trigger");
    await checkHitArea(
      dialog.getByTestId("model-favorite-star").first(),
      "favourite star"
    );

    await filterTrigger.click();
    const sheet = dialog.getByTestId("model-filter-sheet");
    await expect(sheet).toBeVisible();
    await expectWithinViewport(page, sheet, "filter sheet");
    await checkHitArea(
      sheet.getByTestId("capability-filter-search"),
      "capability chip"
    );
    await checkHitArea(sheet.getByTestId("model-filter-apply"), "apply control");
    await checkHitArea(
      sheet.getByTestId("model-filter-sheet-close"),
      "sheet close control"
    );
    await sheet.getByTestId("model-filter-apply").click();
    await expect(sheet).toHaveCount(0);

    await expect(dialog.getByTestId("model-catalogue-result-count")).toBeVisible();
    await expect(done).toBeVisible();
    await expectWithinViewport(page, done, "done control in catalogue");
    await expectNoHorizontalOverflow(page);
  });
}

test("the picker footer clears the mobile keyboard and safe area", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareGuestPage(page, "en");
  await page.goto("/chat");
  await modelMenuTrigger(page).click();

  const dialog = page.locator("#chat-input-popover");
  const done = dialog.getByTestId("model-picker-done");
  await expect(done).toBeVisible();

  // Focusing the search field is what raises the on-screen keyboard; the sheet
  // is bottom-inset by env(safe-area-inset-bottom) so the footer must stay
  // inside the visual viewport rather than sliding under it.
  await dialog.getByTestId("model-search-input").focus();
  const metrics = await page.evaluate(() => {
    const footer = document.querySelector('[data-testid="model-selection-summary"]');
    const rect = footer!.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      visualHeight: window.visualViewport?.height ?? window.innerHeight,
    };
  });
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.visualHeight + 1);
  await expectNoHorizontalOverflow(page);
});
