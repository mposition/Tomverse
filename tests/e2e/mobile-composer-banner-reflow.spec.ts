import { expect, test, type Page } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { openOnScreenKeyboard, closeOnScreenKeyboard } from "./support/ui-audit";

/**
 * REAUDIT-P1-04. The mobile shell was `h-[100dvh] overflow-hidden`: a box that
 * could not grow and could not scroll. Everything below the fold was therefore
 * not merely off-screen but unreachable -- there was no scroll owner to reach
 * it with. Measured on the build before this spec, at 320x568 with a provider
 * outage banner and Korean copy:
 *
 * | root | textarea top | send top | reachable |
 * |---:|---:|---:|---|
 * | 16px | 442 | 486 | yes |
 * | 24px | 593 | 659 | no  |
 * | 32px | 1012 | 1100 | no |
 *
 * `document.elementFromPoint` returned `null` at both centres in the failing
 * rows while `documentElement.scrollWidth - clientWidth` stayed at 0, which is
 * exactly why a document-level overflow check could never have caught this.
 * The assertions below are per-element rects and hit-tests for that reason.
 *
 * The matrix is 4 viewports x 2 locales x 2 banner states x 4 root font sizes
 * = 64 cells. Each cell asserts the composer is genuinely operable, not merely
 * attached.
 */

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 320, height: 640 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
] as const;

const LOCALES = ["ko", "en"] as const;
const ROOT_FONT_SIZES = [16, 20, 24, 32] as const;

// These cells measure the banner in its *tallest realistic* shape for a guest:
// an outage on a selected model, with a replacement the guest can actually
// take. The replacement has to be guest-selectable -- it was mistral-medium-3-1
// (Free tier) until the banner started filtering candidates by entitlement, at
// which point this snapshot silently collapsed into the no-replacement state
// and stopped measuring the swap button at all.
const OUTAGE_SNAPSHOT = {
  generatedAt: "2099-01-01T00:00:00.000Z",
  models: [
    {
      id: "gemini-2-5-flash",
      provider: "google",
      status: "unavailable",
      fallbackModelIds: ["deepseek-v4-flash"],
      fallbackHealth: "operational",
    },
    {
      id: "deepseek-v4-flash",
      provider: "deepseek",
      status: "available",
      fallbackModelIds: [],
      fallbackHealth: "none",
    },
  ],
};

const HEALTHY_SNAPSHOT = { generatedAt: "2099-01-01T00:00:00.000Z", models: [] };

async function mockStatus(page: Page, withBanner: boolean) {
  await page.route("**/api/models/status**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(withBanner ? OUTAGE_SNAPSHOT : HEALTHY_SNAPSHOT),
    })
  );
}

async function setRootFont(page: Page, size: number) {
  await page.evaluate((value) => {
    document.documentElement.style.fontSize = `${value}px`;
  }, size);
  // Two frames: one for the style, one for the auto-growing textarea and the
  // shell's flex distribution to settle against it.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

type CellReport = {
  textareaHit: string;
  sendHit: string;
  sendEnabled: boolean;
  textareaLines: number;
  textareaWidthRatio: number;
  disclaimerIntersection: number;
  bannerIntersection: number;
  scrollOwners: string[];
  documentHorizontalOverflow: number;
  widestElementOverhang: number;
};

/**
 * Everything the cell is judged on, read in one evaluate so the numbers all
 * describe the same frame. `scrollIntoViewIfNeeded` runs first, because a
 * control that needs one scroll to reach is allowed -- a control that no
 * amount of scrolling reaches is not.
 */
async function scrollIntoVisibleViewport(page: Page, testId: string) {
  await page.getByTestId(testId).scrollIntoViewIfNeeded().catch(() => {});
  // `scrollIntoViewIfNeeded` reasons about the *layout* viewport, so with a
  // raised keyboard it stops as soon as the element is nominally on the page.
  // One further scroll of the element's own scroll owner is what the user
  // actually does, and it is still one scroll.
  await page.evaluate((id) => {
    const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (!element) return;
    const visibleHeight = window.visualViewport?.height ?? window.innerHeight;
    const rect = element.getBoundingClientRect();
    const overshoot = rect.bottom - visibleHeight;
    if (overshoot <= 0) return;
    let ancestor: HTMLElement | null = element.parentElement;
    while (ancestor) {
      const style = getComputedStyle(ancestor);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        ancestor.scrollHeight - ancestor.clientHeight > 1
      ) {
        ancestor.scrollTop = Math.min(
          ancestor.scrollTop + overshoot + 8,
          ancestor.scrollHeight - ancestor.clientHeight
        );
        return;
      }
      ancestor = ancestor.parentElement;
    }
  }, testId);
}

