import { expect, test, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  modelMenuTrigger,
  openModelCatalogue,
  prepareGuestPage,
} from "./support/app-fixtures";

// Selecting the maximum number of comparison models is a normal constraint,
// not a failure. It used to be announced by a full-width amber warning that
// repeated what the header already said and pushed the actual catalogue off a
// 320px screen -- leaving the user staring at a warning about models they
// could no longer see. The header's "3/3" is now the only visible status; the
// explanation stays reachable for assistive tech and the fourth pick still
// gets a concrete way forward.

const GUEST_MAX = 3;

const openPicker = async (page: Page) => {
  await modelMenuTrigger(page).click();
  const dialog = page.locator("#chat-input-popover");
  await expect(dialog).toBeVisible();
  return dialog;
};

test.beforeEach(async ({ page }) => {
  await prepareGuestPage(page, "en");
});

test("a full selection is a neutral status, never an amber warning", async ({
  page,
}) => {
  await page.goto("/chat?lang=en");
  const dialog = await openPicker(page);

  // The guest default is already the maximum comparison set.
  await expect(dialog.getByTestId("selected-model-chip")).toHaveCount(GUEST_MAX);

  const status = page.getByTestId("model-picker-max-reached");
  await expect(status).toHaveCount(1);
  // Present for assistive tech (role=status, sr-only), but it costs the
  // catalogue no vertical space and carries no warning styling.
  const box = await status.boundingBox();
  expect(box === null || box.height <= 1).toBe(true);

  // The header still carries the primary, neutral count.
  await expect(dialog.getByTestId("model-picker-selection-count")).toContainText(
    `${GUEST_MAX}/${GUEST_MAX}`
  );
});

test("a model that would need a swap says so before it is activated", async ({
  page,
}) => {
  await page.goto("/chat?lang=en");
  await openPicker(page);
  const dialog = await openModelCatalogue(page);

  const unselected = dialog
    .locator('[data-testid="model-option"][aria-pressed="false"]')
    .first();
  const describedBy = await unselected.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  await expect(page.locator(`#${describedBy}`)).toContainText(
    `You can compare up to ${GUEST_MAX} models`
  );
});

test("a fourth pick offers a swap instead of silently doing nothing", async ({
  page,
}) => {
  await page.goto("/chat?lang=en");
  await openPicker(page);
  const dialog = await openModelCatalogue(page);

  const unselected = dialog
    .locator('[data-testid="model-option"][aria-pressed="false"]')
    .first();
  await unselected.click();

  // The swap sheet is the resolution path: it names what is being replaced.
  const swapDialog = page.getByTestId("replace-model-dialog");
  await expect(swapDialog).toBeVisible();
  await expect(page.getByTestId("selected-model-chip").first()).toBeVisible();

  // This is a modal nested inside the model-picker dialog. It owns keyboard
  // focus and Escape; closing it must leave the picker and its draft intact.
  await expect(swapDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  for (let step = 0; step < 10; step += 1) {
    await page.keyboard.press("Tab");
    expect(
      await swapDialog.evaluate((node) => node.contains(document.activeElement))
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(swapDialog).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(unselected).toBeFocused();
});

test("removing one model reopens a slot and the estimate follows", async ({
  page,
}) => {
  await page.goto("/chat?lang=en");
  const dialog = await openPicker(page);

  const summary = dialog.getByTestId("model-selection-summary");
  const before = await summary.innerText();

  await dialog
    .getByTestId("selected-model-chip")
    .first()
    .getByRole("button", { name: "Remove from comparison" })
    .click();

  await expect(dialog.getByTestId("selected-model-chip")).toHaveCount(GUEST_MAX - 1);
  await expect(page.getByTestId("model-picker-max-reached")).toHaveCount(0);
  await expect(summary).not.toHaveText(before);
});

test.describe("catalogue space at the tightest viewports", () => {
  for (const { width, height, minVisibleRows } of [
    { width: 320, height: 568, minVisibleRows: 1 },
    { width: 390, height: 844, minVisibleRows: 2 },
  ]) {
    test(`${width}x${height} shows at least ${minVisibleRows} model row(s) in full`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await page.goto("/chat?lang=en");
      await openPicker(page);
      const dialog = await openModelCatalogue(page);

      // Count rows whose full box is inside the viewport and above the sticky
      // footer -- a row half-hidden behind the footer is not "shown".
      const footerBox = await dialog
        .getByTestId("model-selection-summary")
        .boundingBox();
      expect(footerBox).not.toBeNull();

      const rows = await dialog.getByTestId("model-option").all();
      let fullyVisible = 0;
      for (const row of rows) {
        const box = await row.boundingBox();
        if (!box) continue;
        if (box.y >= 0 && box.y + box.height <= footerBox!.y) fullyVisible += 1;
      }
      expect(fullyVisible).toBeGreaterThanOrEqual(minVisibleRows);
      await expectNoHorizontalOverflow(page);
    });
  }

  // The count above passes on a hairline. It did: at 320x568 the last visible
  // row cleared the footer by 15.8px, which is less than one line of text, so
  // the same build showed a full row on one Chromium and none on the canonical
  // one -- a rasteriser a few pixels wider re-wrapped a row and pushed it under
  // the footer. A margin narrower than a line of text is not headroom, so the
  // margin itself is asserted rather than left implied.
  const MIN_ROW_CLEARANCE = 24;

  test("the last visible row clears the sticky footer by more than a line of text", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/chat?lang=en");
    await openPicker(page);
    const dialog = await openModelCatalogue(page);

    const footerBox = await dialog
      .getByTestId("model-selection-summary")
      .boundingBox();
    expect(footerBox).not.toBeNull();

    let clearance = Number.NEGATIVE_INFINITY;
    for (const row of await dialog.getByTestId("model-option").all()) {
      const box = await row.boundingBox();
      if (!box || box.y < 0) continue;
      const gap = footerBox!.y - (box.y + box.height);
      if (gap >= 0) clearance = Math.max(clearance, gap);
    }

    expect(
      clearance,
      `the first fully visible row clears the footer by ${clearance}px`
    ).toBeGreaterThanOrEqual(MIN_ROW_CLEARANCE);
  });

  test("the models sheet spends one row on its title, not two", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/chat?lang=en");
    const dialog = await openPicker(page);

    // "Choose AI models" named the sheet while the picker's own header named
    // the screen inside it, so a 568px phone paid 65px for two stacked titles.
    // The dialog keeps the accessible name; only the duplicated visible row is
    // gone, and the close control it used to own moved into the header below.
    await expect(dialog).toHaveAttribute("aria-label", "Choose AI models");
    await expect(dialog.getByText("Choose AI models")).toHaveCount(0);
    await expect(dialog.getByTestId("model-picker-title")).toBeVisible();

    const close = dialog.getByTestId("model-picker-close");
    await expect(close).toBeVisible();
    const closeBox = await close.boundingBox();
    expect(closeBox!.width).toBeGreaterThanOrEqual(44);
    expect(closeBox!.height).toBeGreaterThanOrEqual(44);

    await close.click();
    await expect(page.locator("#chat-input-popover")).toHaveCount(0);
  });
});
