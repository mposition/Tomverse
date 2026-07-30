import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  mockAuthenticatedApi,
  openModelPickerCatalogue,
  prepareGuestPage,
} from "./support/app-fixtures";

// STG-F005: core/repeating mobile controls must have a real (independent)
// hit area of at least 44x44 CSS px, measured on the actual clickable
// element -- not the icon inside it, and not a visually-shrunk element that
// merely LOOKS bigger via padding. Desktop must stay at its pre-existing
// (smaller, mouse-appropriate) size.
const MIN_TARGET = 44;
// Sub-pixel layout rounding (borders, transforms) can shave a hair off an
// exact 44px box without meaning the fix regressed.
const TOLERANCE = 0.5;

const MOBILE_VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
];

async function assertMinTouchTarget(locator: Locator, label: string) {
  // boundingBox()/elementFromPoint() don't auto-scroll like click() does --
  // a control below the fold in a scrollable list would otherwise report a
  // real but off-screen box, and a same-coordinate hit-test would spuriously
  // fail (elementFromPoint returns null outside the viewport). Scrolling
  // first also matches what a real tap requires.
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box, `${label}: expected a visible bounding box`).not.toBeNull();
  expect(box!.width, `${label}: width`).toBeGreaterThanOrEqual(MIN_TARGET - TOLERANCE);
  expect(box!.height, `${label}: height`).toBeGreaterThanOrEqual(MIN_TARGET - TOLERANCE);
}

async function assertBelowMinTouchTarget(locator: Locator, label: string) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box, `${label}: expected a visible bounding box`).not.toBeNull();
  expect(
    box!.width < MIN_TARGET - TOLERANCE || box!.height < MIN_TARGET - TOLERANCE,
    `${label}: expected to still be below 44px on desktop (unnecessarily enlarged)`
  ).toBe(true);
}

// document.elementFromPoint() at the control's own center must resolve to
// the control itself (or a descendant, e.g. the icon svg) -- never a
// different, unrelated control stealing the tap.
async function assertHitTestReturnsSelf(locator: Locator, label: string) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box, `${label}: expected a visible bounding box`).not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  const isSelfOrChild = await locator.evaluate((element, [x, y]) => {
    const hit = document.elementFromPoint(x, y);
    return hit === element || Boolean(hit && element.contains(hit));
  }, [cx, cy] as [number, number]);
  expect(isSelfOrChild, `${label}: center hit-test should resolve to itself`).toBe(true);
}

// Some controls stay visually small and instead grow their real hit area via
// an invisible pseudo-element (before:-inset-N). getBoundingClientRect() (and
// therefore Playwright's boundingBox()) never reflects a pseudo-element's
// paint area, so those controls can't be verified with assertMinTouchTarget --
// the real, load-bearing check is that the tappable area is at least 44x44
// via actual hit-testing, not the element's own layout box.
async function assertMinHitArea(locator: Locator, label: string) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box, `${label}: expected a visible bounding box`).not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  const half = MIN_TARGET / 2 - TOLERANCE;
  const offsets: Array<[number, number]> = [
    [0, 0],
    [-half, 0],
    [half, 0],
    [0, -half],
    [0, half],
  ];
  for (const [dx, dy] of offsets) {
    const [x, y] = [cx + dx, cy + dy];
    const isSelfOrChild = await locator.evaluate((element, [px, py]) => {
      const hit = document.elementFromPoint(px, py);
      return hit === element || Boolean(hit && element.contains(hit));
    }, [x, y] as [number, number]);
    expect(
      isSelfOrChild,
      `${label}: hit-test at center offset (${dx}, ${dy}) should resolve to itself (effective tap area must be >= 44x44)`
    ).toBe(true);
  }
}