async function readCell(page: Page): Promise<CellReport> {
  // Each control is judged after being scrolled to in its own right. The
  // requirement is that every control is reachable, not that they all fit on
  // screen together -- at 200% text with a full-height outage banner on a
  // 568px phone, nothing could satisfy the latter.
  await scrollIntoVisibleViewport(page, "chat-textarea");
  const textareaHit = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="chat-textarea"]');
    if (!element) return "missing";
    const rect = element.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const visibleHeight = window.visualViewport?.height ?? window.innerHeight;
    if (y < 0 || y > visibleHeight || x < 0 || x > window.innerWidth) {
      return "outside-visible-viewport";
    }
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!hit) return "null";
    if (hit === element || element.contains(hit)) return "self";
    return hit.dataset.testid || hit.tagName;
  });

  await scrollIntoVisibleViewport(page, "chat-send-button");
  const report = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>('[data-testid="mobile-chat-shell"]')!;
    const textarea = document.querySelector<HTMLElement>('[data-testid="chat-textarea"]');
    const send = document.querySelector<HTMLElement>('[data-testid="chat-send-button"]');
    const composer = document.querySelector<HTMLElement>('[data-testid="chat-input"]');
    const row = document.querySelector<HTMLElement>('[data-testid="composer-textarea-row"]');
    const disclaimer = document.querySelector<HTMLElement>(
      '[data-testid="chat-ai-disclaimer-mobile"]'
    );
    const banner = document.querySelector<HTMLElement>('[data-testid="provider-outage-banner"]');

    const hitAt = (element: HTMLElement | null) => {
      if (!element) return "missing";
      const rect = element.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      // The *visible* viewport, not the layout one: a control under a raised
      // on-screen keyboard still has a hit-testable layout position, and
      // calling that "reachable" is the mistake this spec exists to catch.
      const visibleHeight = window.visualViewport?.height ?? window.innerHeight;
      if (y < 0 || y > visibleHeight || x < 0 || x > window.innerWidth) {
        return "outside-visible-viewport";
      }
      const hit = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!hit) return "null";
      if (hit === element || element.contains(hit)) return "self";
      return hit.dataset.testid || hit.tagName;
    };

    // The part of an element that is actually painted: its own box clipped by
    // every scrolling/clipping ancestor. A control scrolled out of its own
    // region is not "over" anything, and treating its raw rect as if it were
    // would flag overlaps that no user can see.
    const paintedRect = (element: HTMLElement) => {
      let box = element.getBoundingClientRect();
      let top = box.top;
      let bottom = box.bottom;
      let left = box.left;
      let right = box.right;
      let ancestor: HTMLElement | null = element.parentElement;
      while (ancestor) {
        const style = getComputedStyle(ancestor);
        if (style.overflow !== "visible" || style.overflowY !== "visible" || style.overflowX !== "visible") {
          box = ancestor.getBoundingClientRect();
          if (style.overflowY !== "visible") {
            top = Math.max(top, box.top);
            bottom = Math.min(bottom, box.bottom);
          }
          if (style.overflowX !== "visible") {
            left = Math.max(left, box.left);
            right = Math.min(right, box.right);
          }
        }
        ancestor = ancestor.parentElement;
      }
      return { top, bottom, left, right };
    };

    const area = (a: HTMLElement | null, b: HTMLElement | null) => {
      if (!a || !b) return 0;
      const ra = paintedRect(a);
      const rb = paintedRect(b);
      const w = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
      const h = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
      return Math.round(w * h);
    };

    // "Reachable through exactly one scroll owner" is about the scrolls the
    // user actually has to perform, so this counts the ancestors that were
    // genuinely moved to bring the composer into view (readCell scrolls first).
    // A scroller that exists but stayed at the top was not part of the path.
    const scrollOwners: string[] = [];
    if (composer) {
      let ancestor: HTMLElement | null = composer.parentElement;
      while (ancestor) {
        const style = getComputedStyle(ancestor);
        const scrollable =
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          ancestor.scrollHeight - ancestor.clientHeight > 1;
        if (scrollable && ancestor.scrollTop > 0) {
          scrollOwners.push(ancestor.dataset.testid || ancestor.tagName.toLowerCase());
        }
        ancestor = ancestor.parentElement;
      }
      if (document.documentElement.scrollTop > 0) {
        // The page behind the shell should never be the path to the composer.
        scrollOwners.push("document");
      }
    }

    // Per-element horizontal overhang inside the shell, so the shell's own
    // `overflow-x: hidden` cannot make a sideways overflow look like zero.
    let widestElementOverhang = 0;
    shell.querySelectorAll<HTMLElement>("*").forEach((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      let ancestor: HTMLElement | null = element.parentElement;
      while (ancestor && ancestor !== shell) {
        const overflowX = getComputedStyle(ancestor).overflowX;
        // An element inside a declared horizontal scroller is allowed to be
        // wider than the viewport; that is what the scroller is for.
        if (overflowX === "auto" || overflowX === "scroll") return;
        ancestor = ancestor.parentElement;
      }
      widestElementOverhang = Math.max(
        widestElementOverhang,
        Math.round(rect.right - window.innerWidth)
      );
    });

    const lineHeight = textarea
      ? parseFloat(getComputedStyle(textarea).lineHeight) || 0
      : 0;
    const textareaRect = textarea?.getBoundingClientRect();
    const rowRect = row?.getBoundingClientRect();

    return {
      textareaHit: "unused",
      sendHit: hitAt(send),
      sendEnabled: send ? !(send as HTMLButtonElement).disabled : false,
      textareaLines:
        textareaRect && lineHeight > 0 ? textareaRect.height / lineHeight : 0,
      textareaWidthRatio:
        textareaRect && rowRect && rowRect.width > 0
          ? textareaRect.width / rowRect.width
          : 0,
      disclaimerIntersection: area(disclaimer, composer),
      bannerIntersection: area(banner, composer),
      scrollOwners,
      documentHorizontalOverflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      widestElementOverhang,
    };
  });
  return { ...report, textareaHit };
}

