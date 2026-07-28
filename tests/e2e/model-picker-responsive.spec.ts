import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  modelMenuTrigger,
  openModelCatalogue,
  prepareGuestPage,
} from "./support/app-fixtures";
import {
  closeOnScreenKeyboard,
  expectInsideVisibleViewport,
  expectTappableInVisibleViewport,
  openOnScreenKeyboard,
  readVisualViewport,
} from "./support/ui-audit";

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
    // In this width-driven loop the 44px hit-area checks only run on the mobile
    // projects (where isMobileShell is active). Touch tablets at >=768px are a
    // separate case: they use the desktop layout but must still get 44px
    // targets because they expose a coarse pointer -- that is covered in the
    // dedicated coarse-pointer block below. Layout, reachability and overflow
    // are checked at every viewport regardless.
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

// Product decision (2026-07): touch hit area follows the input device, not the
// layout width. A coarse-pointer tablet at >=768px uses the desktop layout but
// must still offer 44px targets on the picker's key controls.
test.describe("coarse-pointer tablets keep 44px hit areas at >=768px", () => {
  test.use({ hasTouch: true });

  for (const width of [768, 820, 1024]) {
    test(`touch controls stay >=44px at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1024 });
      await prepareGuestPage(page, "en");
      await page.goto("/chat");

      const isCoarse = await page.evaluate(
        () => window.matchMedia("(any-pointer: coarse)").matches
      );
      expect(isCoarse, "hasTouch must expose a coarse pointer").toBe(true);

      await modelMenuTrigger(page).click();
      const dialog = page.locator("#chat-input-popover");
      await expect(dialog).toBeVisible();

      await expectMinHitArea(dialog.getByTestId("model-picker-back"), `back @${width}`);
      await expectMinHitArea(
        dialog.getByTestId("model-search-input"),
        `search input @${width}`
      );
      await expectMinHitArea(dialog.getByTestId("model-picker-done"), `done @${width}`);

      await openModelCatalogue(page);
      await expectMinHitArea(
        dialog.getByTestId("model-task-filter"),
        `task filter @${width}`
      );
      await expectMinHitArea(
        dialog.getByTestId("model-favorite-star").first(),
        `favourite star @${width}`
      );
      await expectMinHitArea(
        dialog.getByTestId("model-option").first(),
        `model option @${width}`
      );
    });
  }
});

test("mouse-only desktop keeps the compact favourite control", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await prepareGuestPage(page, "en");
  await page.goto("/chat");

  const isCoarse = await page.evaluate(
    () => window.matchMedia("(any-pointer: coarse)").matches
  );
  test.skip(isCoarse, "device exposes a coarse pointer; compact density does not apply");

  const dialog = await openModelCatalogue(page);
  const box = await dialog.getByTestId("model-favorite-star").first().boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height, "mouse-only desktop keeps the 32px star").toBeLessThan(44);
});

// ---------------------------------------------------------------------------
// UI-001 / VAL-001: the on-screen keyboard.
//
// The test this replaces focused the search field and then asserted the
// footer's bottom was inside `visualViewport.height`. Focus does not raise a
// keyboard in a headless browser, so `visualViewport.height` was still the full
// 844 and the assertion held with or without a fix -- it could never fail.
//
// `openOnScreenKeyboard` shrinks the visual viewport while leaving the layout
// viewport alone, which is exactly the split iOS Safari (and Android Chrome in
// its default mode) produces. Each case proves the split is real by measuring
// the backdrop -- a sibling `position: fixed; inset: 0` element -- which still
// runs the full layout height while the sheet has been pulled above the
// keyboard. That is the occlusion the sheet used to share.
// ---------------------------------------------------------------------------
const KEYBOARD_VIEWPORTS = [
  { name: "390x844", width: 390, height: 844, keyboard: 336 },
  { name: "320x568", width: 320, height: 568, keyboard: 216 },
] as const;

test.describe("the picker stays completable while the keyboard is up", () => {
  test.use({ hasTouch: true });

  for (const viewport of KEYBOARD_VIEWPORTS) {
    test(`model selection can be finished at ${viewport.name} with the keyboard open`, {
      tag: "@ui-risk",
    }, async ({ page }, testInfo) => {
      test.skip(
        !testInfo.project.name.startsWith("mobile"),
        "The compact sheet layout only renders on touch (mobile-*) projects."
      );

      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await prepareGuestPage(page, "en");
      await page.goto("/chat");

      await modelMenuTrigger(page).click();
      const dialog = page.locator("#chat-input-popover");
      const done = dialog.getByTestId("model-picker-done");
      await expect(dialog).toBeVisible();
      await expect(done).toBeVisible();

      const search = dialog.getByTestId("model-search-input");
      await search.click();
      await openOnScreenKeyboard(page, viewport.keyboard);

      // 1. The fixture really did what a keyboard does.
      const metrics = await readVisualViewport(page);
      expect(metrics.layoutHeight, "layout viewport is unchanged").toBe(viewport.height);
      expect(metrics.visualHeight, "visual viewport shrank by the keyboard").toBe(
        viewport.height - viewport.keyboard
      );

      // 2. A fixed element that does not compensate is still occluded, which is
      //    the bug this covers -- the sheet is the one that had to move.
      const backdropBottom = await page.evaluate(() => {
        const backdrop = document.querySelector<HTMLElement>(
          'button.fixed.inset-0[class*="z-\\\\[90\\\\]"]'
        );
        return backdrop ? backdrop.getBoundingClientRect().bottom : null;
      });
      if (backdropBottom !== null) {
        expect(
          backdropBottom,
          "sanity: a non-compensating fixed element still spans the layout viewport"
        ).toBeGreaterThan(metrics.visualHeight);
      }

      // 3. The sheet compensated by exactly the occluded height.
      await expect(dialog).toHaveAttribute(
        "data-keyboard-inset",
        String(viewport.keyboard)
      );

      // 4. Everything needed to finish is inside what the user can see.
      await expectInsideVisibleViewport(page, dialog, "picker sheet");
      await expectInsideVisibleViewport(page, done, "done control");
      await expectInsideVisibleViewport(page, search, "search input");
      await expect(dialog.getByTestId("selected-model-chip").first()).toBeVisible();

      // 5. There is exactly one scroll container inside the sheet, whichever
      //    mode it is in -- no nested scrollers for a thumb to fight.
      const scrollers = await dialog.evaluate((sheet) =>
        Array.from(sheet.querySelectorAll("*")).filter((node) => {
          const style = getComputedStyle(node);
          const scrollable = /(auto|scroll)/.test(style.overflowY);
          return scrollable && node.scrollHeight > node.clientHeight + 1;
        }).length
      );
      expect(scrollers, "no nested scroll regions inside the sheet").toBeLessThanOrEqual(1);

      // 6. Searching still yields a reachable candidate, and the footer holds.
      await search.fill("sonar");
      const firstResult = dialog.getByTestId("model-option").first();
      await expect(firstResult).toBeVisible();
      await expectTappableInVisibleViewport(page, firstResult, "first search result");
      await expectInsideVisibleViewport(page, done, "done control after searching");
      await expectNoHorizontalOverflow(page);

      // 7. Pointer completion: tapping the candidate's centre selects it.
      await firstResult.click();
      await expect(dialog.getByTestId("selected-model-chip").first()).toBeVisible();

      // 8. Keyboard completion: Done is focusable and activates from the
      //    keyboard, so the flow ends without a pointer at all.
      await done.focus();
      await expect(done).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(dialog).toBeHidden();

      await closeOnScreenKeyboard(page);
    });
  }
});

test("the picker footer clears the safe area with no keyboard", { tag: "@ui-risk" }, async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareGuestPage(page, "en");
  await page.goto("/chat");
  await modelMenuTrigger(page).click();

  const dialog = page.locator("#chat-input-popover");
  const done = dialog.getByTestId("model-picker-done");
  await expect(done).toBeVisible();

  // No keyboard means no compensation: the sheet must keep its plain CSS
  // positioning rather than acquiring a stale inline offset.
  await expect(dialog).not.toHaveAttribute("data-keyboard-inset", /.+/);
  await expectInsideVisibleViewport(page, dialog.getByTestId("model-selection-summary"), "footer");
  await expectNoHorizontalOverflow(page);
});

// ---------------------------------------------------------------------------
// UI-P2-02: the phone's first screen.
//
// "All models" and the advanced filters used to sit at the bottom of the
// scrolling recommendation list. At 390x844 that put the All-models row 182px
// below the fold (measured: it started at y=948 inside a region that ended at
// y=766), so the only way to discover the other 30+ models -- or that advanced
// filters existed at all -- was to scroll past every recommendation. Both
// entry points are now pinned between the list and the Done footer: the
// reading order is still recommendations-first and the filters are still
// collapsed until asked for, but neither entry point costs a scroll.
// ---------------------------------------------------------------------------
// 390x844 is the contract viewport for "candidates plus both entry points on
// one screen". 320x568 has 276px less height to spend and fits one candidate
// alongside the same chrome; what it must still deliver is both entry points
// without a scroll, which is the part that was actually broken.
const FIRST_SCREEN_VIEWPORTS = [
  { name: "390x844", width: 390, height: 844, minCandidates: 2 },
  { name: "320x568", width: 320, height: 568, minCandidates: 1 },
] as const;

for (const viewport of FIRST_SCREEN_VIEWPORTS) {
  for (const lang of ["en", "ko"] as const) {
    test(`model picker's first screen needs no scrolling at ${viewport.name} (${lang})`, async ({
      page,
    }, testInfo) => {
      test.skip(
        !testInfo.project.name.startsWith("mobile"),
        "The compact sheet layout only renders on touch (mobile-*) projects."
      );

      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await prepareGuestPage(page, lang);
      await page.goto(`/chat?lang=${lang}`);

      await modelMenuTrigger(page).click();
      const dialog = page.locator("#chat-input-popover");
      await expect(dialog).toBeVisible();

      const scrollRegion = dialog.getByTestId("model-picker-scroll-region");
      await expect(scrollRegion).toBeVisible();

      // Nothing below is allowed to depend on a scroll having happened.
      expect(
        await scrollRegion.evaluate((element) => element.scrollTop),
        "the picker opens at the top of its list"
      ).toBe(0);

      for (const [label, locator] of [
        ["search", dialog.getByTestId("model-search-input")],
        ["selected model", dialog.getByTestId("selected-model-chip").first()],
        ["all-models entry", dialog.getByTestId("model-picker-open-all")],
        ["advanced-filters entry", dialog.getByTestId("model-picker-open-filters")],
        ["done control", dialog.getByTestId("model-picker-done")],
      ] as const) {
        await expect(locator, `${label} visible`).toBeVisible();
        await expectWithinViewport(page, locator, `${label} at ${viewport.name}`);
      }

      // "Visible" for a candidate means fully inside the list's own clipping
      // box, not merely attached: a card cut off by the scroll region's bottom
      // edge is not something the user can read without scrolling.
      const fullyVisibleCandidates = await page.evaluate(() => {
        const region = document.querySelector(
          '[data-testid="model-picker-scroll-region"]'
        )!;
        const bounds = region.getBoundingClientRect();
        return Array.from(
          document.querySelectorAll('[data-testid="recommended-model-option"]')
        ).filter((card) => {
          const rect = card.getBoundingClientRect();
          return rect.top >= bounds.top - 0.5 && rect.bottom <= bounds.bottom + 0.5;
        }).length;
      });
      expect(
        fullyVisibleCandidates,
        "recommended candidates readable without scrolling"
      ).toBeGreaterThanOrEqual(viewport.minCandidates);

      // The filters entry opens the same collapsed sheet the catalogue offers,
      // in one tap instead of two.
      await dialog.getByTestId("model-picker-open-filters").click();
      const sheet = dialog.getByTestId("model-filter-sheet");
      await expect(sheet).toBeVisible();
      await expectWithinViewport(page, sheet, `filter sheet at ${viewport.name}`);
      await sheet.getByTestId("model-filter-apply").click();
      await expect(sheet).toHaveCount(0);
      await expect(dialog.getByTestId("model-option").first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  }
}
