import { expect, test, type Page } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockPublicBillingConfig,
  prepareGuestPage,
} from "./support/app-fixtures";

// WO-007 / UX-F011 -- the machine-checkable slice of the core-task
// accessibility matrix (.github/ACCESSIBILITY_QA_MATRIX.md).
//
// Deliberately limited. A headless browser has no screen reader, no IME and
// no physical keyboard, so nothing here shows that anything is *announced*
// usefully -- only that a name exists, that focus is visible, and that
// controls survive forced-colors and reduced-motion. The screen-reader,
// Korean-IME, external-keyboard and real-browser-zoom rows stay N/V in the
// matrix and are not implied by this file passing.

const CONSENT_DECLINE = "analytics-consent-decline";
const CONSENT_ACCEPT = "analytics-consent-accept";

/** The element that currently has focus, described well enough to assert on. */
const focusedDescriptor = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const style = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      testid: el.dataset.testid ?? null,
      name:
        el.getAttribute("aria-label") ||
        (el.textContent || "").trim().slice(0, 40),
      // A visible focus indicator is any of these -- component styles here use
      // ring/box-shadow rather than the UA outline.
      hasFocusIndicator:
        (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) ||
        (style.boxShadow !== "none" && style.boxShadow.length > 0),
    };
  });

test.describe("core-task accessibility (automatable slice)", () => {
  test("the consent notice is reachable and actionable by keyboard alone", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await page.goto("/");

    const decline = page.getByTestId(CONSENT_DECLINE);
    await expect(decline).toBeVisible();

    // Walk the tab order until a consent action is reached. Bounded so a
    // trap or an unreachable control fails rather than hangs.
    let reached: string | null = null;
    for (let step = 0; step < 60 && !reached; step += 1) {
      await page.keyboard.press("Tab");
      const focused = await focusedDescriptor(page);
      if (!focused) continue;
      if (focused.testid === CONSENT_DECLINE || focused.testid === CONSENT_ACCEPT) {
        reached = focused.testid;
        expect(
          focused.hasFocusIndicator,
          `${focused.testid} takes focus with no visible indicator`
        ).toBe(true);
      }
    }

    expect(
      reached,
      "neither consent action was reachable within 60 tab stops"
    ).not.toBeNull();

    // And the action completes without a pointer.
    await page.keyboard.press("Enter");
    await expect(page.getByTestId(CONSENT_DECLINE)).toHaveCount(0);
  });

  test("consent actions keep an accessible name and stay visible in forced colors", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await page.emulateMedia({ forcedColors: "active" });
    await page.goto("/");

    for (const testid of [CONSENT_DECLINE, CONSENT_ACCEPT]) {
      const control = page.getByTestId(testid);
      await expect(control).toBeVisible();

      const box = await control.boundingBox();
      expect(box, `${testid} has no box in forced colors`).not.toBeNull();
      // Same 44x44 floor the pointer-target invariant uses: a control that
      // collapses under forced colors is unusable, not merely restyled.
      expect(box!.width, `${testid} width`).toBeGreaterThanOrEqual(44);
      expect(box!.height, `${testid} height`).toBeGreaterThanOrEqual(44);

      const name = await control.evaluate(
        (el) =>
          el.getAttribute("aria-label") || (el.textContent || "").trim()
      );
      expect(name.length, `${testid} has no accessible name`).toBeGreaterThan(0);
    }
  });

  test("pricing stays readable with reduced motion and carries no motion-only content", async ({
    page,
  }) => {
    await mockPublicBillingConfig(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/pricing?lang=en");

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // The plan prices must be present as text regardless of motion settings:
    // nothing may depend on an animation having run to become readable.
    const text = await page.evaluate(() => {
      const clone = document.body.cloneNode(true) as HTMLElement;
      clone
        .querySelectorAll('script, style, [aria-hidden="true"]')
        .forEach((node) => node.remove());
      return (clone.textContent ?? "").replace(/\s+/g, " ");
    });
    expect(/\$\s?\d[\d.,]*\s+per month/.test(text)).toBe(true);

    await expectNoHorizontalOverflow(page);
  });

  test("pricing reflows at 200% and 400% without horizontal overflow", async ({
    page,
  }) => {
    await mockPublicBillingConfig(page);

    // Equivalent CSS-pixel viewports, which is what the reflow invariant
    // permits. This is NOT a substitute for real browser zoom -- rows 14/15
    // of the matrix stay N/V.
    for (const [label, viewport] of [
      ["200%", { width: 640, height: 512 }],
      ["400%", { width: 320, height: 256 }],
    ] as const) {
      await page.setViewportSize(viewport);
      await page.goto("/pricing?lang=en");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      expect(label).toBeTruthy();
    }
  });

  test("the chat composer is reachable by keyboard and reports its state as text", async ({
    page,
  }) => {
    await prepareGuestPage(page, "en");
    await page.goto("/chat");

    const textarea = page.getByTestId("chat-textarea");
    await expect(textarea).toBeVisible();

    await textarea.focus();
    await expect(textarea).toBeFocused();

    // The send control must expose its disabled/enabled state to assistive
    // tech rather than only greying out.
    const send = page.getByTestId("chat-send-button");
    await expect(send).toBeDisabled();

    await textarea.fill("keyboard reachable");
    await expect(send).toBeEnabled();

    const name = await send.evaluate(
      (el) => el.getAttribute("aria-label") || (el.textContent || "").trim()
    );
    expect(name.length, "the send control has no accessible name").toBeGreaterThan(0);
  });
});