function assertCell(report: CellReport, label: string) {
  expect(report.textareaHit, `${label}: textarea centre hit-test`).toBe("self");
  expect(report.sendEnabled, `${label}: send is enabled with a draft`).toBe(true);
  expect(report.sendHit, `${label}: send centre hit-test after one scroll`).toBe("self");
  expect(report.textareaLines, `${label}: textarea shows a full line`).toBeGreaterThanOrEqual(
    0.95
  );
  expect(
    report.textareaWidthRatio,
    `${label}: textarea owns its row`
  ).toBeGreaterThanOrEqual(0.9);
  expect(
    report.disclaimerIntersection,
    `${label}: disclaimer over composer`
  ).toBe(0);
  expect(report.bannerIntersection, `${label}: banner over composer`).toBe(0);
  // None is the ideal (already on screen); one is allowed; two would mean the
  // user has to work out which surface to drag.
  expect(
    report.scrollOwners.length,
    `${label}: the composer must be reachable through at most one scroll owner (saw ${
      report.scrollOwners.join(", ") || "none"
    })`
  ).toBeLessThanOrEqual(1);
  expect(
    report.scrollOwners.includes("document"),
    `${label}: the page behind the shell must not be the path to the composer`
  ).toBe(false);
  expect(
    report.documentHorizontalOverflow,
    `${label}: document horizontal overflow`
  ).toBeLessThanOrEqual(1);
  expect(
    report.widestElementOverhang,
    `${label}: element wider than the viewport inside the shell`
  ).toBeLessThanOrEqual(1);
}

test.describe("mobile composer stays operable with a provider banner at every text size", () => {
  test.use({ hasTouch: true });

  // Playwright requires the first argument to be an object destructuring
  // pattern, even when the hook only needs `testInfo`.
  test.beforeEach(async ({}, testInfo) => {
    test.skip(
      testInfo.project.name.includes("safari"),
      "The matrix pins explicit viewports and runs on one engine."
    );
  });

  for (const viewport of VIEWPORTS) {
    for (const withBanner of [true, false]) {
      test(
        `${viewport.width}x${viewport.height}, provider banner ${
          withBanner ? "present" : "absent"
        }`,
        { tag: "@ui-risk" },
        async ({ page }) => {
          test.setTimeout(180_000);
          for (const lang of LOCALES) {
            await prepareGuestPage(page, lang);
            await mockStatus(page, withBanner);
            await page.addInitScript(() => {
              window.localStorage.setItem("tomverse_guest_quick_start_seen_v2", "1");
              window.localStorage.setItem("tomverse_analytics_consent_v1", "accepted");
            });
            await page.setViewportSize(viewport);
            await page.goto(`/chat?lang=${lang}`);
            await expect(page.getByTestId("mobile-chat-shell")).toBeVisible();
            await expect(page.getByTestId("chat-textarea")).toBeVisible();
            if (withBanner) {
              await expect(page.getByTestId("provider-outage-banner")).toBeVisible();
            } else {
              await expect(page.getByTestId("provider-outage-banner")).toHaveCount(0);
            }
            // A draft, so "send" is the real enabled control rather than the
            // disabled placeholder an empty composer shows.
            await page.getByTestId("chat-textarea").fill("가용성 회귀 확인");

            for (const rootFont of ROOT_FONT_SIZES) {
              await setRootFont(page, rootFont);
              const label = `${viewport.width}x${viewport.height} ${lang} banner=${withBanner} root=${rootFont}px`;
              assertCell(await readCell(page), label);
            }
            await setRootFont(page, 16);
          }
        }
      );
    }
  }
});