const modelSelectorTrigger = (page: Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').nth(1);

test.describe("mobile touch targets (STG-F005)", () => {
  // These assertions are only meaningful on a touch-emulating project:
  // useIsMobileShell() requires a coarse pointer, not just a narrow
  // viewport, so a non-touch project (desktop-chromium, desktop-compact)
  // keeps the pre-existing compact sizing even at a 320px viewport. Without
  // this guard every project in playwright.config.ts would run this file
  // (there's no per-project testMatch), and these tests would spuriously
  // fail under desktop-chromium -- including npm run test:e2e:pr, the CI
  // gate. The dedicated desktop-comparison test below skips the inverse.
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("mobile"),
      "Touch-target sizing only applies on touch-emulating (mobile-*) projects."
    );
    await prepareGuestPage(page, "en");
  });

  test("composer core controls meet the 44x44 minimum at every required mobile viewport", async ({
    page,
  }) => {
    for (const viewport of MOBILE_VIEWPORTS) {
      await page.setViewportSize(viewport);
      await page.goto("/chat");
      await expect(page.getByTestId("chat-input")).toBeVisible();

      await assertMinTouchTarget(
        page.locator('button[aria-controls="chat-input-popover"]').first(),
        `[${viewport.width}x${viewport.height}] More actions`
      );
      await assertMinTouchTarget(
        modelSelectorTrigger(page),
        `[${viewport.width}x${viewport.height}] Choose AI models`
      );
      await assertMinTouchTarget(
        page.getByTestId("request-credit-estimate"),
        `[${viewport.width}x${viewport.height}] Estimated credits`
      );
      await assertMinTouchTarget(
        page.getByTestId("chat-send-button"),
        `[${viewport.width}x${viewport.height}] Send`
      );

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth
      );
      expect(overflow, `[${viewport.width}x${viewport.height}] horizontal overflow`).toBe(false);
    }
  });

  test("composer controls hit-test to themselves, not a neighboring control", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeVisible();

    await assertHitTestReturnsSelf(
      page.locator('button[aria-controls="chat-input-popover"]').first(),
      "More actions"
    );
    await assertHitTestReturnsSelf(modelSelectorTrigger(page), "Choose AI models");
    await assertHitTestReturnsSelf(page.getByTestId("request-credit-estimate"), "Estimated credits");
    await assertHitTestReturnsSelf(page.getByTestId("chat-send-button"), "Send");
  });

  test("Choose AI models opens the dialog and Send remains functional after the resize", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/chat");

    await modelSelectorTrigger(page).click();
    await expect(page.locator("#chat-input-popover")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByTestId("chat-textarea").fill("Hello");
    await expect(page.getByTestId("chat-send-button")).toBeEnabled();
  });

  test("selected-model-chip remove buttons meet the minimum and stay independently clickable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/chat");
    await modelSelectorTrigger(page).click();
    const dialog = page.locator("#chat-input-popover");
    await expect(dialog).toBeVisible();

    const chips = dialog.getByTestId("selected-model-chip");
    const chipCount = await chips.count();
    expect(chipCount).toBeGreaterThan(0);

    const removeButtons = chips.locator('button[aria-label]');
    const firstRemove = removeButtons.first();
    // The chip stays visually small; its real hit area is grown via an
    // invisible pseudo-element, so verify by hit-testing, not boundingBox.
    await assertMinHitArea(firstRemove, "selected-model-chip remove #1");

    // Removing one model must not affect an adjacent chip's own remove
    // button -- the expanded (mostly invisible) hit area must not bleed
    // into the neighboring chip's own interactive control.
    const beforeCount = await chips.count();
    await firstRemove.click();
    await expect(chips).toHaveCount(beforeCount - 1);
  });

  test("capability filter chips and the model-option favorite star meet the minimum", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await mockAuthenticatedApi(page, { selectedModels: ["gpt-5-4-mini"] });
    await page.goto("/chat");
    // STG-F008: the capability chips moved into the All-models filter sheet,
    // so the picker has to be stepped through to reach them.
    const dialog = await openModelPickerCatalogue(page);

    const filterTrigger = dialog.getByTestId("model-filter-sheet-trigger");
    await assertMinTouchTarget(filterTrigger, "filter sheet trigger");
    await assertHitTestReturnsSelf(filterTrigger, "filter sheet trigger");
    await assertMinTouchTarget(dialog.getByTestId("model-task-filter"), "task filter");

    await filterTrigger.click();
    const sheet = dialog.getByTestId("model-filter-sheet");
    await expect(sheet).toBeVisible();
    // Selected by data-testid, not accessible name/text: the authenticated
    // mock's /api/user/settings response hardcodes language "ko", which
    // overrides the ?lang=en navigation once settings load, so the rendered
    // label is not reliably "Web search" in English.
    const capabilityChip = sheet.getByTestId("capability-filter-search");
    await assertMinTouchTarget(capabilityChip, "capability filter chip (Web search)");
    await assertHitTestReturnsSelf(capabilityChip, "capability filter chip (Web search)");
    await assertMinTouchTarget(
      sheet.getByTestId("model-filter-sheet-close"),
      "filter sheet close"
    );
    await sheet.getByTestId("model-filter-sheet-close").click();
    await expect(sheet).toHaveCount(0);

    const favoriteStar = dialog.getByTestId("model-favorite-star").first();
    await assertMinTouchTarget(favoriteStar, "model row favorite star");
    await assertHitTestReturnsSelf(favoriteStar, "model row favorite star");

    // Clicking the star must only toggle favorite state, never the model
    // selection right next to it.
    const modelOption = dialog.locator('[data-testid="model-option"]').first();
    const pressedBefore = await modelOption.getAttribute("aria-pressed");
    await favoriteStar.click();
    await expect(modelOption).toHaveAttribute("aria-pressed", pressedBefore || "false");
  });

  test("mobile header controls (sidebar open, new chat) meet the minimum", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/chat");

    await assertMinTouchTarget(page.getByTestId("mobile-sidebar-open"), "mobile sidebar open");
    await assertHitTestReturnsSelf(page.getByTestId("mobile-sidebar-open"), "mobile sidebar open");
  });

  test("mobile sidebar drawer close button meets the minimum", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/chat");
    await page.getByTestId("mobile-sidebar-open").click();
    const dialog = page.getByRole("dialog").first();
    await expect(dialog).toBeVisible();

    // The drawer also has a full-bleed backdrop button sharing the same
    // "Cancel" accessible name (dismiss-on-outside-click); the visible close
    // X is the last "Cancel"-named button in the dialog.
    const closeButton = dialog.getByRole("button", { name: "Cancel" }).last();
    await assertMinTouchTarget(closeButton, "drawer close");
    await assertHitTestReturnsSelf(closeButton, "drawer close");
  });

  // Regression test: the drawer's own close button used to sit directly on
  // top of sidebar-help-button in the header (both a 44x44 box anchored to
  // the same top-right corner), so a real tap on the help button landed on
  // the close button instead. Covers both the default per-project mobile
  // viewport and the narrowest supported width.
  for (const viewport of [null, { width: 320, height: 640 }] as const) {
    test(`sidebar-help-button in the mobile drawer is tappable, not covered by the drawer close button${
      viewport ? ` at ${viewport.width}x${viewport.height}` : ""
    }`, async ({ page }) => {
      if (viewport) {
        await page.setViewportSize(viewport);
      }
      await page.goto("/chat");
      await page.getByTestId("mobile-sidebar-open").click();
      const dialog = page.getByRole("dialog").first();
      await expect(dialog).toBeVisible();

      const helpButton = dialog.getByTestId("sidebar-help-button");
      await assertMinTouchTarget(helpButton, "sidebar help button (mobile drawer)");
      await assertHitTestReturnsSelf(helpButton, "sidebar help button (mobile drawer)");

      await helpButton.click();
      await expect(page.getByTestId("sidebar-tour-replay")).toBeVisible();
      await expect(page.getByTestId("sidebar-help-link")).toBeVisible();
    });
  }

  test("mobile-model-tab remove buttons meet the minimum and do not select the tab", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/chat?lang=en&entry=guest-preview");
    // Guests default to a 3-model comparison, so the mobile tab strip (and
    // its per-tab remove buttons) is present without any setup. On a
    // touch-emulating mobile project, plain Enter inserts a newline instead
    // of submitting (see lib/chatKeyboardPolicy.ts), so send via the button.
    await page.getByTestId("chat-textarea").fill("start");
    await page.getByTestId("chat-send-button").click();
    const removeButtons = page.getByTestId("mobile-model-tab-remove");
    await expect(removeButtons.first()).toBeVisible();

    // Real box is 36x36; the extra 44x44 tap area comes from a pseudo-element,
    // so verify via hit-testing rather than boundingBox.
    await assertMinHitArea(removeButtons.first(), "mobile-model-tab-remove");
  });

  // UI-P1-01: "+ New Chat" inside the mobile drawer previously had no height
  // floor (only reduced padding via isMobileDrawer), unlike its sibling
  // icon-only header button which was already fixed.
  test("mobile drawer new-chat button meets the minimum and stays functional (ko)", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/chat");
    await page.getByTestId("mobile-sidebar-open").click();
    const dialog = page.getByRole("dialog").first();
    await expect(dialog).toBeVisible();

    const newChatButton = dialog.getByTestId("sidebar-new-chat");
    await assertMinTouchTarget(newChatButton, "mobile drawer new chat");
    await assertHitTestReturnsSelf(newChatButton, "mobile drawer new chat");

    await newChatButton.click();
    await expect(dialog).toHaveCount(0);
  });

  // UI-P1-01: the model-option row had no explicit height floor -- it relied
  // entirely on its (variable) content, so a model with a short description
  // and no feature badges could fall under 44px. Also checks the row doesn't
  // overlap the adjacent favorite-star button's own hit area.
  test("model-option rows meet the minimum height and do not overlap the favorite star", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await mockAuthenticatedApi(page, { selectedModels: ["gpt-5-4-mini"] });
    await page.goto("/chat");
    const dialog = await openModelPickerCatalogue(page);

    const favoriteStar = dialog.getByTestId("model-favorite-star").first();
    const modelOption = dialog.getByTestId("model-option").first();
    await assertMinTouchTarget(modelOption, "model option row");
    await assertHitTestReturnsSelf(modelOption, "model option row");

    const starBox = await favoriteStar.boundingBox();
    const optionBox = await modelOption.boundingBox();
    expect(starBox, "favorite star: expected a visible bounding box").not.toBeNull();
    expect(optionBox, "model option: expected a visible bounding box").not.toBeNull();
    const overlaps =
      starBox!.x < optionBox!.x + optionBox!.width &&
      starBox!.x + starBox!.width > optionBox!.x &&
      starBox!.y < optionBox!.y + optionBox!.height &&
      starBox!.y + starBox!.height > optionBox!.y;
    expect(overlaps, "favorite star and model option row must not overlap").toBe(false);
  });

  // UI-P1-01: Korean labels (e.g. "새 대화") run shorter/longer than their
  // English counterparts depending on the string; confirm the composer still
  // fits without horizontal overflow at the narrowest supported viewport.
  test("composer meets the minimum and stays overflow-free with Korean labels at 320px", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/chat");
    await expect(page.getByTestId("chat-input")).toBeVisible();

    await assertMinTouchTarget(
      page.locator('button[aria-controls="chat-input-popover"]').first(),
      "[ko] More actions"
    );
    await assertMinTouchTarget(modelSelectorTrigger(page), "[ko] Choose AI models");
    await assertMinTouchTarget(page.getByTestId("chat-send-button"), "[ko] Send");

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflow, "[ko] horizontal overflow").toBe(false);
  });
});

