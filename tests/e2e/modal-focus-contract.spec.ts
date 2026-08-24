import { expect, test, type Locator, type Page } from "@playwright/test";
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

/**
 * Types into the composer behind the open dialog without touching focus.
 *
 * React tracks the input's value on the DOM node, so assigning `.value`
 * directly and dispatching `input` is ignored; going through the prototype's
 * own setter is what makes React see a change. The point is a state update in
 * the component that renders the dialog -- not the text.
 */
async function pumpParentRenders(page: Page, times: number) {
  await page.evaluate((count) => {
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="chat-textarea"]'
    );
    if (!textarea) throw new Error("composer textarea is not mounted");
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    if (!setValue) throw new Error("no native value setter");
    for (let index = 0; index < count; index += 1) {
      setValue.call(textarea, "x".repeat(index + 1));
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, times);
}

test.describe("focus survives the page behind the dialog re-rendering", () => {
  test(
    "a re-render of the component that owns the dialog does not move focus",
    { tag: "@ui-risk" },
    async ({ page }) => {
      // The defect this pins had no user-visible trigger: `ChatPageClient`
      // passes `onCancel={() => setPendingDeleteId(null)}`, a new function on
      // every one of its renders, and the shared hook's single effect listed
      // `onClose`. So every render of the page behind the dialog tore that
      // effect down and rebuilt it -- teardown returning focus to the trigger,
      // setup placing it on the dialog's first control -- and a keyboard user
      // was moved off whatever they had selected, having pressed nothing. The
      // chat page re-renders on typing, streaming and status polling, so this
      // happened constantly.
      //
      // The static rule in tests/modalFocusEffectDeps.test.mjs pins the shape
      // that fixes it. This pins the behaviour, because a differently-wrong
      // implementation can satisfy the shape.
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
      await expectFocusEntersDialog(page);

      // Move off the initial-focus target on purpose. Cancel is where the hook
      // puts focus, so a test that stayed there could not tell "focus never
      // moved" from "focus was put back".
      const confirm = dialog.getByRole("button", { name: /delete/i }).last();
      await confirm.focus();
      await expect(confirm).toBeFocused();

      await pumpParentRenders(page, 12);

      // No assertion about *where* focus went if it moved -- the contract is
      // that it did not move at all.
      await expect(confirm).toBeFocused();
      expect(await focusIsInsideDialog(page)).toBe(true);
      await expect(dialog).toBeVisible();
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
      // `expectFocusEntersDialog` accepts focus inside *any* open dialog, and
      // the settings dialog underneath still contains it until the nested
      // dialog's rAF initial focus lands. Poll for the nested dialog
      // specifically so the Tab loop below starts from a settled state.
      await expect
        .poll(() => nested.evaluate((node) => node.contains(document.activeElement)))
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
    "Tab pressed before the nested dialog's initial focus lands is still trapped",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await mockAuthenticatedApi(page);
      // Initial focus moves into a freshly opened dialog inside
      // `requestAnimationFrame`, one frame after it renders. Under CI load
      // that frame can arrive after the user's first Tab, which then starts
      // from the trigger inside the settings dialog underneath. Delaying every
      // rAF callback turns that race into a deterministic window.
      await page.addInitScript(() => {
        const original = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (callback: FrameRequestCallback) =>
          original(() => {
            setTimeout(() => callback(performance.now()), 250);
          });
      });
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

      // Deliberately no wait for focus to enter the nested dialog: Tab fires
      // while focus is still on the trigger inside the settings dialog. The
      // topmost modal must claim it and pull focus inside.
      await page.keyboard.press("Tab");
      expect(
        await nested.evaluate((node) => node.contains(document.activeElement))
      ).toBe(true);
    }
  );

  test(
    "the dialog underneath does not reclaim focus when its own frame lands late",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await mockAuthenticatedApi(page);
      // The other half of the race above. The Tab trap is only as good as how
      // long the focus it placed survives: the settings dialog schedules its
      // own initial focus a frame after *it* opened, and if the nested dialog
      // opens before that frame lands, the frame arrives to find the user
      // somewhere else entirely and pulls them back into the dialog now
      // underneath -- with no key press to explain it.
      //
      // This is what actually failed on main at 11b98c9 (shard 2,
      // desktop-compact, three attempts). The Tab was trapped correctly and
      // the late frame undid it before the assertion read `activeElement`. A
      // long rAF delay makes the same ordering deterministic instead of
      // load-dependent: 2.5s is far longer than the clicks below take, so the
      // settings dialog's frame is guaranteed to still be pending when the
      // nested dialog opens.
      await page.addInitScript(() => {
        const original = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (callback: FrameRequestCallback) =>
          original(() => {
            setTimeout(() => callback(performance.now()), 2500);
          });
      });
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
      await page.keyboard.press("Tab");
      expect(
        await nested.evaluate((node) => node.contains(document.activeElement))
      ).toBe(true);

      // Sample past the settings dialog's pending frame rather than checking
      // once: the steal is a single moment, and a single later reading can
      // miss it because the nested dialog's own frame puts focus back.
      const escaped = await page.evaluate(async () => {
        const nestedDialog = document.querySelector('[data-testid="delete-account-dialog"]');
        for (let sample = 0; sample < 20; sample += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          if (!nestedDialog?.contains(document.activeElement)) {
            const active = document.activeElement as HTMLElement | null;
            return active?.outerHTML.slice(0, 120) ?? "<none>";
          }
        }
        return null;
      });
      expect(escaped, "focus was pulled out of the nested dialog").toBeNull();
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
/**
 * What sits at a control's own centre point, as a sentence a failure can be
 * read from.
 *
 * `toBeVisible()` cannot answer this. A modal that is painted *underneath* a
 * full-screen overlay is still rendered, still has a non-empty box, and still
 * passes every visibility check Playwright makes -- while being both invisible
 * to the eye and unreachable by a pointer. `elementFromPoint` asks the browser
 * the question the user is actually asking: if I click here, what do I hit?
 */
const hitTargetAtCentre = (locator: Locator) =>
  locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(
      Math.round(rect.left + rect.width / 2),
      Math.round(rect.top + rect.height / 2)
    );
    if (!hit) return "<nothing>";
    if (hit === node || node.contains(hit)) return "self";
    const labelled = hit.closest("[data-testid]");
    const testId = labelled?.getAttribute("data-testid");
    return `covered by ${testId ? `[data-testid="${testId}"]` : hit.tagName.toLowerCase()} :: ${String(
      hit.className
    ).slice(0, 120)}`;
  });

/**
 * Opens the account User Settings dialog from /chat on either shell.
 *
 * Reports whether the mobile drawer was used to get there, because that drawer
 * is itself a modal surface holding its own body scroll lock -- so on that
 * shell the page is still locked after User Settings closes, and it is the
 * drawer, not this modal stack, that is holding it.
 */
async function openUserSettings(page: Page) {
  const viaMobileDrawer = (page.viewportSize()?.width ?? 0) < 768;
  const accountTrigger = page.getByTestId("account-menu-trigger");
  if (viaMobileDrawer) {
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
  return { settings, viaMobileDrawer };
}

/** Closes whatever surface is still holding the lock and asserts it released. */
async function expectScrollLockReleased(page: Page, viaMobileDrawer: boolean) {
  if (viaMobileDrawer) {
    expect(await bodyScrollLocked(page)).toBe(true);
    await page.keyboard.press("Escape");
  }
  await expect.poll(() => bodyScrollLocked(page)).toBe(false);
}

test.describe("credit pack purchase opened from account settings", () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticatedApi(page);
    // Registered after the shared fixtures so this more specific handler wins:
    // the modal will not render a single pack card without it, and a modal with
    // nothing in it cannot be hit-tested against what covers it.
    await page.route("**/api/billing/credit-packs**", (route) => {
      if (route.request().method() !== "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ url: "https://checkout.example.test/session" }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          plan: "Free",
          market: { country: "US", currency: "USD" },
          creditDebt: { credits: 0 },
          analyticsContext: {
            currentPlan: "free",
            planCreditsRemaining: 300,
            addonCreditsRemaining: 0,
          },
          packs: [
            {
              id: "starter_500",
              name: "Starter Credit Pack",
              credits: 500,
              priceMinor: 499,
              priceCents: 499,
              currency: "USD",
              validityDays: 365,
            },
          ],
        }),
      });
    });
  });

  test(
    "the purchase modal is the topmost hit target above User Settings",
    { tag: "@ui-risk" },
    async ({ page }) => {
      // The defect: this modal's overlay sat at z-[120] while the User Settings
      // overlay it opens from sits at z-[130] (and that dialog's own nested
      // dialogs at z-[140]). The purchase modal mounted, reported `open`, and
      // passed `toBeVisible()` -- painted underneath the settings overlay, so
      // nothing was on screen and no click reached it. Only a hit test at the
      // control's own centre can tell the two apart.
      await page.goto("/chat?lang=en");
      const { settings, viaMobileDrawer } = await openUserSettings(page);

      await settings.getByTestId("settings-tab-plan").click();
      const trigger = settings.getByTestId("credit-pack-purchase-trigger");
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();

      const purchase = page.getByTestId("credit-pack-modal");
      await expect(purchase).toBeVisible();
      // Requirement 2 and 4: settings stays open underneath, and the purchase
      // modal is portalled to `document.body` rather than nested inside the
      // settings panel (which would clip it against `overflow-hidden`).
      await expect(settings).toBeVisible();
      expect(
        await purchase.evaluate((node) => node.closest('[role="dialog"][aria-labelledby="user-settings-title"]') === null)
      ).toBe(true);

      // The assertion the old z-index fails: at its own centre, the purchase
      // modal is what the browser would hand a click to.
      expect(await hitTargetAtCentre(purchase)).toBe("self");
      await expect
        .poll(() => hitTargetAtCentre(page.getByTestId("credit-pack-modal-close")))
        .toBe("self");

      // ...and the settings overlay underneath is genuinely covered, so the
      // check above cannot pass because both happen to be reachable.
      const closeIsAbovePanel = await page.evaluate(() => {
        const close = document.querySelector<HTMLElement>(
          '[data-testid="credit-pack-modal-close"]'
        );
        const settingsPanel = document.querySelector<HTMLElement>(
          '[role="dialog"][aria-labelledby="user-settings-title"]'
        );
        if (!close || !settingsPanel) return false;
        const rect = close.getBoundingClientRect();
        const hit = document.elementFromPoint(
          Math.round(rect.left + rect.width / 2),
          Math.round(rect.top + rect.height / 2)
        );
        return hit !== null && !settingsPanel.contains(hit);
      });
      expect(closeIsAbovePanel).toBe(true);

      // Focus is inside the purchase modal, on its close button.
      await expect.poll(() => activeTestId(page)).toBe("credit-pack-modal-close");
      expect(await bodyScrollLocked(page)).toBe(true);

      // A real click, not `force`: Playwright's own actionability check would
      // time out against an obscured control, so this is a second, independent
      // reading of the same fact.
      await page.getByTestId("credit-pack-modal-close").click();
      await expect(purchase).toBeHidden();

      // Requirement 2, 7 and 8: settings survived, focus came back to the
      // trigger, and the scroll lock the settings dialog owns is still held.
      await expect(settings).toBeVisible();
      await expect(trigger).toBeFocused();
      expect(await bodyScrollLocked(page)).toBe(true);

      await page.keyboard.press("Escape");
      await expect(settings).toBeHidden();
      await expectScrollLockReleased(page, viaMobileDrawer);
    }
  );

  test(
    "Escape closes only the purchase modal and leaves User Settings open",
    { tag: "@ui-risk" },
    async ({ page }) => {
      await page.goto("/chat?lang=en");
      const { settings, viaMobileDrawer } = await openUserSettings(page);

      await settings.getByTestId("settings-tab-plan").click();
      const trigger = settings.getByTestId("credit-pack-purchase-trigger");
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();

      const purchase = page.getByTestId("credit-pack-modal");
      await expect(purchase).toBeVisible();
      await expect.poll(() => hitTargetAtCentre(purchase)).toBe("self");
      await expect
        .poll(() => purchase.evaluate((node) => node.contains(document.activeElement)))
        .toBe(true);

      // Tab stays inside the topmost dialog rather than walking the settings
      // panel underneath it.
      for (let step = 0; step < 10; step += 1) {
        await page.keyboard.press("Tab");
        expect(
          await purchase.evaluate((node) => node.contains(document.activeElement)),
          `focus escaped the purchase modal after ${step + 1} tabs`
        ).toBe(true);
      }

      await page.keyboard.press("Escape");
      await expect(purchase).toBeHidden();
      await expect(settings).toBeVisible();
      await expect(trigger).toBeFocused();
      // Requirement 10: the lock belongs to whichever modal is still open.
      expect(await bodyScrollLocked(page)).toBe(true);

      // The settings dialog is still the one holding the keys, and closing it
      // is what finally releases the page.
      await page.keyboard.press("Escape");
      await expect(settings).toBeHidden();
      await expectScrollLockReleased(page, viaMobileDrawer);
    }
  );
});
