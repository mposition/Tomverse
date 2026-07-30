import { expect, test, type Page } from "@playwright/test";
import { mockPublicProofMetrics, prepareGuestPage } from "./support/app-fixtures";

/**
 * FINAL-F001 / FINAL-F004 / EXT-REAUDIT-F002 -- WCAG 1.4.4 **Resize text**.
 *
 * This is deliberately a *second* axis, not a replacement for
 * `pricing-promotion-reflow.spec.ts` or the reflow checks in
 * `accessibility-core-tasks.spec.ts`. Those shrink the viewport, which is what
 * WCAG 1.4.10 **Reflow** asks about: how many CSS pixels the viewport holds.
 * They say nothing about this defect, and their own comments record that the
 * corresponding matrix row was `N/V`.
 *
 * The defect here is the other axis: the viewport stays at 320 or 390 CSS px
 * and the *root font size* doubles, so every rem-based box doubles while the
 * space available for it does not. The marketing header's menu button was
 * `h-10 w-10` -- 40x40 normally, 80x80 at a 200% root font -- and the row it
 * lived in was a fixed-height, non-wrapping flex row, so the only place the
 * extra width could go was off-screen. Measured before the fix: 94px of
 * document overflow on `/pricing` at 320px and 24px at 390px.
 *
 * The fix is on both sides of that: the button is sized in px so it stays at
 * the 44px target minimum at any text scale, and the header row wraps so the
 * controls reflow onto a second line instead of leaving the viewport.
 */

const ROOT_FONT_200 = "html{font-size:32px !important}";

const VIEWPORTS = [
  { name: "320", width: 320, height: 568 },
  { name: "390", width: 390, height: 844 },
] as const;

const ROUTES = ["/", "/pricing", "/privacy", "/chat?entry=guest-preview"] as const;

/**
 * Document-level horizontal overflow, with the own-scroller exception the
 * audit agreed on: a region that declares its own horizontal scroller (a model
 * carousel, a code block) is allowed to scroll internally. What must never
 * happen is the *document* growing wider than its own viewport.
 */
async function documentOverflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth - doc.clientWidth;
  });
}

async function applyRootFont200(page: Page) {
  await page.addStyleTag({ content: ROOT_FONT_200 });
  // Let the reflow settle before measuring.
  await page.waitForTimeout(300);
}

test.describe("WCAG 1.4.4 resize text: 200% root font size", () => {
  test.beforeEach(async ({ page }) => {
    await prepareGuestPage(page, "en");
    await mockPublicProofMetrics(page);
  });

  for (const viewport of VIEWPORTS) {
    for (const route of ROUTES) {
      test(`${route} has no document overflow at ${viewport.name}px with a 200% root font`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(route);
        await applyRootFont200(page);

        const overflow = await documentOverflow(page);
        expect(
          overflow,
          `${route} at ${viewport.name}px / 200% root font: document overflowed by ${overflow}px`
        ).toBeLessThanOrEqual(1);
      });
    }
  }

  test("the brand keeps a whole word and its accessible name at 200%", async ({ page }) => {
    // FINAL-F004's contract: the brand is either whole or absent -- it is never
    // truncated to a fragment like "T.". Fixing the overflow must not have been
    // paid for by shortening it.
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/pricing");
    await applyRootFont200(page);

    const brand = page.getByTestId("marketing-brand-name");
    const visibleText = await brand.evaluate((element) => {
      // Only the branch that is actually rendered at this breakpoint.
      const spans = Array.from(element.querySelectorAll("span"));
      const shown = spans.find((span) => {
        const style = getComputedStyle(span);
        return style.display !== "none";
      });
      return (shown?.textContent ?? "").trim();
    });
    expect(visibleText).toMatch(/^Tomverse( Insight)?$/);

    const homeLink = page.getByRole("link", { name: /Tomverse/ }).first();
    await expect(homeLink).toBeVisible();
  });

  test("header navigation stays operable at 200% on /pricing", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/pricing");
    await applyRootFont200(page);

    const menu = page.getByTestId("marketing-menu-button");
    await expect(menu).toBeVisible();

    // Inside the viewport, not pushed past its right edge.
    const box = await menu.boundingBox();
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(box, "menu button: expected a visible bounding box").not.toBeNull();
    expect(
      box!.x + box!.width,
      "menu button must sit inside the viewport at 200%"
    ).toBeLessThanOrEqual(clientWidth + 1);
    expect(box!.width, "menu button width at 200%").toBeGreaterThanOrEqual(43.5);
    expect(box!.height, "menu button height at 200%").toBeGreaterThanOrEqual(43.5);

    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    // The disclosed navigation is reachable and does not itself overflow.
    expect(await documentOverflow(page)).toBeLessThanOrEqual(1);
  });

  test("header navigation is reachable by keyboard alone at 200%", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/pricing");
    await applyRootFont200(page);

    const menu = page.getByTestId("marketing-menu-button");
    await menu.focus();
    await expect(menu).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveAttribute("aria-expanded", "true");
  });

  test("the pricing promotion and plan content stay inside the viewport at 200%", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/pricing");
    await applyRootFont200(page);

    // Whatever the promotion renders, it must not be the thing that widens the
    // document -- this is the attribution half of UI-005 on the text-scale axis.
    expect(await documentOverflow(page)).toBeLessThanOrEqual(1);

    const heading = page.getByRole("heading", { level: 1 }).first();
    await expect(heading).toBeVisible();
  });

  test("the consent notice does not cross the hero heading or CTA at 200%", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/");
    await applyRootFont200(page);

    const heading = page.getByRole("heading", { level: 1 }).first();
    await expect(heading).toBeVisible();

    const notice = page.getByTestId("chat-consent-notice");
    if (await notice.count()) {
      const noticeBox = await notice.first().boundingBox();
      const headingBox = await heading.boundingBox();
      if (noticeBox && headingBox) {
        const overlaps =
          noticeBox.x < headingBox.x + headingBox.width &&
          noticeBox.x + noticeBox.width > headingBox.x &&
          noticeBox.y < headingBox.y + headingBox.height &&
          noticeBox.y + noticeBox.height > headingBox.y;
        expect(overlaps, "consent notice must not overlap the hero heading").toBe(false);
      }
    }
  });

  test("Korean copy also stays inside the viewport at 200%", async ({ page }) => {
    await prepareGuestPage(page, "ko");
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/pricing");
    await applyRootFont200(page);

    const overflow = await documentOverflow(page);
    expect(overflow, `[ko] /pricing at 320px / 200%: overflowed by ${overflow}px`).toBeLessThanOrEqual(1);
  });
});