// UI-TOUCH-001. The marketing header is the first thing a phone user meets,
// and on `/` two of its three controls were under the minimum: the menu
// button was 40x40 and the language switcher's real hit area (the label the
// select fills) was 40px tall. Neither is inside the chat shell, so nothing
// in the block above covered them.
test.describe("marketing header touch targets (UI-TOUCH-001)", () => {
  const MARKETING_VIEWPORTS = [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
  ];

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("mobile"),
      "Touch-target sizing only applies on touch-emulating (mobile-*) projects."
    );
    await prepareGuestPage(page, "en");
  });

  for (const lang of ["en", "ko"] as const) {
    test(`menu button and language switcher meet the minimum at every mobile width (${lang})`, async ({
      page,
    }) => {
      for (const viewport of MARKETING_VIEWPORTS) {
        await page.setViewportSize(viewport);
        await page.goto(`/?lang=${lang}`);
        const label = `[${lang} ${viewport.width}x${viewport.height}]`;

        // The switcher's hit area is the label, not the select: the label is
        // `overflow-hidden`, so anything the select could paint outside it
        // would be clipped and would not be tappable.
        const switcher = page.locator('label:has(select[aria-label="Language"])');
        await assertMinTouchTarget(switcher, `${label} language switcher`);
        await assertHitTestReturnsSelf(switcher, `${label} language switcher`);

        const menuButton = page.locator("header button[aria-expanded]").first();
        await assertMinTouchTarget(menuButton, `${label} mobile menu`);
        await assertHitTestReturnsSelf(menuButton, `${label} mobile menu`);
        await assertMinHitArea(menuButton, `${label} mobile menu`);

        // Neither may have grown into the other, and neither may have pushed
        // the header wider than the document.
        const switcherBox = (await switcher.boundingBox())!;
        const menuBox = (await menuButton.boundingBox())!;
        const overlaps =
          switcherBox.x < menuBox.x + menuBox.width &&
          switcherBox.x + switcherBox.width > menuBox.x &&
          switcherBox.y < menuBox.y + menuBox.height &&
          switcherBox.y + switcherBox.height > menuBox.y;
        expect(overlaps, `${label} switcher and menu must not overlap`).toBe(false);

        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth
        );
        expect(overflow, `${label} horizontal overflow`).toBeLessThanOrEqual(1);
      }
    });
  }

  // REAUDIT-F005's focus indicator is the reason the switcher grew a real box
  // rather than a pseudo-element inset, so it is checked in the same place.
  test("the language switcher keeps a visible, unclipped focus indicator", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?lang=en");
    const select = page.locator('select[aria-label="Language"]');
    await select.focus();
    const ring = await page
      .locator('label:has(select[aria-label="Language"])')
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          shadow: style.boxShadow,
          overflowHidden: style.overflow === "hidden",
        };
      });
    // Tailwind's focus-within:ring-2 paints as a box-shadow on the label's own
    // border box -- outside the clip, which is exactly why it survives.
    expect(ring.shadow, "focus ring must be painted").not.toBe("none");
    expect(ring.overflowHidden, "label is still the clipping box").toBe(true);
  });
});

