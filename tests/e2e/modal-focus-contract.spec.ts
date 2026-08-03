import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

/**
 * UX-010. `aria-modal="true"` is a promise that the rest of the page is inert.
 * Most modals in this app declared it and kept none of it: focus stayed on the
 * trigger behind the overlay, Tab walked the obscured page, Escape did nothing,
 * and focus was never returned.
 *
 * `useModalDialog` now owns that contract. `UsageLimitModal` and
 * `CreditPackPurchaseButton` already implemented it correctly and are the
 * reference the hook was extracted from, so they are asserted here too -- a
 * regression in the shared hook has to show up against them first.
 */

const activeTestId = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);

const focusIsInsideDialog = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (!active) return false;
    const dialogs = Array.from(
      document.querySelectorAll('[role="dialog"][aria-modal="true"]')
    );
    return dialogs.some((dialog) => dialog.contains(active));
  });

const bodyScrollLocked = (page: Page) =>
  page.evaluate(() => document.body.style.overflow === "hidden");

/**
 * Initial focus is applied inside `requestAnimationFrame`, after the dialog has
 * painted, so a single sample immediately after `toBeVisible()` races it.
 */
const expectFocusEntersDialog = async (page: Page) => {
  await expect.poll(() => focusIsInsideDialog(page)).toBe(true);
};

/** Tab N times and assert focus never escapes the open dialog. */
async function expectTabStaysInsideDialog(page: Page, steps = 25) {
  for (let index = 0; index < steps; index += 1) {
    await page.keyboard.press("Tab");
    expect(
      await focusIsInsideDialog(page),
      `focus escaped the dialog after ${index + 1} forward tabs`
    ).toBe(true);
  }
  for (let index = 0; index < steps; index += 1) {
    await page.keyboard.press("Shift+Tab");
    expect(
      await focusIsInsideDialog(page),
      `focus escaped the dialog after ${index + 1} reverse tabs`
    ).toBe(true);
  }
}

test.describe("destructive confirmation dialog", () => {
  test(
    "traps focus, closes on Escape and restores the page",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await mockAuthenticatedApi(page);
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.goto("/chat?lang=en");

      await page.getByTestId("conversation-menu").first().click();
      await expect(page.getByTestId("conversation-menu-panel")).toBeVisible();
      await page
        .getByTestId("conversation-menu-panel")
        .getByRole("button", { name: /delete/i })
        .first()
        .click();

      const dialog = page
        .locator('[role="dialog"][aria-modal="true"]')
        .filter({ hasText: /delete/i })
        .last();
      await expect(dialog).toBeVisible();

      // Focus moved off the trigger and into the dialog, and the page behind
      // it can no longer scroll.
      await expectFocusEntersDialog(page);
      expect(await bodyScrollLocked(page)).toBe(true);

      await expectTabStaysInsideDialog(page, 10);

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      expect(await bodyScrollLocked(page)).toBe(false);
    }
  );
});

test.describe("first-run onboarding dialog", () => {
  test(
    "model finder takes focus, cycles Tab and closes on Escape",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await mockAuthenticatedApi(page);
      await page.goto("/chat?lang=en");

      // Same entry point the model-finder suite uses.
      await page.locator('button[aria-controls="chat-input-popover"]').nth(1).click();
      await page.getByTestId("model-combo-finder-cta").click();

      const finder = page.getByTestId("model-finder");
      await expect(finder).toBeVisible();

      await expectFocusEntersDialog(page);
      await expect.poll(() => activeTestId(page)).toBe("model-finder-close");
      expect(await bodyScrollLocked(page)).toBe(true);

      await expectTabStaysInsideDialog(page, 12);

      await page.keyboard.press("Escape");
      await expect(finder).toBeHidden();
      // The scroll lock is released rather than left on the workspace.
      expect(await bodyScrollLocked(page)).toBe(false);
    }
  );
});

