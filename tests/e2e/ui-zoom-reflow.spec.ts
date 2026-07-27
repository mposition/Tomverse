import { expect, test, type Locator, type Page } from "@playwright/test";
import { modelMenuTrigger, prepareGuestPage } from "./support/app-fixtures";

// ---------------------------------------------------------------------------
// UI-P2-03: real browser zoom (125% / 150% / 200%) on the two surfaces this
// round changed -- the sign-in analytics consent notice and the phone model
// picker. Browser zoom does not change CSS pixel *sizes*; it changes how many
// CSS pixels the viewport holds. So a 1440x900 window at 150% zoom lays out
// exactly like a 960x600 CSS viewport, which is what each case below sets.
// (Playwright has no zoom control, and page-scale/`transform: scale()` tricks
// would test pinch-zoom -- which reflows nothing -- instead.)
//
// What is checked at every level: the page never grows a horizontal scrollbar,
// nothing spills out of the notice, every control still hit-tests to itself
// (i.e. is not clipped away or covered by an overlapping neighbour), and touch
// targets keep their 44x44 CSS pixels.
// ---------------------------------------------------------------------------

const ZOOM_LEVELS = [1.25, 1.5, 2] as const;

const zoomed = (
  base: { width: number; height: number },
  zoom: number
) => ({
  width: Math.round(base.width / zoom),
  height: Math.round(base.height / zoom),
});

const enableAnalyticsCookie = (page: Page) =>
  page.context().addCookies([
    {
      name: "__tomverse_e2e_analytics",
      value: "1",
      url: "http://127.0.0.1:3100",
    },
  ]);

const expectNoPageOverflow = async (page: Page, label: string) => {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content, `${label}: no horizontal page overflow`).toBeLessThanOrEqual(
    dimensions.viewport + 1
  );
};

const expectHitsItself = async (locator: Locator, label: string) => {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator, `${label} visible`).toBeVisible();
  const hitsItself = await locator.evaluate((element) => {
    const rect = element.getClientRects()[0] || element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2
    );
    return hit !== null && element.contains(hit);
  });
  expect(hitsItself, `${label}: centre hit-tests to itself (not clipped or covered)`).toBe(
    true
  );
};

const expectContained = async (notice: Locator, label: string) => {
  const overflow = await notice.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const left = rect.left + Number.parseFloat(style.paddingLeft || "0");
    const right = rect.right - Number.parseFloat(style.paddingRight || "0");
    let worst = 0;
    for (const child of Array.from(element.querySelectorAll("*"))) {
      const childRect = child.getBoundingClientRect();
      if (childRect.width === 0 && childRect.height === 0) continue;
      worst = Math.max(worst, childRect.right - right, left - childRect.left);
    }
    return Number(worst.toFixed(2));
  });
  expect(overflow, `${label}: notice contents stay inside the card`).toBeLessThanOrEqual(
    0.5
  );
};

for (const zoom of ZOOM_LEVELS) {
  for (const base of [
    { name: "1440x900", width: 1440, height: 900 },
    { name: "390x844", width: 390, height: 844 },
  ] as const) {
    for (const lang of ["en", "ko"] as const) {
      test(`UI-P2-03: sign-in consent notice reflows at ${zoom * 100}% zoom (${base.name}, ${lang})`, async ({
        page,
      }, testInfo) => {
        test.skip(
          testInfo.project.name !== "desktop-chromium",
          "Zoom is emulated by an explicit CSS viewport, so one engine covers it."
        );

        await enableAnalyticsCookie(page);
        await prepareGuestPage(page, lang);
        // The region with the longest action labels, so the tightest case.
        await page.setExtraHTTPHeaders({ "cf-ipcountry": "AU" });
        await page.setViewportSize(zoomed(base, zoom));
        await page.goto(`/auth/signin?lang=${lang}`);

        const notice = page.getByTestId("chat-consent-notice");
        await expect(notice).toBeVisible();
        await notice.scrollIntoViewIfNeeded();

        const label = `${base.name} @${zoom * 100}% ${lang}`;
        await expectNoPageOverflow(page, label);
        await expectContained(notice, label);

        for (const testId of [
          "analytics-consent-decline",
          "analytics-consent-accept",
        ] as const) {
          const control = notice.getByTestId(testId);
          await expectHitsItself(control, `${label} ${testId}`);
          const box = await control.boundingBox();
          expect(box, `${label} ${testId} box`).not.toBeNull();
          if (!box) continue;
          expect(box.width, `${label} ${testId} width`).toBeGreaterThanOrEqual(44);
          expect(box.height, `${label} ${testId} height`).toBeGreaterThanOrEqual(44);
        }

        // The card's own controls must stay usable next to the notice at every
        // zoom level -- this is where a fixed-size notice would start covering
        // the login form.
        await expectHitsItself(
          page.getByPlaceholder("you@example.com"),
          `${label} email field`
        );
        await expectHitsItself(
          page.locator("button", { hasText: lang === "en" ? "Get login code" : "로그인 코드 받기" }),
          `${label} login-code button`
        );
      });
    }
  }

  test(`UI-P2-03: phone model picker reflows at ${zoom * 100}% zoom (390x844)`, async ({
    page,
  }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("mobile"),
      "The compact picker layout only renders on touch (mobile-*) projects."
    );

    await page.setViewportSize(zoomed({ width: 390, height: 844 }, zoom));
    await prepareGuestPage(page, "ko");
    await page.goto("/chat?lang=ko");

    await modelMenuTrigger(page).click();
    const dialog = page.locator("#chat-input-popover");
    await expect(dialog).toBeVisible();

    const label = `picker 390x844 @${zoom * 100}%`;
    await expectNoPageOverflow(page, label);

    for (const testId of [
      "model-search-input",
      "model-picker-open-all",
      "model-picker-open-filters",
      "model-picker-done",
    ] as const) {
      const control = dialog.getByTestId(testId);
      await expect(control, `${label} ${testId} visible`).toBeVisible();
      await expectHitsItself(control, `${label} ${testId}`);
      const box = await control.boundingBox();
      expect(box, `${label} ${testId} box`).not.toBeNull();
      if (!box) continue;
      expect(box.height, `${label} ${testId} height`).toBeGreaterThanOrEqual(44);
      const viewport = page.viewportSize()!;
      expect(box.x, `${label} ${testId} left edge`).toBeGreaterThanOrEqual(-1);
      expect(
        box.x + box.width,
        `${label} ${testId} right edge`
      ).toBeLessThanOrEqual(viewport.width + 1);
      expect(
        box.y + box.height,
        `${label} ${testId} bottom edge`
      ).toBeLessThanOrEqual(viewport.height + 1);
    }

    // Text that was raised off 9-10px must not be clipped by its own row once
    // zoom makes every glyph taller relative to the sheet.
    const clipped = await dialog.evaluate((element) => {
      const candidates = Array.from(
        element.querySelectorAll<HTMLElement>(
          '[data-testid="recommended-model-option"] span, [data-testid="selected-model-chip"]'
        )
      );
      return candidates.filter(
        (node) =>
          node.scrollHeight - node.clientHeight > 1 &&
          getComputedStyle(node).overflow !== "visible" &&
          !node.className.includes("truncate")
      ).length;
    });
    expect(clipped, `${label}: no vertically clipped text`).toBe(0);
  });
}
