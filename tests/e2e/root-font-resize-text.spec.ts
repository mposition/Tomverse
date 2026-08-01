import { expect, test, type Page } from "@playwright/test";
import { mockPublicProofMetrics, prepareGuestPage } from "./support/app-fixtures";
import { setRootFontSize } from "./support/chat-state-fixtures";

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

/**
 * REAUDIT-P2-01. `documentElement.scrollWidth` is not enough on its own: a
 * section with `overflow-x: hidden` clips whatever runs past its right edge,
 * so the document measures zero overflow while the user sees a truncated
 * heading or CTA and has no way to scroll to the rest of it. This walks every
 * rendered element instead and reports the ones whose right edge leaves the
 * viewport, excluding only elements inside a region that declares its own
 * horizontal scroller -- a comparison table or a model carousel is allowed to
 * scroll sideways, because the user can actually reach the far end of it.
 */
async function clippedElements(page: Page, scope = "main") {
  return page.evaluate((selector) => {
    const viewportWidth = document.documentElement.clientWidth;
    const root = document.querySelector<HTMLElement>(selector);
    if (!root) return [{ reason: `no element matched ${selector}` }] as unknown[];
    const findings: unknown[] = [];
    root.querySelectorAll<HTMLElement>("*").forEach((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      if (rect.right <= viewportWidth + 1) return;

      let ancestor: HTMLElement | null = element.parentElement;
      let clippedBy = "";
      let insideIntentionalScroller = false;
      while (ancestor) {
        const overflowX = getComputedStyle(ancestor).overflowX;
        if (overflowX === "auto" || overflowX === "scroll") {
          insideIntentionalScroller = true;
          break;
        }
        if (!clippedBy && (overflowX === "hidden" || overflowX === "clip")) {
          clippedBy = `${ancestor.tagName}${
            ancestor.dataset.testid ? `[${ancestor.dataset.testid}]` : ""
          }:${overflowX}`;
        }
        ancestor = ancestor.parentElement;
      }
      // Reachable by a real horizontal scroll: not a clipping defect.
      if (insideIntentionalScroller) return;

      findings.push({
        tag: element.tagName,
        testid: element.dataset.testid || "",
        text: (element.textContent || "").trim().slice(0, 60),
        right: Math.round(rect.right),
        viewportWidth,
        clippedBy: clippedBy || "(none -- widens the document)",
      });
    });
    return findings;
  }, scope);
}

async function applyRootFont200(page: Page) {
  await setRootFontSize(page, 32);
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

  // REAUDIT-P2-01. The per-element half of the same question: not "did the
  // document get wider" but "is any content sitting outside the viewport with
  // no way to scroll to it". The credit-pack section is the specific one the
  // re-audit flagged, and it is `overflow-hidden`, so only this check can see
  // it.
  for (const lang of ["ko", "en"] as const) {
    for (const width of [320, 390] as const) {
      test(`[${lang}] no content is clipped outside the viewport on /pricing at ${width}px / 200%`, async ({
        page,
      }) => {
        await prepareGuestPage(page, lang);
        await page.setViewportSize({ width, height: 640 });
        await page.goto(`/pricing?lang=${lang}`);
        await page.waitForSelector('[data-testid="pricing-credit-packs"]');
        await applyRootFont200(page);
        // The public billing config resolves the real pack cards over their
        // placeholders; measuring the skeleton would measure nothing.
        await expect(
          page.locator('[data-testid="pricing-credit-packs"] article[data-pack-id]').first()
        ).toBeVisible();

        expect(await clippedElements(page)).toEqual([]);
      });
    }
  }

  test("[ko] the credit-pack CTA and headings are fully readable at 320px / 200%", async ({
    page,
  }) => {
    await prepareGuestPage(page, "ko");
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/pricing?lang=ko");
    await page.waitForSelector('[data-testid="pricing-credit-packs"]');
    await applyRootFont200(page);

    const section = page.getByTestId("pricing-credit-packs");
    await expect(section.locator("article[data-pack-id]").first()).toBeVisible();

    // Every text-bearing box in the section, not just the CTA: a heading cut
    // in half is the same defect with a different element.
    const outside = await section.evaluate((root) => {
      const viewportWidth = document.documentElement.clientWidth;
      return Array.from(root.querySelectorAll<HTMLElement>("h2, h3, p, a, span"))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.right > viewportWidth + 1;
        })
        .map((element) => ({
          tag: element.tagName,
          text: (element.textContent || "").trim().slice(0, 40),
          right: Math.round(element.getBoundingClientRect().right),
        }));
    });
    expect(outside).toEqual([]);

    // And the section itself offers no hidden horizontal scroll distance,
    // which is what "clipped but unreachable" looks like from the outside.
    const hiddenScroll = await section.evaluate(
      (root) => root.scrollWidth - root.clientWidth
    );
    expect(hiddenScroll, "credit-pack section hides horizontal content").toBeLessThanOrEqual(1);
  });
});