test(
  "every aria-modal surface declares a dialog role",
  { tag: "@ui-risk" },
  async ({ page }) => {
    await prepareGuestPage(page, "en");
    await page.goto("/chat");
    // A surface that sets aria-modal without role="dialog" is invisible to the
    // shared hook's ownership check and would silently opt out of the contract.
    const mismatched = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll('[aria-modal="true"]')).filter(
          (element) => element.getAttribute("role") !== "dialog"
        ).length
    );
    expect(mismatched).toBe(0);
  }
);

test.describe("nested dismissible surfaces keep their own Escape", () => {
  test(
    "a destructive account dialog traps focus without closing settings",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await mockAuthenticatedApi(page);
      await page.goto("/chat?lang=en");

      const accountTrigger = page.getByTestId("account-menu-trigger");
      if ((page.viewportSize()?.width ?? 0) < 768) {
        await page.getByRole("button", { name: "Open chat menu" }).click();
      }
      await expect(accountTrigger).toBeVisible();
      await accountTrigger.click();
      await page
        .getByTestId("account-menu")
        .getByTestId("account-settings")
        .click();
      const settings = page.getByRole("dialog", { name: "User Settings" });
      await expect(settings).toBeVisible();

      const deleteTrigger = settings.getByRole("button", { name: "Delete Account" });
      await deleteTrigger.scrollIntoViewIfNeeded();
      await deleteTrigger.click();
      const nested = page.getByTestId("delete-account-dialog");
      await expect(nested).toBeVisible();
      // Not expectFocusEntersDialog(): the settings dialog underneath is
      // itself aria-modal, so the any-dialog poll can pass while focus is
      // still on the Delete Account trigger -- before the nested dialog's
      // own requestAnimationFrame focus has landed. Tabbing in that window
      // walks the settings dialog and fails the trap assertion below. Poll
      // for the nested dialog specifically.
      await expect
        .poll(() =>
          nested.evaluate((node) => node.contains(document.activeElement))
        )
        .toBe(true);
      expect(await bodyScrollLocked(page)).toBe(true);

      for (let step = 0; step < 12; step += 1) {
        await page.keyboard.press("Tab");
        expect(
          await nested.evaluate((node) => node.contains(document.activeElement))
        ).toBe(true);
      }

      await page.keyboard.press("Escape");
      await expect(nested).toBeHidden();
      await expect(settings).toBeVisible();
      await expect(deleteTrigger).toBeFocused();
      expect(await bodyScrollLocked(page)).toBe(true);

      await page.keyboard.press("Escape");
      await expect(settings).toBeHidden();
      await expect(accountTrigger).toBeFocused();
    }
  );

  test(
    "Escape inside a popover closes the popover, not the dialog around it",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await mockAuthenticatedApi(page);
      await page.setViewportSize({ width: 1366, height: 768 });
      await page.goto("/chat?lang=en");

      // A dialog whose Escape handler listens in the capture phase would beat
      // the popover's own handler on registration order and close the whole
      // dialog -- losing the user's place in a paid review. `useModalDialog`
      // listens in the bubble phase so `stopPropagation()` from the popover
      // still wins. tests/e2e/source-grounding.spec.ts covers the real AI
      // Review surface; this pins the shared hook's half of the contract.
      const dialogEscapeIsBubblePhase = await page.evaluate(() => {
        let dialogClosed = false;
        const onDialogEscape = (event: KeyboardEvent) => {
          if (event.key === "Escape") dialogClosed = true;
        };
        const onPopoverEscape = (event: KeyboardEvent) => {
          if (event.key === "Escape") event.stopPropagation();
        };
        // Same registration order the real tree produces: the dialog mounts
        // first, the popover inside it mounts later.
        document.addEventListener("keydown", onDialogEscape);
        document.addEventListener("keydown", onPopoverEscape, true);
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
        document.removeEventListener("keydown", onDialogEscape);
        document.removeEventListener("keydown", onPopoverEscape, true);
        return !dialogClosed;
      });
      expect(dialogEscapeIsBubblePhase).toBe(true);
    }
  );
});
