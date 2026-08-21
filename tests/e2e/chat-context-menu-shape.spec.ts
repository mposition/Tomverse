import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi } from "./support/app-fixtures";

/**
 * The composer's "+" menu is a list of things to do now, not a catalogue.
 *
 * It had grown a disabled future feature, a bordered card explaining
 * attachment limits, a second way to reach the model picker, and two rows for
 * one action -- eleven entries in a surface whose usefulness is being able to
 * scan it. The result was a menu that scrolled on ordinary screens and was
 * clipped on short ones, and the fix people reach for is a scrollbar, which
 * hides the problem rather than removing it.
 *
 * So these tests pin the shape rather than the styling: how many actions there
 * are, that the four removals stay removed, and that on the viewports real
 * people use the menu does not need to scroll at all. The scroll fallback is
 * covered too -- it must exist for text scaling and tiny viewports, and must
 * not be what makes an ordinary session work.
 */

/**
 * Every row the root may show, in the order it must show them: what goes into
 * the message, then who answers it, then the two longer-running tasks.
 */
const CANONICAL_ORDER = [
  "tools-attach-row",
  "tools-web-search-row",
  "tools-assistant-row",
  "tools-memory-row",
  "tools-deep-research-row",
  "tools-image-generation-row",
];

const toolsMenuTrigger = (page: Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').nth(0);

const openMenu = async (page: Page) => {
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await toolsMenuTrigger(page).click();
  await expect(page.locator("#chat-input-popover")).toBeVisible();
};

/** Every row the root view offers, in DOM order. */
const rootActionTestIds = async (page: Page) =>
  page.locator("#chat-input-popover [data-testid^='tools-']").evaluateAll(
    (nodes) =>
      nodes
        .map((node) => node.getAttribute("data-testid") ?? "")
        // Nested markers (the superseded dot) are not actions.
        .filter((id) => id.endsWith("-row"))
  );

test.describe("chat context menu shape", () => {
  test("the root offers at most six actions @ui-risk", async ({ page }) => {
    await mockAuthenticatedApi(page, { assistantProfiles: [] });
    await page.goto("/chat?lang=en");
    await openMenu(page);

    const ids = await rootActionTestIds(page);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(6);

    // Which rows appear depends on flags, plan and guest state, and always
    // has -- so the assertion is that nothing outside the allowed set gets in
    // and that whatever does appear keeps the order. Pinning an exact list
    // would make this test a statement about the fixture instead.
    expect(ids).toEqual(CANONICAL_ORDER.filter((id) => ids.includes(id)));
    for (const id of ids) expect(CANONICAL_ORDER).toContain(id);
  });

  test("the four removals stay removed @ui-risk", async ({ page }) => {
    await mockAuthenticatedApi(page, { assistantProfiles: [] });
    await page.goto("/chat?lang=en");
    await openMenu(page);

    // A card of prose, not an action.
    await expect(page.getByTestId("attach-limits")).toHaveCount(0);
    // A feature nobody can use.
    await expect(page.getByTestId("tools-read-webpage-row")).toHaveCount(0);
    // A second door to the model picker, which has its own button.
    await expect(
      page.locator("#chat-input-popover").getByText("AI model", { exact: false })
    ).toHaveCount(0);
    // A source, not a destination.
    await expect(page.getByTestId("attach-google-drive-row")).toHaveCount(0);
  });

  test("the model picker keeps its own accessible button", async ({ page }) => {
    // Removing the menu row must not remove the capability. The dedicated
    // button is the one that has to stay reachable and named.
    await mockAuthenticatedApi(page);
    await page.goto("/chat?lang=en");
    await expect(page.getByTestId("chat-input")).toBeVisible();

    const button = page.getByTestId("composer-model-select");
    await expect(button).toBeVisible();
    await expect(button).toHaveAccessibleName(/model/i);
    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#chat-input-popover")).toBeVisible();
  });

  test("attaching asks where from, with the limits beside it", async ({
    page,
  }) => {
    await mockAuthenticatedApi(page);
    await page.goto("/chat?lang=en");
    await openMenu(page);

    await page.getByTestId("tools-attach-row").click();

    await expect(page.getByTestId("attach-local-file-row")).toBeVisible();
    await expect(page.getByTestId("attach-google-drive-row")).toBeVisible();
    // The limits moved with the control they describe rather than being
    // deleted: they are supporting text here instead of a card in the root.
    await expect(page.getByTestId("attach-limits")).toBeVisible();
  });

  test("choosing an assistant opens its own view, which is the one that scrolls", async ({
    page,
  }) => {
    // Twelve assistants: a collection whose size the account decides. This
    // view is allowed to scroll for exactly that reason, and the root is not.
    await mockAuthenticatedApi(page, {
      assistantProfiles: Array.from({ length: 12 }, (_, index) => ({
        id: `p-${index}`,
        name: `Assistant ${index}`,
        description: `Number ${index}`,
        published: true,
        currentRevision: 1,
      })),
    });
    await page.goto("/chat?lang=en");
    await openMenu(page);
    await page.getByTestId("tools-assistant-row").click();

    const list = page.getByTestId("assistant-picker-list");
    await expect(list).toBeVisible();

    // The last assistant and both CTAs are reachable by scrolling this region,
    // not the page behind it.
    const create = page.getByTestId("assistant-create-cta");
    await create.scrollIntoViewIfNeeded();
    await expect(create).toBeVisible();
    await expect(page.getByTestId("assistant-manage-cta")).toBeVisible();
    await expect(page.getByTestId("assistant-option-p-11")).toHaveCount(1);
  });
});

/* ------------------------------------------------------- height policy -- */

const NO_SCROLL_VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 768, height: 760 },
  { width: 390, height: 844 },
  { width: 360, height: 640 },
  { width: 320, height: 568 },
  { width: 320, height: 480 },
];