test.describe("mobile composer reachability under IME, keyboard and safe areas", () => {
  test.use({ hasTouch: true });

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name.includes("safari"),
      "The matrix pins explicit viewports and runs on one engine."
    );
    await prepareGuestPage(page, "ko");
    await mockStatus(page, true);
    await page.addInitScript(() => {
      window.localStorage.setItem("tomverse_guest_quick_start_seen_v2", "1");
      window.localStorage.setItem("tomverse_analytics_consent_v1", "accepted");
    });
  });

  test(
    "Korean composition stays visible at 200% text with an outage banner",
    { tag: "@ui-risk" },
    async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 320, height: 568 });
      await page.goto("/chat?lang=ko");
      await expect(page.getByTestId("provider-outage-banner")).toBeVisible();
      await setRootFont(page, 32);

      const textarea = page.getByTestId("chat-textarea");
      await scrollIntoVisibleViewport(page, "chat-textarea");
      await textarea.click();

      // A real composition, not a paste: the caret and the in-flight syllable
      // both have to stay inside the visible box.
      await page.keyboard.insertText("안녕하세");
      await textarea.evaluate((element) => {
        element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        element.dispatchEvent(
          new CompositionEvent("compositionupdate", { bubbles: true, data: "요" })
        );
      });

      await scrollIntoVisibleViewport(page, "chat-textarea");
      const composing = await readCell(page);
      expect(composing.textareaHit, "textarea reachable mid-composition").toBe("self");
      const overflow = await textarea.evaluate((element) => {
        const field = element as HTMLTextAreaElement;
        return {
          vertical: field.scrollHeight - field.clientHeight,
          horizontal: field.scrollLeft,
        };
      });
      expect(overflow.horizontal, "no horizontal scroll inside the textarea").toBe(0);
      expect(overflow.vertical, "composition text stays in the visible box").toBeLessThanOrEqual(1);

      await textarea.evaluate((element) =>
        element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))
      );
    }
  );

  test(
    "an open on-screen keyboard leaves the input and send reachable at 200% text",
    { tag: "@ui-risk" },
    async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/chat?lang=ko");
      await expect(page.getByTestId("chat-textarea")).toBeVisible();
      await setRootFont(page, 32);
      await page.getByTestId("chat-textarea").fill("키보드 회귀 확인");

      await openOnScreenKeyboard(page, 320);
      const withKeyboard = await readCell(page);
      expect(withKeyboard.textareaHit, "textarea with the keyboard up").toBe("self");
      expect(withKeyboard.sendHit, "send with the keyboard up").toBe("self");
      expect(
        withKeyboard.scrollOwners.length,
        `one scroll owner with the keyboard up (saw ${withKeyboard.scrollOwners.join(", ")})`
      ).toBeLessThanOrEqual(1);

      await closeOnScreenKeyboard(page);
    }
  );

  test(
    "safe-area insets do not push the composer under the home indicator",
    { tag: "@ui-risk" },
    async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/chat?lang=ko");
      await expect(page.getByTestId("chat-textarea")).toBeVisible();
      // env() cannot be forced from a test, so the fixture reproduces what the
      // inset buys: 34px of reserved space below the composer's own padding.
      await page.addStyleTag({
        content: `[data-testid="chat-ai-disclaimer-mobile"]{padding-bottom:calc(0.4rem + 34px)}`,
      });
      await setRootFont(page, 32);
      await page.getByTestId("chat-textarea").fill("세이프 에어리어 확인");

      const report = await readCell(page);
      expect(report.sendHit, "send above the home indicator").toBe("self");
      expect(report.textareaHit, "textarea above the home indicator").toBe("self");

      expect(
        report.disclaimerIntersection,
        "the disclaimer sits below the composer, not over it"
      ).toBe(0);
    }
  );
});