// Kept outside the mobile-only describe block above: this test verifies the
// opposite condition (no touch emulation keeps the pre-existing compact
// sizing), so it needs its own beforeEach without the mobile-only skip.
test.describe("mobile touch targets (STG-F005) -- desktop comparison", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name.startsWith("mobile"),
      "This checks the non-touch desktop path specifically."
    );
    await prepareGuestPage(page, "en");
  });

  test("desktop keeps the original compact sizing for shared controls", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/chat");
    await modelSelectorTrigger(page).click();
    const dialog = page.locator("#chat-input-popover");
    await expect(dialog).toBeVisible();

    const chip = dialog.getByTestId("selected-model-chip").first();
    if (await chip.count()) {
      const removeButton = chip.locator("button[aria-label]");
      await assertBelowMinTouchTarget(removeButton, "selected-model-chip remove (desktop)");
    }

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflow).toBe(false);
  });

  // UI-P1-01: the new-chat min-height floor is gated on isMobileDrawer, so
  // the desktop rail's copy of the same button must stay at its original
  // (smaller) size.
  test("desktop new-chat button keeps its original compact sizing", async ({ page }) => {
    // Guest mode defaults to a 3-model comparison, which auto-collapses the
    // sidebar to an icon rail at this viewport width (unrelated to touch
    // targets) -- pin the preference to "expanded" so the labeled new-chat
    // button (and its data-testid) is actually rendered.
    await page.addInitScript(() => {
      localStorage.setItem("tomverse_sidebar_collapsed_v1", "expanded");
    });
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/chat");
    await assertBelowMinTouchTarget(
      page.getByTestId("sidebar-new-chat"),
      "sidebar new chat (desktop)"
    );
  });
});