for (const viewport of NO_SCROLL_VIEWPORTS) {
  test(`the root menu does not scroll at ${viewport.width}x${viewport.height} @ui-risk`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mockAuthenticatedApi(page, { assistantProfiles: [] });
    await page.goto("/chat?lang=en");
    await openMenu(page);

    const popover = page.locator("#chat-input-popover");
    const metrics = await popover.evaluate((node) => {
      const scroller =
        node.querySelector<HTMLElement>("[data-scroll-region]") ?? node;
      const rect = node.getBoundingClientRect();
      return {
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        top: rect.top,
        bottom: rect.bottom,
      };
    });

    // A scrollbar here would mean the menu is too long for the screen, which
    // is a content decision rather than a layout accident.
    expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 1);

    // And it is inside the visible viewport at both ends: clipping is the
    // other failure this shape is meant to remove.
    expect(metrics.top).toBeGreaterThanOrEqual(-1);
    expect(metrics.bottom).toBeLessThanOrEqual(
      (await page.evaluate(() => window.innerHeight)) + 1
    );
  });
}

test("a very short viewport still reaches the last action @ui-risk", async ({
  page,
}) => {
  // 568x320 cannot fit six rows at any reasonable size, and the honest answer
  // is a scroll rather than a clip: the guarantee is reachability, not the
  // absence of a scrollbar.
  await page.setViewportSize({ width: 568, height: 320 });
  await mockAuthenticatedApi(page, { assistantProfiles: [] });
  await page.goto("/chat?lang=en");
  await openMenu(page);

  // The last row this session actually renders, whichever it is: the point is
  // that the end of the list is reachable, not which feature sits there.
  const ids = await rootActionTestIds(page);
  const last = page.getByTestId(ids[ids.length - 1]);
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeVisible();

  // The page behind the menu must not have scrolled in its place.
  const bodyScroll = await page.evaluate(() => window.scrollY);
  expect(bodyScroll).toBe(0);
});
